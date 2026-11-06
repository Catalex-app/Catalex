import { getPanelWindowSession } from "./panel-window-runtime";
import { invoke } from "./desktop/core";
import type { PdfSource } from "./mupdf/pdf-source";
import { isMarkdownFile } from "./markdown";
import { useDocumentStore, getPdfBytes } from "@/stores/document-store";
import { useHistoryStore } from "@/stores/history-store";
import { useSettingsStore } from "@/stores/settings-store";
import {
  compileLatex,
  recordPdfCompilation,
  compileErrorDiagnostics,
  detectTexEngineFromContent,
  formatCompileError,
  resolveCompileTarget,
  type CompileDiagnostic,
} from "./latex-compiler";

type State = ReturnType<typeof useDocumentStore.getState>;
export type CompileOptions = {
  force?: boolean;
  snapshot?: boolean;
  automatic?: boolean;
  fileId?: string;
};
type Options = CompileOptions;
export type Compilation = {
  readonly id: string;
  readonly projectDir: string;
  readonly projectRoot: string;
  readonly rootId: string;
  readonly fileId?: string;
  readonly inputs: string;
  cancelled: boolean;
  nativeStarted: boolean;
  readonly generation: number;
  readonly revision: number;
};
function mergeRequests(previous: Options | null, next: Options): Options {
  return {
    fileId: next.fileId,
    force: previous?.force || next.force,
    snapshot: previous?.snapshot || next.snapshot,
    // A manual request survives when automatic recompilation is disabled.
    automatic: previous
      ? previous.automatic === true && next.automatic === true
      : next.automatic,
  };
}

// Publication ownership is separate from the local compiler execution slot.
let active: Compilation | null = null;
let running: Compilation | null = null;
let queued: Options | null = null;
let revision = 0;
let workspaceRevision = 0;
let stopRevision = 0;
let stoppedAutomaticInputs: string | null = null;

function automaticInputs(state: State, fileId = state.activeFileId) {
  const settings = useSettingsStore.getState();
  const root = resolveCompileTarget(fileId, state.files)?.rootId;
  return JSON.stringify([
    context(state, fileId),
    state.contentGeneration,
    state.files.map((file) => file.relativePath),
    state.projectRoot && root
      ? settings.getCompilerChoiceForRoot(state.projectRoot, root)
      : null,
    settings.compilerBackend,
    settings.compilerEngine,
    settings.latexInstallation,
  ]);
}
const operations = new Map<
  Compilation,
  { done: Promise<void>; finish: () => void }
>();
const stopping = new Set<{ workspace: number }>();
export const COMPILATION_STOP_EVENT = "catalex-compilation-stop";

/** Scheduled work from before Stop must not restart the compiler. */
export function captureAutomaticCompileContext() {
  const current = captureCompileContext();
  const captured = stopRevision;
  return () => current() && captured === stopRevision;
}

function drainCompilationQueue() {
  if (running || active || stopping.size > 0) return;
  const next = queued;
  queued = null;
  useDocumentStore.setState({ isCompiling: false, pendingRecompile: false });
  if (next) void compileWorkspace(next);
}

/** Cancel only this window's current workspace; keep ownership until cleanup. */
export async function stopCompilation() {
  const session = getPanelWindowSession();
  if (session) return session.stopCompilation();
  observeWorkspace();
  const state = useDocumentStore.getState();
  const projectDir = state.agentWorkspaceRoot ?? state.projectRoot;
  if (!projectDir) return;
  stoppedAutomaticInputs = automaticInputs(state, active?.fileId);
  stopRevision += 1;
  revision += 1;
  queued = null;
  window.dispatchEvent(new Event(COMPILATION_STOP_EVENT));
  const selected = [...operations.keys()].filter(
    (request) => request.projectDir === projectDir,
  );
  for (const request of selected) request.cancelled = true;
  const barrier = { workspace: workspaceRevision };
  stopping.add(barrier);
  useDocumentStore.setState({
    isStoppingCompilation: true,
    pendingRecompile: false,
  });
  try {
    const compilationIds = selected
      .filter((request) => request.nativeStarted)
      .map((request) => request.id);
    await Promise.all([
      // A verification-start event can still be in transit to this renderer.
      invoke("cancel_compilation", { projectDir, compilationIds }),
      ...selected.map((request) => operations.get(request)?.done),
    ]);
  } finally {
    stopping.delete(barrier);
    useDocumentStore.setState({
      isStoppingCompilation: [...stopping].some(
        (entry) => entry.workspace === workspaceRevision,
      ),
    });
    drainCompilationQueue();
  }
}

