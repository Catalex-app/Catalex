import type { PdfSource } from "./mupdf/pdf-source";
import { isMarkdownFile } from "./markdown";
import { useDocumentStore, hasPdfData } from "@/stores/document-store";
import { useHistoryStore } from "@/stores/history-store";
import { useSettingsStore } from "@/stores/settings-store";
import {
  compileLatex,
  compileErrorDiagnostics,
  detectTexEngineFromContent,
  formatCompileError,
  resolveCompileTarget,
  type CompileDiagnostic,
} from "./latex-compiler";

type State = ReturnType<typeof useDocumentStore.getState>;
type Options = { force?: boolean; snapshot?: boolean; automatic?: boolean };
export type Compilation = {
  readonly rootId: string;
  readonly generation: number;
  readonly revision: number;
};
function mergeRequests(previous: Options | null, next: Options): Options {
  return {
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

export function captureCompileContext() {
  observeWorkspace();
  const captured = workspaceRevision;
  return () => workspaceRevision === captured;
}

function context(state: State) {
  return JSON.stringify([
    state.projectRoot,
    state.agentWorkspaceRoot,
    state.agentWorkspaceSessionId,
    state.isGitOperationRunning,
    state.isApplyingAgentDraft,
    resolveCompileTarget(state.activeFileId, state.files),
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
    const switched = context(state) !== context(previous);
    const edited =
      state.contentGeneration !== previous.contentGeneration ||
      JSON.stringify(state.files.map((file) => file.relativePath)) !==
        JSON.stringify(previous.files.map((file) => file.relativePath));
    if (!switched && !edited) return;
    revision += 1;
    if (!switched) return;
    workspaceRevision += 1;
    active = null;
    queued = null;
    if (state.isCompiling || state.pendingRecompile)
      useDocumentStore.setState({
        isCompiling: false,
        pendingRecompile: false,
      });
  });
}

export function beginCompilation(rootId: string): Compilation | null {
  observeWorkspace();
  const state = useDocumentStore.getState();
  if (
    !state.projectRoot ||
    state.isGitOperationRunning ||
    state.isApplyingAgentDraft
  )
    return null;
  if (resolveCompileTarget(state.activeFileId, state.files)?.rootId !== rootId)
    return null;
  revision += 1;
  const request = { rootId, generation: state.contentGeneration, revision };
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
  return active === request && request.revision === revision;
}

export function publishCompilation(
  request: Compilation,
  bytes: PdfSource,
  diagnostics: CompileDiagnostic[] = [],
) {
  if (!isCurrentCompilation(request)) return;
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
  const ownedExecution = running === request;
  if (ownedExecution) running = null;
  if (active === request) active = null;
  else if (!ownedExecution) return;
  if (running || active) return;
  const next = queued;
  queued = null;
  useDocumentStore.setState({ isCompiling: false, pendingRecompile: false });
  if (next) void compileWorkspace(next);
}

/** Shared entry point for editor shortcuts, preview buttons and auto-compilation. */
export async function compileWorkspace(options: Options = {}) {
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
  const file = state.files.find((entry) => entry.id === state.activeFileId);
  if (
    file?.type === "pdf" ||
    file?.type === "image" ||
    (file && isMarkdownFile(file))
  )
    return;
  if (running || active) {
    revision += 1;
    queued = mergeRequests(queued, options);
    useDocumentStore.setState({ isCompiling: true, pendingRecompile: true });
    return;
  }
  const target = resolveCompileTarget(state.activeFileId, state.files);
  if (!target) {
    state.setCompileError(
      "No .tex file found in this project. Create a main.tex file to compile.",
    );
    return;
  }
  if (
    !options.force &&
    hasPdfData() &&
    state.lastCompiledGenerations.get(target.rootId) === state.contentGeneration
  )
    return;
  useHistoryStore.getState().stopReview();
  const request = beginCompilation(target.rootId);
  if (!request) return;
  running = request;
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
    const result = await compileLatex(
      state.agentWorkspaceRoot ?? state.projectRoot,
      target.targetPath,
      backend,
      engine,
      autoEngine,
    );
    publishCompilation(request, result.pdfData, result.diagnostics);
  } catch (error) {
    failCompilation(request, error);
  } finally {
    // Editing during the asynchronous save must not silently consume a request
    // before it ever reaches the compiler, even with automatic compilation off.
    if (
      !compilerStarted &&
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