export function captureCompileContext() {
  observeWorkspace();
  const captured = workspaceRevision;
  return () => workspaceRevision === captured;
}

function context(state: State, fileId = state.activeFileId) {
  return JSON.stringify([
    state.projectRoot,
    state.agentWorkspaceRoot,
    state.agentWorkspaceSessionId,
    state.isGitOperationRunning,
    state.isApplyingAgentDraft,
    resolveCompileTarget(fileId, state.files),
  ]);
}

// Invalidate synchronously, including an away-and-back switch to the same path.
let observing = false;
function observeWorkspace() {
  if (observing) return;
  observing = true;
  useSettingsStore.subscribe((state) => {
    if (
      !state.getProjectAutoCompile(useDocumentStore.getState().projectRoot) &&
      queued?.automatic
    ) {
      queued = null;
      useDocumentStore.setState({ pendingRecompile: false });
    }
  });
  useDocumentStore.subscribe((state, previous) => {
    // Cursor, selection and layout updates do not need a project-wide scan.
    if (
      state.files === previous.files &&
      state.activeFileId === previous.activeFileId &&
      state.contentGeneration === previous.contentGeneration &&
      state.projectRoot === previous.projectRoot &&
      state.agentWorkspaceRoot === previous.agentWorkspaceRoot &&
      state.agentWorkspaceSessionId === previous.agentWorkspaceSessionId &&
      state.isGitOperationRunning === previous.isGitOperationRunning &&
      state.isApplyingAgentDraft === previous.isApplyingAgentDraft
    )
      return;
    const switched =
      context(state, active?.fileId) !== context(previous, active?.fileId);
    const edited =
      state.contentGeneration !== previous.contentGeneration ||
      JSON.stringify(state.files.map((file) => file.relativePath)) !==
        JSON.stringify(previous.files.map((file) => file.relativePath));
    if (!switched && !edited) return;
    revision += 1;
    if (!switched) return;
    workspaceRevision += 1;
    stoppedAutomaticInputs = null;
    active = null;
    queued = null;
    if (state.isCompiling || state.pendingRecompile)
      useDocumentStore.setState({
        isCompiling: false,
        isStoppingCompilation: false,
        pendingRecompile: false,
      });
  });
}

export function beginCompilation(
  rootId: string,
  id: string = crypto.randomUUID(),
  fileId?: string,
): Compilation | null {
  observeWorkspace();
  const state = useDocumentStore.getState();
  if (
    !state.projectRoot ||
    state.isGitOperationRunning ||
    state.isApplyingAgentDraft
  )
    return null;
  if (
    resolveCompileTarget(fileId ?? state.activeFileId, state.files)?.rootId !==
    rootId
  )
    return null;
  revision += 1;
  const request: Compilation = {
    id,
    rootId,
    fileId,
    inputs: automaticInputs(state, fileId),
    generation: state.contentGeneration,
    revision,
    projectDir: state.agentWorkspaceRoot ?? state.projectRoot,
    projectRoot: state.projectRoot,
    cancelled: false,
    nativeStarted: true,
  };
  let finish!: () => void;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  operations.set(request, { done, finish });
  active = request;
  // An externally started verification must not erase a pending user request.
  if (queued) revision += 1;
  useDocumentStore.setState({
    isCompiling: true,
    pendingRecompile: queued !== null,
  });
  return request;
}

export function isCurrentCompilation(request: Compilation) {
  return (
    !request.cancelled && active === request && request.revision === revision
  );
}

export function publishCompilation(
  request: Compilation,
  bytes: PdfSource,
  diagnostics: CompileDiagnostic[] = [],
) {
  if (!isCurrentCompilation(request)) return;
  recordPdfCompilation(
    bytes,
    request.projectRoot,
    request.projectDir,
    request.id,
  );
  useDocumentStore
    .getState()
    .setPdfData(bytes, request.rootId, request.generation, diagnostics);
}

export function failCompilation(request: Compilation, error: unknown) {
  if (!isCurrentCompilation(request)) return;
  useDocumentStore
    .getState()
    .setCompileError(
      formatCompileError(error),
      request.rootId,
      compileErrorDiagnostics(error),
    );
}

export function finishCompilation(request: Compilation) {
  operations.get(request)?.finish();
  operations.delete(request);
  const ownedExecution = running === request;
  if (ownedExecution) running = null;
  if (active === request) active = null;
  else if (!ownedExecution) return;
  drainCompilationQueue();
}

/** Shared entry point for editor shortcuts, preview buttons and auto-compilation. */
export async function compileWorkspace(options: Options = {}) {
  const session = getPanelWindowSession();
  if (session) return session.compile({ ...options, fileId: session.fileId });
  if (
    options.automatic &&
    !useSettingsStore
      .getState()
      .getProjectAutoCompile(useDocumentStore.getState().projectRoot)
  )
    return;
  const state = useDocumentStore.getState();
  if (
    !state.projectRoot ||
    state.isGitOperationRunning ||
    state.isApplyingAgentDraft
  )
    return;
  if (
    options.automatic &&
    stoppedAutomaticInputs === automaticInputs(state, options.fileId)
  )
    return;
  stoppedAutomaticInputs = null;
  const fileId = options.fileId ?? state.activeFileId;
  const file = state.files.find((entry) => entry.id === fileId);
  if (
    file?.type === "pdf" ||
    file?.type === "image" ||
    (file && isMarkdownFile(file))
  )
    return;
  if (running || active || stopping.size > 0) {
    // A second view can request the same source revision. Keep one build;
    // retries from the same view and explicit manual requests queue normally.
    if (
      options.automatic &&
      active &&
      options.fileId !== active.fileId &&
      isCurrentCompilation(active) &&
      active.inputs === automaticInputs(state, fileId)
    )
      return;
    revision += 1;
    queued = mergeRequests(queued, options);
    useDocumentStore.setState({ isCompiling: true, pendingRecompile: true });
    return;
  }
  const target = resolveCompileTarget(fileId, state.files);
  if (!target) {
    state.setCompileError(
      "No .tex file found in this project. Create a main.tex file to compile.",
    );
    return;
  }
  if (
    !options.force &&
    getPdfBytes(target.rootId) &&
    state.lastCompiledGenerations.get(target.rootId) === state.contentGeneration
  )
    return;
  useHistoryStore.getState().stopReview();
  const request = beginCompilation(target.rootId, undefined, options.fileId);
  if (!request) return;
  running = request;
  request.nativeStarted = false;
  const started = Date.now();
  const workspace = workspaceRevision;
  let compilerStarted = false;
  try {
    await state.saveAllFiles(
      state.agentWorkspaceRoot ? undefined : { requireClean: true },
    );
    if (!isCurrentCompilation(request)) return;
    if (
      options.automatic &&
      !useSettingsStore
        .getState()
        .getProjectAutoCompile(useDocumentStore.getState().projectRoot)
    )
      return;
    if (options.snapshot && !state.agentWorkspaceRoot)
      void useHistoryStore
        .getState()
        .createSnapshot(state.projectRoot, "[compile] Pre-compile")
        .catch(() => {});
    const root = state.files.find((entry) => entry.id === target.rootId);
    const detected = root?.content
      ? detectTexEngineFromContent(root.content)
      : null;
    const { backend, engine, autoEngine } = useSettingsStore
      .getState()
      .initializeCompilerChoiceForRoot(
        state.projectRoot,
        target.rootId,
        detected,
      );
    compilerStarted = true;
    request.nativeStarted = true;
    const result = await compileLatex(
      state.agentWorkspaceRoot ?? state.projectRoot,
      target.targetPath,
      backend,
      engine,
      autoEngine,
      request.id,
    );
    publishCompilation(request, result.pdfData, result.diagnostics);
  } catch (error) {
    failCompilation(request, error);
  } finally {
    // Editing during the asynchronous save must not silently consume a request
    // before it ever reaches the compiler, even with automatic compilation off.
    if (
      !compilerStarted &&
      !request.cancelled &&
      (!options.automatic ||
        useSettingsStore
          .getState()
          .getProjectAutoCompile(useDocumentStore.getState().projectRoot)) &&
      workspace === workspaceRevision &&
      request.generation !== useDocumentStore.getState().contentGeneration
    ) {
      queued = mergeRequests(queued, options);
    }
    if (isCurrentCompilation(request)) {
      const remaining = 500 - (Date.now() - started);
      if (remaining > 0)
        await new Promise((resolve) => setTimeout(resolve, remaining));
    }
    finishCompilation(request);
  }
}
