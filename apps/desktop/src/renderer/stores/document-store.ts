import {
  beginProjectOpen,
  updateProjectScreen,
} from "@/lib/project-navigation";
import { rebaseDocumentEdit } from "@/lib/rebase-document-edit";
import { connectPanelDocumentView } from "@/lib/panel-document-view";
import { getPanelWindowSession } from "@/lib/panel-window-runtime";
import type { PdfSource } from "@/lib/mupdf/pdf-source";
import { normalizeDocumentText, encodeDocumentText } from "@/lib/document-text";
import type { ChatContextBadge } from "@/lib/chat-context";
import type { PromptDiagnosticSnapshot } from "@/lib/prompt-library";
import type { CompileDiagnostic } from "@/lib/latex-compiler";
import { create } from "zustand";
import { useSettingsStore } from "@/stores/settings-store";
import { toast } from "sonner";
import { reconcileFile } from "@/lib/external-file-changes";
import { clearCommentDocumentModels } from "@/components/workspace/editor/comment-document-model";
import { invoke } from "@/lib/desktop/core";
import { stat } from "@/lib/desktop/fs";
import {
  scanProjectFolder,
  getFileType,
  readTexFileContent,
  readImageAsDataUrl,
  createFileOnDisk,
  copyFileToProject,
  deleteFileFromDisk,
  deleteFolderFromDisk,
  renameFileOnDisk,
  getUniqueTargetName,
  createDirectory,
  join,
  LARGE_FILE_THRESHOLD,
  type ProjectFileType,
  exists,
} from "@/lib/project-files";
import { useHistoryStore } from "@/stores/history-store";
import { useAgentChatStore } from "@/stores/agent-chat-store";
import { useProjectStore } from "@/stores/project-store";
import {
  clearDocCache,
  prepareForNewPdfRevision,
} from "@/lib/mupdf/pdf-doc-cache";
import { clearScrollPositionCache } from "@/components/workspace/preview/pdf-viewer";
import { clearZoomCache } from "@/components/workspace/preview/pdf-preview";
import { clearEditorStateCache } from "@/components/workspace/editor/latex-editor";
import { createLogger } from "@/lib/debug/logger";
import {
  type DirtyWorkspaceBuffer,
  recoverLatestAgentWorkspace,
} from "@/lib/agent-workspace";

const log = createLogger("document");

export interface ProjectFile {
  id: string; // relativePath is the id
  name: string;
  relativePath: string;
  absolutePath: string;
  type: ProjectFileType;
  content?: string;
  dataUrl?: string;
  /** Binary files without an image/PDF preview must not enter the text editor. */
  isBinary?: boolean;
  isDirty: boolean;
  /** Last disk version used as the base for local edits. */
  diskContent?: string;
  diskModifiedAt?: number;
  externalChange?: {
    id: string;
    base: string;
    disk: string | null;
    reviewContent?: string;
  };
  /** File size in bytes (from stat). Used to skip auto-loading large files. */
  fileSize?: number;
}

interface SourceViewSnapshot {
  files: ProjectFile[];
  folders: string[];
  activeFileId: string;
  openFileIds: string[];
  pdfBytesCache: Map<string, PdfSource>;
  currentPdfRootId: string | null;
  compileError: string | null;
  compileErrorCache: Map<string, string>;
  compileDiagnosticsCache: Map<string, CompileDiagnostic[]>;
  lastCompiledGenerations: Map<string, number>;
}

function editableFileType(path: string): ProjectFileType {
  const lower = path.toLowerCase();
  if (lower.endsWith(".tex") || lower.endsWith(".ltx")) return "tex";
  if (lower.endsWith(".csv")) return "csv";
  if (lower.endsWith(".bib")) return "bib";
  if (/\.(sty|cls|bst|def|cfg|fd|dtx|ins)$/.test(lower)) return "style";
  return "other";
}

// PDF sources live outside Zustand: native disk snapshots or browser fixture bytes.
// Keyed by rootFileId. Consumers read via getPdfBytes() / getCurrentPdfBytes().
const _pdfBytesCache = new Map<string, PdfSource>();
/** Current active PDF root file id (mirrors what Zustand tracks via pdfRevision). */
let _currentPdfRootId: string | null = null;

/** Get the PDF source for a specific root file id. */
export function getPdfBytes(rootFileId: string): PdfSource | undefined {
  return (
    getPanelWindowSession()?.pdf(rootFileId) ?? _pdfBytesCache.get(rootFileId)
  );
}

/** Get the current PDF source without needing its root ID. */
export function getCurrentPdfBytes(): PdfSource | null {
  const session = getPanelWindowSession();
  if (session) {
    const state = useDocumentStore.getState();
    const root = resolveTexRoot(state.activeFileId, state.files);
    return root ? (session.pdf(root) ?? null) : null;
  }
  const state = useDocumentStore.getState();
  const root = resolveTexRoot(state.activeFileId, state.files);
  if (root && _currentPdfRootId !== "__default__")
    return _pdfBytesCache.get(root) ?? null;
  return _currentPdfRootId
    ? (_pdfBytesCache.get(_currentPdfRootId) ?? null)
    : null;
}

/** Check if any PDF data exists for the current root. */
export function hasPdfData(): boolean {
  return getCurrentPdfBytes() !== null;
}

export function clearPdfBytesCache() {
  _pdfBytesCache.clear();
  _currentPdfRootId = null;
}

export interface DocumentState {
  openProjectInstructionFile: (
    fileName: "AGENTS.md" | "CLAUDE.md",
  ) => Promise<void>;
  projectRoot: string | null;
  agentWorkspaceSessionId: string | null;
  agentWorkspaceRoot: string | null;
  isAgentWorkspaceReadOnly: boolean;
  sourceViewSnapshot: SourceViewSnapshot | null;
  isApplyingAgentDraft: boolean;
  files: ProjectFile[];
  folders: string[];
  activeFileId: string;
  /** Explicit file selections, excluding automatic fallbacks after disk refresh. */
  fileSelectionRevision: number;
  openFileIds: string[];
  cursorPosition: number;
  outlineScrollPosition: number | null;
  selectionRange: { start: number; end: number } | null;
  /** Live editor diagnostics, shared with chat pop-outs but never persisted. */
  promptDiagnostics: PromptDiagnosticSnapshot | null;
  commentSelectionContext: ChatContextBadge | null;
  setCommentSelectionContext: (context: ChatContextBadge | null) => void;
  pdfSelectionContext: ChatContextBadge | null;
  setPdfSelectionContext: (
    context: DocumentState["pdfSelectionContext"],
  ) => void;
  selectionPreviewRange: {
    fileId: string;
    start: number;
    end: number;
  } | null;
  jumpToPosition: number | null;
  jumpToPositionHighlight: boolean;
  jumpToSelectionRange: { start: number; end: number } | null;
  isThreadOpen: boolean;
  /** Bumped whenever PDF bytes change — triggers re-render without storing bytes in state. */
  pdfRevision: number;
  compileError: string | null;
  isCompiling: boolean;
  isStoppingCompilation: boolean;
  /** When true, a recompile will be triggered after the current compile finishes. */
  pendingRecompile: boolean;
  isSaving: boolean;
  isGitOperationRunning: boolean;
  initialized: boolean;
  /** Incremented on every file content change; used to skip no-op recompiles. */
  contentGeneration: number;
  /** Per-root-file cache: rootFileId → compile error message. */
  compileErrorCache: Map<string, string>;
  compileDiagnosticsCache: Map<string, CompileDiagnostic[]>;
  /** Per-root-file: rootFileId → contentGeneration at last successful compile. */
  lastCompiledGenerations: Map<string, number>;

  openProject: (rootPath: string) => Promise<void>;
  closeProject: () => Promise<boolean>;
  setActiveFile: (id: string) => void;
  openFileInBackground: (id: string) => void;
  closeOpenFile: (id: string) => void;
  addFile: (file: Omit<ProjectFile, "id" | "isDirty">) => string;
  deleteFile: (id: string) => Promise<void>;
  deleteFolder: (folderPath: string) => Promise<void>;
  renameFile: (id: string, name: string) => Promise<void>;
  renameFolder: (folderPath: string, name: string) => Promise<string | null>;
  updateFileContent: (id: string, content: string, base?: string) => void;
  setCursorPosition: (position: number) => void;
  setSelectionRange: (range: { start: number; end: number } | null) => void;
  setSelectionPreviewRange: (
    range: { fileId: string; start: number; end: number } | null,
  ) => void;
  requestJumpToPosition: (position: number, highlight?: boolean) => void;
  requestJumpToSelectionRange: (range: { start: number; end: number }) => void;
  clearJumpRequest: () => void;
  setThreadOpen: (open: boolean) => void;
  setPdfData: (
    data: PdfSource | null,
    rootFileId?: string,
    compiledGeneration?: number,
    diagnostics?: CompileDiagnostic[],
  ) => void;
  setCompileError: (
    error: string | null,
    rootFileId?: string,
    diagnostics?: CompileDiagnostic[],
  ) => void;
  setIsCompiling: (isCompiling: boolean) => void;
  setPendingRecompile: (pending: boolean) => void;
  setIsSaving: (isSaving: boolean) => void;
  insertAtCursor: (text: string) => void;
  replaceSelection: (start: number, end: number, text: string) => void;
  findAndReplace: (find: string, replace: string) => boolean;
  setInitialized: () => void;
  saveFile: (id: string) => Promise<void>;
  saveAllFiles: (options?: {
    requireClean?: boolean;
    deferCommentSync?: boolean;
  }) => Promise<void>;
  saveCurrentFile: () => Promise<void>;
  runGitOperation: <T>(
    projectRoot: string,
    options: {
      saveFiles?: string[];
      discardFiles?: string[];
      history?: { label: string; before?: boolean };
    },
    operation: () => Promise<T>,
  ) => Promise<T>;
  createNewFile: (
    name: string,
    type: ProjectFileType,
    folder?: string,
  ) => Promise<void>;
  createFolder: (name: string, parentFolder?: string) => Promise<void>;
  importFiles: (
    sourcePaths: string[],
    targetFolder?: string,
  ) => Promise<string[]>;
  moveFile: (
    fileId: string,
    targetFolder: string | null,
  ) => Promise<string | undefined>;
  moveFolder: (
    folderPath: string,
    targetFolder: string | null,
  ) => Promise<string | undefined>;
  reloadFile: (relativePath: string) => Promise<void>;
  refreshFiles: (options?: {
    pendingReviewPaths?: readonly string[];
  }) => Promise<void>;
  refreshExternalFiles: (paths?: string[], rescan?: boolean) => Promise<void>;
  resolveExternalFile: (
    id: string,
    changeId: string,
    content: string | null,
  ) => Promise<void>;
  activateAgentWorkspace: (
    sessionId: string,
    candidateRoot: string,
  ) => Promise<void>;
  restoreRecoveredDirtyBuffers: (
    buffers: DirtyWorkspaceBuffer[],
  ) => Promise<void>;
  addAgentWorkspaceReviewFiles: (
    changes: Array<{
      filePath: string;
      kind: "added" | "modified" | "deleted" | "renamed";
      oldContent: string | null;
      newContent: string | null;
      binary?: boolean;
      sourceAbsolutePath?: string;
      candidateAbsolutePath?: string | null;
    }>,
  ) => Promise<void>;
  setAgentWorkspaceReadOnly: (readOnly: boolean) => void;
  restoreSourceWorkspace: (
    appliedPaths?: string[],
    options?: {
      preserveSelection?: boolean;
      pendingReviewPaths?: readonly string[];
    },
  ) => Promise<void>;
  /** Load content for a file that was skipped during project open (large file). */
  loadFileContent: (id: string) => Promise<void>;

  get fileName(): string;
  get content(): string;
  setFileName: (name: string) => void;
  setContent: (content: string, base?: string) => void;
}

function getActiveFile(state: { files: ProjectFile[]; activeFileId: string }) {
  return state.files.find((f) => f.id === state.activeFileId);
}

function hasHiddenDirectory(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, "/");
  const parts = normalized.split("/").filter((part) => part.length > 0);
  return parts.slice(0, -1).some((part) => part.startsWith("."));
}

function getRelativePathDepth(relativePath: string): number {
  const normalized = relativePath.replace(/\\/g, "/");
  return normalized.split("/").length - 1;
}

function compareByDepthThenPath(a: ProjectFile, b: ProjectFile): number {
  const depthDiff =
    getRelativePathDepth(a.relativePath) - getRelativePathDepth(b.relativePath);
  if (depthDiff !== 0) return depthDiff;
  return a.relativePath.localeCompare(b.relativePath);
}

function pickDefaultOpenFile(files: ProjectFile[]): ProjectFile | undefined {
  const sortedTexFiles = files
    .filter((f) => f.type === "tex")
    .sort(compareByDepthThenPath);

  if (sortedTexFiles.length === 0) return files[0];

  return (
    sortedTexFiles.find(
      (f) => f.name === "main.tex" || f.name === "document.tex",
    ) ?? sortedTexFiles[0]
  );
}

async function loadProjectTree(rootPath: string): Promise<{
  files: ProjectFile[];
  folders: string[];
}> {
  const { files: fsFiles, folders } = await scanProjectFolder(rootPath);
  const files: ProjectFile[] = [];

  for (const file of fsFiles) {
    const projectFile: ProjectFile = {
      id: file.relativePath,
      name: file.relativePath.split(/[/\\]/).pop() || file.relativePath,
      relativePath: file.relativePath,
      absolutePath: file.absolutePath,
      type: file.type,
      isDirty: false,
      fileSize: file.fileSize,
    };

    if (
      file.type === "tex" ||
      file.type === "csv" ||
      file.type === "bib" ||
      file.type === "style" ||
      file.type === "other"
    ) {
      const isLargeNonEssential =
        (file.type === "csv" || file.type === "other") &&
        file.fileSize > LARGE_FILE_THRESHOLD;
      if (!isLargeNonEssential) {
        try {
          projectFile.diskContent = await readTexFileContent(file.absolutePath);
          projectFile.content = normalizeDocumentText(projectFile.diskContent);
        } catch {
          projectFile.content = "";
        }
      }
    }

    if (file.type === "image" && file.fileSize <= LARGE_FILE_THRESHOLD) {
      try {
        projectFile.dataUrl = await readImageAsDataUrl(file.absolutePath);
      } catch {
        // Image loading is best-effort.
      }
    }

    files.push(projectFile);
  }

  return { files, folders };
}

const texRootMetadata = new WeakMap<
  ProjectFile,
  { content: string; rootHints: string[]; hasDocumentClass: boolean }
>();

function getTexRootMetadata(file: ProjectFile) {
  const content = file.content ?? "";
  const cached = texRootMetadata.get(file);
  if (cached?.content === content) return cached;
  // Sidebar diagnostics resolve roots for many files on every edit. Cache only
  // source facts, not resolved file IDs, so renames/deletions stay current.
  // Weak keys let closed projects and replaced file revisions be collected.
  const rootHints = content.split("\n", 20).flatMap((line) => {
    const match = line.match(/^%\s*!TEX\s+root\s*=\s*(.+)/i);
    return match ? [match[1].trim()] : [];
  });
  const metadata = {
    content,
    rootHints,
    hasDocumentClass: /\\documentclass[\s{[]/.test(content),
  };
  texRootMetadata.set(file, metadata);
  return metadata;
}

/**
 * Resolve the root .tex file for compilation.
 *
 * Priority order:
 * 1. `% !TEX root = <file>` magic comment in the first 20 lines of the active file
 * 2. The file itself, if it contains `\documentclass`
 * 3. `main.tex` or `document.tex` that contains `\documentclass`
 * 4. Any other .tex file in the project that contains `\documentclass`
 * 5. Fallback: the active file itself
 */
export function resolveTexRoot(fileId: string, files: ProjectFile[]): string {
  const file = files.find((f) => f.id === fileId);
  if (!file || file.type !== "tex" || !file.content) return fileId;

  // 1. Check for % !TEX root magic comments in the first 20 lines.
  const metadata = getTexRootMetadata(file);
  for (const rootPath of metadata.rootHints) {
    // The compiler sync intentionally skips hidden directories (e.g. .prism),
    // so hidden-root hints cannot be compiled reliably.
    if (hasHiddenDirectory(rootPath)) continue;
    const target =
      files.find((f) => f.relativePath === rootPath) ??
      files.find((f) => f.name === rootPath);
    if (
      target &&
      target.type === "tex" &&
      !hasHiddenDirectory(target.relativePath)
    ) {
      return target.id;
    }
  }

  // 2. If the current file contains \documentclass, it is a root file
  if (metadata.hasDocumentClass && !hasHiddenDirectory(file.relativePath)) {
    return fileId;
  }

  // 3. Look for main.tex or document.tex with \documentclass
  const wellKnown = files.find(
    (f) =>
      (f.name === "main.tex" || f.name === "document.tex") &&
      f.type === "tex" &&
      !hasHiddenDirectory(f.relativePath) &&
      f.content &&
      getTexRootMetadata(f).hasDocumentClass,
  );
  if (wellKnown) return wellKnown.id;

  // 4. Any .tex file with \documentclass
  const anyRoot = files.find(
    (f) =>
      f.type === "tex" &&
      f.id !== fileId &&
      !hasHiddenDirectory(f.relativePath) &&
      f.content &&
      getTexRootMetadata(f).hasDocumentClass,
  );
  if (anyRoot) return anyRoot.id;

  // 5. Fallback: the active file itself
  return fileId;
}

/** Re-key the external PDF bytes cache when a file is renamed/moved. */
function migratePdfBytesKey(oldKey: string, newKey: string) {
  if (!_pdfBytesCache.has(oldKey)) return;
  const bytes = _pdfBytesCache.get(oldKey)!;
  _pdfBytesCache.delete(oldKey);
  _pdfBytesCache.set(newKey, bytes);
  if (_currentPdfRootId === oldKey) _currentPdfRootId = newKey;
}

function remapFolderPath(
  path: string,
  oldFolderPath: string,
  newFolderPath: string,
) {
  if (path === oldFolderPath) return newFolderPath;
  const prefix = `${oldFolderPath}/`;
  if (!path.startsWith(prefix)) return path;
  return `${newFolderPath}/${path.slice(prefix.length)}`;
}

function isPathInsideFolder(path: string, folderPath: string) {
  return path === folderPath || path.startsWith(`${folderPath}/`);
}

// Save after 2 seconds idle, or 5 seconds of continuous editing.
let autoSaveTimer: ReturnType<typeof setTimeout> | null = null;
let autoSaveStartedAt: number | null = null;
let autoSaveRunning: number | null = null;
function cancelAutoSave() {
  if (autoSaveTimer) clearTimeout(autoSaveTimer);
  autoSaveTimer = null;
  autoSaveStartedAt = null;
}
// Store reference set after creation to avoid TDZ issues
let storeRef: typeof useDocumentStore | null = null;
const pendingFileSaves = new Map<string, Promise<void>>();
let gitOperationGeneration = 0;
let mutatingDocumentPath = false;
let documentMutationQueue: Promise<unknown> = Promise.resolve();
let workspaceGeneration = 0;

function coordinateDocumentMutation<T>(
  operation: (assertWorkspace: () => void) => Promise<T>,
): Promise<T | undefined> {
  const initial = useDocumentStore.getState();
  const generation = workspaceGeneration;
  if (
    !initial.projectRoot ||
    initial.agentWorkspaceRoot ||
    initial.isApplyingAgentDraft ||
    initial.isAgentWorkspaceReadOnly ||
    initial.isGitOperationRunning
  )
    return Promise.resolve(undefined);
  const assertWorkspace = () => {
    const current = useDocumentStore.getState();
    if (
      generation !== workspaceGeneration ||
      current.projectRoot !== initial.projectRoot ||
      current.agentWorkspaceRoot ||
      current.isApplyingAgentDraft ||
      current.isAgentWorkspaceReadOnly ||
      current.isGitOperationRunning
    )
      throw new Error("The workspace changed. Try the file operation again.");
  };
  const running = documentMutationQueue
    .catch(() => {})
    .then(async () => {
      assertWorkspace();
      mutatingDocumentPath = true;
      gitOperationGeneration += 1;
      cancelAutoSave();
      try {
        // Finish every write before a path can disappear; a failed write cancels
        // the mutation so its buffer remains available for recovery.
        const results = await Promise.allSettled([
          ...pendingFileSaves.values(),
        ]);
        assertWorkspace();
        const failed = results.find((result) => result.status === "rejected");
        if (failed?.status === "rejected") throw failed.reason;
        return await operation(assertWorkspace);
      } finally {
        mutatingDocumentPath = false;
        gitOperationGeneration += 1;
        if (useDocumentStore.getState().files.some((file) => file.isDirty))
          scheduleAutoSave();
      }
    });
  documentMutationQueue = running;
  return running;
}
let agentWorkspaceActivation = 0;

// Queue writes to the same file so a slower older save cannot overwrite a newer
// one. Only the buffer version actually written may be marked clean.
function persistDocumentFile(file: ProjectFile): Promise<void> {
  const generation = workspaceGeneration;
  const previous = pendingFileSaves.get(file.absolutePath) ?? Promise.resolve();
  const saving = previous
    .catch(() => {})
    .then(async () => {
      const state = storeRef?.getState();
      const current = state?.files.find(
        (item) => item.absolutePath === file.absolutePath,
      );
      if (
        generation !== workspaceGeneration ||
        !state?.projectRoot ||
        !current ||
        state.agentWorkspaceRoot ||
        current.externalChange
      ) {
        throw new Error("Resolve the file's disk changes before saving.");
      }
      const diskText = encodeDocumentText(
        file.content!,
        current.diskContent ?? file.diskContent ?? "",
      );
      const result = await invoke<{
        written: boolean;
        current: string | null;
        commentWarning?: string;
      }>("save_file_if_unchanged", {
        projectRoot: state.projectRoot,
        filePath: file.relativePath,
        expected: current.diskContent ?? file.diskContent ?? file.content,
        content: diskText,
      });
      if (result.commentWarning)
        toast.error(
          `File saved. Comment tracking needs attention: ${result.commentWarning}`,
        );
      if (generation !== workspaceGeneration)
        throw new Error("The workspace changed while saving. Try again.");
      if (!result.written && result.current !== diskText) {
        storeRef?.setState((latest) => ({
          files: latest.files.map((item) =>
            item.absolutePath === file.absolutePath
              ? reconcileFile(item, result.current)
              : item,
          ),
        }));
        throw new Error(
          "This file changed on disk. Review the changes before saving.",
        );
      }
      storeRef?.setState((state) => ({
        files: state.files.map((current) =>
          current.absolutePath === file.absolutePath
            ? {
                ...current,
                diskContent: diskText,
                isDirty: current.content !== file.content,
              }
            : current,
        ),
      }));
    });
  pendingFileSaves.set(file.absolutePath, saving);
  const finished = () => {
    if (pendingFileSaves.get(file.absolutePath) === saving) {
      pendingFileSaves.delete(file.absolutePath);
    }
  };
  void saving.then(finished, finished);
  return saving;
}

/** Move on disk while retaining the latest editor buffers and all path-keyed state. */
async function moveDocumentPath(
  oldPath: string,
  desiredPath: string,
  folder: boolean,
  uniqueTarget = true,
): Promise<string | undefined> {
  return coordinateDocumentMutation(async (assertWorkspace) => {
    const store = useDocumentStore;
    const initial = store.getState();
    const root = initial.projectRoot!;
    if (
      folder
        ? !initial.folders.includes(oldPath)
        : !initial.files.some((file) => file.id === oldPath)
    )
      throw new Error("The path changed. Try the file operation again.");
    if (oldPath === desiredPath) return oldPath;
    await saveDocumentFiles(undefined, true);
    assertWorkspace();
    if (store.getState().files.some((file) => file.externalChange))
      throw new Error("Resolve disk changes before moving or renaming files.");
    const newPath = uniqueTarget
      ? await getUniqueTargetName(root, desiredPath)
      : desiredPath;
    const oldAbsolutePath = await join(root, oldPath);
    const newAbsolutePath = await join(root, newPath);
    assertWorkspace();
    const { withCommentPathMutation } = await import(
      "@/components/workspace/editor/inline-comment-storage"
    );
    assertWorkspace();
    const change = { oldPath, newPath, folder };
    await withCommentPathMutation(root, async () => {
      assertWorkspace();
      if (window.catalex)
        return invoke<{
          pathChanges: (typeof change)[];
          commentWarning?: string;
        }>("rename_project_path", { projectRoot: root, change });
      await renameFileOnDisk(oldAbsolutePath, newAbsolutePath);
      await invoke("remap_project_comment_paths", {
        projectRoot: root,
        changes: [change],
      });
      return { pathChanges: [change] };
    });
    // Disk completion does not authorize publication into a later workspace,
    // including a second visit to the same project.
    try {
      assertWorkspace();
    } catch {
      return;
    }
    const remap = (path: string) =>
      folder
        ? remapFolderPath(path, oldPath, newPath)
        : path === oldPath
          ? newPath
          : path;
    const remapCache = <V>(cache: Map<string, V>) =>
      new Map([...cache].map(([key, value]) => [remap(key), value]));
    for (const key of [..._pdfBytesCache.keys()])
      migratePdfBytesKey(key, remap(key));
    store.setState((state) => ({
      files: state.files.map((file) => {
        const path = remap(file.relativePath);
        if (path === file.relativePath) return file;
        return {
          ...file,
          id: path,
          relativePath: path,
          name: path.split("/").pop()!,
          absolutePath:
            newAbsolutePath + file.relativePath.slice(oldPath.length),
        };
      }),
      folders: state.folders.map(remap),
      activeFileId: remap(state.activeFileId),
      openFileIds: state.openFileIds.map(remap),
      selectionPreviewRange: state.selectionPreviewRange
        ? {
            ...state.selectionPreviewRange,
            fileId: remap(state.selectionPreviewRange.fileId),
          }
        : null,
      compileErrorCache: remapCache(state.compileErrorCache),
      compileDiagnosticsCache: remapCache(state.compileDiagnosticsCache),
      lastCompiledGenerations: remapCache(state.lastCompiledGenerations),
    }));
    const recent = useProjectStore
      .getState()
      .recentProjects.find((project) => project.path === root);
    if (recent?.lastActiveFile)
      useProjectStore
        .getState()
        .setRecentProjectLastActiveFile(root, remap(recent.lastActiveFile));
    return newPath;
  });
}

async function saveDocumentFiles(
  options?: { requireClean?: boolean; deferCommentSync?: boolean },
  insideMutation = false,
): Promise<void> {
  const generation = workspaceGeneration;
  if (!insideMutation) await documentMutationQueue.catch(() => {});
  if (generation !== workspaceGeneration)
    throw new Error("The workspace changed while waiting to save. Try again.");
  const state = useDocumentStore.getState();
  if (
    (!insideMutation && mutatingDocumentPath) ||
    state.isApplyingAgentDraft ||
    state.isAgentWorkspaceReadOnly ||
    state.agentWorkspaceRoot ||
    state.isGitOperationRunning
  ) {
    if (options?.requireClean)
      throw new Error(
        "Cannot save the source while a draft or Git operation is active.",
      );
    return;
  }
  const writes = state.files.flatMap((file) => {
    const saving =
      file.isDirty && file.content != null
        ? persistDocumentFile(file)
        : options?.requireClean
          ? pendingFileSaves.get(file.absolutePath)
          : undefined;
    return saving ? [{ file, saving }] : [];
  });
  const results = await Promise.allSettled(writes.map(({ saving }) => saving));
  const failed = results.findIndex((result) => result.status === "rejected");
  if (failed >= 0) {
    const result = results[failed] as PromiseRejectedResult;
    const message = `Failed to save ${writes[failed].file.relativePath}: ${String(result.reason)}`;
    log.error(message);
    toast.error(message, {
      id: "document-save-failed",
      duration: Number.POSITIVE_INFINITY,
    });
    if (options?.requireClean || insideMutation) throw new Error(message);
  }
  if (writes.length && failed < 0 && !options?.deferCommentSync)
    await finishCommentSave(state.projectRoot);
  if (!options?.requireClean) return;
  const current = useDocumentStore.getState();
  if (
    generation !== workspaceGeneration ||
    current.projectRoot !== state.projectRoot ||
    current.agentWorkspaceRoot ||
    current.isAgentWorkspaceReadOnly ||
    current.isGitOperationRunning
  )
    throw new Error("The source workspace changed while saving. Try again.");
  if (current.files.some((file) => file.isDirty))
    throw new Error(
      "The document changed while saving or contains unsaved content. Try again.",
    );
}

async function checkpointBeforeDeletion(
  projectRoot: string,
  path: string,
  assertWorkspace: () => void,
) {
  await saveDocumentFiles({ requireClean: true }, true);
  assertWorkspace();
  const saved = useDocumentStore.getState();
  if (saved.projectRoot !== projectRoot)
    throw new Error("The project changed. Try again.");
  await useHistoryStore.getState().init(projectRoot);
  assertWorkspace();
  await useHistoryStore
    .getState()
    .createSnapshot(projectRoot, `[before-delete] ${path}`);
  assertWorkspace();
  const current = useDocumentStore.getState();
  if (
    current.projectRoot !== projectRoot ||
    current.files !== saved.files ||
    current.agentWorkspaceRoot ||
    current.isAgentWorkspaceReadOnly ||
    current.isApplyingAgentDraft ||
    current.isGitOperationRunning
  )
    throw new Error(
      "The workspace changed while creating the checkpoint. Try again.",
    );
  return current;
}

function scheduleAutoSave() {
  if (storeRef?.getState().isGitOperationRunning) return;
  const now = Date.now();
  autoSaveStartedAt ??= now;
  if (autoSaveTimer) clearTimeout(autoSaveTimer);
  const delay = Math.max(0, Math.min(2000, 5000 - (now - autoSaveStartedAt)));
  autoSaveTimer = setTimeout(async () => {
    cancelAutoSave();
    // A slow save must not accumulate snapshots of intermediate typing. Its
    // completion schedules the latest buffer if edits arrived in the meantime.
    if (autoSaveRunning === workspaceGeneration) return;
    const store = storeRef;
    if (!store) return;
    const state = store.getState();
    if (
      state.isApplyingAgentDraft ||
      state.isAgentWorkspaceReadOnly ||
      state.agentWorkspaceRoot ||
      state.isGitOperationRunning
    )
      return;
    const dirtyFiles = state.files.filter(
      (f) => f.isDirty && f.content != null && !f.externalChange,
    );
    if (!dirtyFiles.length) return;
    const generation = workspaceGeneration;
    autoSaveRunning = generation;
    try {
      await state.saveAllFiles();
    } catch (error) {
      log.warn("Autosave could not finish", { error: String(error) });
    } finally {
      if (autoSaveRunning === generation) autoSaveRunning = null;
      // Do not retry an unchanged failing buffer forever, or reschedule a save
      // from an old workspace. Preserve any timer already set by newer edits.
      if (
        generation === workspaceGeneration &&
        store.getState().contentGeneration !== state.contentGeneration &&
        !autoSaveTimer
      )
        scheduleAutoSave();
    }
  }, delay);
}

// Source writes have already succeeded. Metadata completion is best effort and
// cannot turn a successful manuscript save into a failure or roll it back.
async function finishCommentSave(projectRoot: string | null) {
  if (!projectRoot) return;
  try {
    const { synchronizeProjectCommentAnchors } = await import(
      "@/components/workspace/editor/inline-comment-storage"
    );
    await synchronizeProjectCommentAnchors(projectRoot);
  } catch (error) {
    log.warn("Document saved; comment positions need recovery", {
      error: String(error),
    });
    toast.error(
      "Document saved. Comment positions could not be updated; they will be checked when the project opens.",
      { id: "comment-save-fallback" },
    );
  }
}

// A pending lease reserves the destination before the current project is closed.
let activeProjectLease: string | null = null;
let openingProject = false;

export const useDocumentStore = create<DocumentState>()((set, get) => ({
  projectRoot: null,
  agentWorkspaceSessionId: null,
  agentWorkspaceRoot: null,
  isAgentWorkspaceReadOnly: false,
  sourceViewSnapshot: null,
  isApplyingAgentDraft: false,
  files: [],
  folders: [],
  activeFileId: "",
  fileSelectionRevision: 0,
  openFileIds: [],
  cursorPosition: 0,
  outlineScrollPosition: null,
  selectionRange: null,
  promptDiagnostics: null,
  pdfSelectionContext: null,
  commentSelectionContext: null,
  selectionPreviewRange: null,
  jumpToPosition: null,
  jumpToPositionHighlight: false,
  jumpToSelectionRange: null,
  isThreadOpen: false,
  pdfRevision: 0,
  compileError: null,
  isCompiling: false,
  isStoppingCompilation: false,
  pendingRecompile: false,
  isSaving: false,
  isGitOperationRunning: false,
  initialized: false,
  contentGeneration: 0,
  compileErrorCache: new Map(),
  compileDiagnosticsCache: new Map(),
  lastCompiledGenerations: new Map(),

  openProject: async (rootPath: string) => {
    if (openingProject)
      throw new Error("A project is already opening in this window.");
    openingProject = true;
    let pendingLease: string | null = null;
    let finishOpening = () => {};
    try {
      finishOpening = beginProjectOpen(rootPath);
      if (window.catalex)
        pendingLease = await invoke<string>("desktop:project:acquire", {
          path: rootPath,
        });
      log.info(`Opening project: ${rootPath}`);
      if (get().projectRoot && !(await get().closeProject()))
        throw new Error("The current project could not be paused and saved.");
      const { restoreProjectChats } = await import(
        "@/lib/project-chat-lifecycle"
      );
      await invoke("prepare_project_storage", { projectRoot: rootPath });
      const { files: projectFiles, folders: fsFolders } =
        await loadProjectTree(rootPath);

      // Restore previously focused file for this project when available.
      const lastActiveFile = useProjectStore
        .getState()
        .recentProjects.find(
          (project) => project.path === rootPath,
        )?.lastActiveFile;
      const restoredFile = lastActiveFile
        ? projectFiles.find((file) => file.id === lastActiveFile)
        : undefined;

      // Fallback to the default open file with shallower paths prioritized.
      const initialFile = restoredFile ?? pickDefaultOpenFile(projectFiles);

      await restoreProjectChats(rootPath);
      clearPdfBytesCache();
      await updateProjectScreen(
        "open",
        () => {
          set({
            projectRoot: rootPath,
            agentWorkspaceSessionId: null,
            agentWorkspaceRoot: null,
            isAgentWorkspaceReadOnly: false,
            sourceViewSnapshot: null,
            files: projectFiles,
            folders: fsFolders,
            activeFileId: initialFile?.id || projectFiles[0]?.id || "",
            openFileIds: initialFile?.id
              ? [initialFile.id]
              : projectFiles[0]?.id
                ? [projectFiles[0].id]
                : [],
            pdfRevision: 0,
            compileError: null,
            compileErrorCache: new Map(),
            compileDiagnosticsCache: new Map(),
            lastCompiledGenerations: new Map(),
            initialized: true,
            cursorPosition: 0,
            outlineScrollPosition: null,
            selectionRange: null,
            pdfSelectionContext: null,
            commentSelectionContext: null,
            selectionPreviewRange: null,
            jumpToPosition: null,
            jumpToPositionHighlight: false,
            jumpToSelectionRange: null,
          });
        },
        rootPath,
      );

      // Initialize history system early so snapshots work before the panel is opened
      const historyStore = useHistoryStore.getState();
      historyStore
        .init(rootPath)
        .then(() => historyStore.loadSnapshots(rootPath))
        .catch((err) => {
          log.error("Failed to initialize history", { error: String(err) });
        });
      recoverLatestAgentWorkspace(rootPath).catch((error) => {
        log.error("Failed to recover isolated agent workspace", {
          error: String(error),
        });
      });
      activeProjectLease = pendingLease;
      pendingLease = null;
    } finally {
      finishOpening();
      openingProject = false;
      if (pendingLease)
        await invoke("desktop:project:release", { token: pendingLease });
    }
  },

  closeProject: async () => {
    log.info("Closing project");
    const projectRoot = get().projectRoot;
    if (projectRoot) {
      try {
        const { prepareProjectExit } = await import(
          "@/lib/project-chat-lifecycle"
        );
        await prepareProjectExit();
      } catch (error) {
        toast.error(`Could not close the project: ${String(error)}`);
        return false;
      }
      if (get().projectRoot !== projectRoot) return false;
    }
    cancelAutoSave();
    clearDocCache();
    clearScrollPositionCache();
    clearZoomCache();
    clearEditorStateCache();
    clearCommentDocumentModels();
    clearPdfBytesCache();
    await updateProjectScreen(
      "close",
      () => {
        set({
          projectRoot: null,
          agentWorkspaceSessionId: null,
          agentWorkspaceRoot: null,
          isAgentWorkspaceReadOnly: false,
          sourceViewSnapshot: null,
          files: [],
          folders: [],
          activeFileId: "",
          openFileIds: [],
          pdfRevision: 0,
          compileError: null,
          compileErrorCache: new Map(),
          compileDiagnosticsCache: new Map(),
          lastCompiledGenerations: new Map(),
          cursorPosition: 0,
          outlineScrollPosition: null,
          selectionRange: null,
          pdfSelectionContext: null,
          commentSelectionContext: null,
          selectionPreviewRange: null,
          jumpToPosition: null,
          jumpToPositionHighlight: false,
          jumpToSelectionRange: null,
          initialized: false,
        });
      },
      projectRoot,
    );
    // All tabs have been saved under the old project before clearing the workspace.
    useAgentChatStore.getState().restoreProjectTabs(null);
    if (activeProjectLease) {
      await invoke("desktop:project:release", { token: activeProjectLease });
      activeProjectLease = null;
    }
    return true;
  },

  setActiveFile: (id) => {
    const state = get();
    const selected = state.files.find((file) => file.id === id);
    if (
      selected &&
      selected.content === undefined &&
      selected.type !== "image" &&
      selected.type !== "pdf" &&
      !selected.isBinary &&
      (selected.fileSize ?? 0) <= LARGE_FILE_THRESHOLD
    )
      void get().loadFileContent(id);
    const rootId = resolveTexRoot(id, state.files);
    const newPdfRootId = _pdfBytesCache.has(rootId) ? rootId : null;
    const pdfRootChanged = newPdfRootId !== _currentPdfRootId;
    _currentPdfRootId = newPdfRootId;
    const cachedError = state.compileErrorCache.get(rootId) ?? null;
    set((s) => ({
      activeFileId: id,
      fileSelectionRevision:
        s.fileSelectionRevision + Number(s.activeFileId !== id),
      openFileIds: s.openFileIds.includes(id)
        ? s.openFileIds
        : [...s.openFileIds, id],
      selectionRange: null,
      pdfSelectionContext: null,
      commentSelectionContext: null,
      selectionPreviewRange: null,
      ...(pdfRootChanged ? { pdfRevision: s.pdfRevision + 1 } : {}),
      compileError: cachedError,
    }));
    if (state.projectRoot) {
      useProjectStore
        .getState()
        .setRecentProjectLastActiveFile(state.projectRoot, id);
    }
  },

  openFileInBackground: (id) => {
    const state = get();
    if (
      !state.files.some((file) => file.id === id) ||
      state.openFileIds.includes(id)
    )
      return;
    set({ openFileIds: [...state.openFileIds, id] });
  },

  closeOpenFile: (id) => {
    const state = get();
    const nextOpen = state.openFileIds.filter((fileId) => fileId !== id);
    if (nextOpen.length === 0) {
      return;
    }
    const nextActive =
      state.activeFileId === id
        ? (nextOpen[Math.max(0, state.openFileIds.indexOf(id) - 1)] ??
          nextOpen[0])
        : state.activeFileId;
    const rootId = resolveTexRoot(nextActive, state.files);
    const newPdfRootId = _pdfBytesCache.has(rootId) ? rootId : null;
    const pdfRootChanged = newPdfRootId !== _currentPdfRootId;
    _currentPdfRootId = newPdfRootId;
    const cachedError = state.compileErrorCache.get(rootId) ?? null;
    set({
      openFileIds: nextOpen,
      activeFileId: nextActive,
      fileSelectionRevision:
        state.fileSelectionRevision + Number(state.activeFileId !== nextActive),
      ...(pdfRootChanged ? { pdfRevision: state.pdfRevision + 1 } : {}),
      compileError: cachedError,
    });
    if (state.projectRoot) {
      useProjectStore
        .getState()
        .setRecentProjectLastActiveFile(state.projectRoot, nextActive);
    }
  },

  setSelectionRange: (range) =>
    set({
      selectionRange: range,
      pdfSelectionContext: null,
      commentSelectionContext: null,
    }),
  setPdfSelectionContext: (pdfSelectionContext) =>
    set({
      pdfSelectionContext,
      ...(pdfSelectionContext ? { commentSelectionContext: null } : {}),
    }),
  setCommentSelectionContext: (commentSelectionContext) =>
    set({
      commentSelectionContext,
      selectionRange: null,
      pdfSelectionContext: null,
    }),

  setSelectionPreviewRange: (range) => set({ selectionPreviewRange: range }),

  requestJumpToPosition: (position, highlight = false) =>
    set({ jumpToPosition: position, jumpToPositionHighlight: highlight }),

  requestJumpToSelectionRange: (range) => set({ jumpToSelectionRange: range }),

  clearJumpRequest: () =>
    set({
      jumpToPosition: null,
      jumpToPositionHighlight: false,
      jumpToSelectionRange: null,
    }),

  addFile: (file) => {
    const id = file.relativePath;
    if (get().agentWorkspaceRoot) return id;
    set((state) => ({
      files: [...state.files, { ...file, id, isDirty: false }],
      activeFileId: id,
      openFileIds: state.openFileIds.includes(id)
        ? state.openFileIds
        : [...state.openFileIds, id],
    }));
    return id;
  },

  deleteFile: async (id) => {
    try {
      await coordinateDocumentMutation(async (assertWorkspace) => {
        let state = get();
        if (state.agentWorkspaceRoot) return;
        if (state.files.length <= 1) return;
        const file = state.files.find((f) => f.id === id);
        if (!file || !state.projectRoot) return;
        try {
          state = await checkpointBeforeDeletion(
            state.projectRoot,
            file.relativePath,
            assertWorkspace,
          );
        } catch (error) {
          log.error("Deletion safeguard failed", { error: String(error) });
          toast.error(`Deletion canceled: ${String(error)}`);
          return;
        }
        if (file) {
          try {
            await deleteFileFromDisk(file.absolutePath);
          } catch (e) {
            log.error("Failed to move file to Trash", { error: String(e) });
            toast.error(`Could not move file to Trash: ${String(e)}`);
            return;
          }
        }
        try {
          assertWorkspace();
        } catch {
          return;
        }
        state = get();
        const newFiles = state.files.filter((f) => f.id !== id);
        const newActiveId =
          state.activeFileId === id
            ? (newFiles[0]?.id ?? "")
            : state.activeFileId;
        const compileErrorCache = new Map(state.compileErrorCache);
        const compileDiagnosticsCache = new Map(state.compileDiagnosticsCache);
        const lastCompiledGenerations = new Map(state.lastCompiledGenerations);
        _pdfBytesCache.delete(id);
        compileErrorCache.delete(id);
        compileDiagnosticsCache.delete(id);
        lastCompiledGenerations.delete(id);
        // If the deleted file was active, show the new active file's cached PDF
        const switchingActive = state.activeFileId === id;
        const newRootId = switchingActive
          ? resolveTexRoot(newActiveId, newFiles)
          : undefined;
        if (switchingActive && newRootId) {
          _currentPdfRootId = _pdfBytesCache.has(newRootId) ? newRootId : null;
        }
        set((s) => {
          const filteredOpen = s.openFileIds.filter((fileId) => fileId !== id);
          const nextOpen = filteredOpen.includes(newActiveId)
            ? filteredOpen
            : newActiveId
              ? [...filteredOpen, newActiveId]
              : filteredOpen;
          return {
            files: newFiles,
            activeFileId: newActiveId,
            openFileIds: nextOpen,
            compileErrorCache,
            compileDiagnosticsCache,
            lastCompiledGenerations,
            ...(switchingActive ? { pdfRevision: s.pdfRevision + 1 } : {}),
            ...(switchingActive && newRootId
              ? {
                  compileError: compileErrorCache.get(newRootId) ?? null,
                }
              : {}),
          };
        });
      });
    } catch (error) {
      log.error("File deletion canceled", { error: String(error) });
      toast.error(`Deletion canceled: ${String(error)}`);
    }
  },

  deleteFolder: async (folderPath) => {
    try {
      await coordinateDocumentMutation(async (assertWorkspace) => {
        let state = get();
        if (state.agentWorkspaceRoot) return;
        if (!state.projectRoot) return;
        const projectRoot = state.projectRoot;
        if (
          state.files.every((file) =>
            file.relativePath.startsWith(`${folderPath}/`),
          )
        )
          return;
        try {
          state = await checkpointBeforeDeletion(
            projectRoot,
            folderPath,
            assertWorkspace,
          );
        } catch (error) {
          log.error("Deletion safeguard failed", { error: String(error) });
          toast.error(`Deletion canceled: ${String(error)}`);
          return;
        }
        const prefix = `${folderPath}/`;
        // Move the whole folder to system Trash.
        try {
          const absPath = await join(projectRoot, folderPath);
          assertWorkspace();
          await deleteFolderFromDisk(absPath);
        } catch (e) {
          log.error("Failed to move folder to Trash", { error: String(e) });
          toast.error(`Could not move folder to Trash: ${String(e)}`);
          return;
        }

        try {
          assertWorkspace();
        } catch {
          return;
        }
        state = get();
        const filesToRemove = state.files.filter((f) =>
          f.relativePath.startsWith(prefix),
        );
        const remainingFiles = state.files.filter(
          (f) => !f.relativePath.startsWith(prefix),
        );
        // Must keep at least one file
        if (remainingFiles.length === 0) return;

        // Clean caches
        const compileErrorCache = new Map(state.compileErrorCache);
        const compileDiagnosticsCache = new Map(state.compileDiagnosticsCache);
        const lastCompiledGenerations = new Map(state.lastCompiledGenerations);
        for (const f of filesToRemove) {
          _pdfBytesCache.delete(f.id);
          compileErrorCache.delete(f.id);
          compileDiagnosticsCache.delete(f.id);
          lastCompiledGenerations.delete(f.id);
        }

        const removedIds = new Set(filesToRemove.map((f) => f.id));
        const newActiveId = removedIds.has(state.activeFileId)
          ? remainingFiles[0].id
          : state.activeFileId;
        const switchingActive = newActiveId !== state.activeFileId;
        const newRootId = switchingActive
          ? resolveTexRoot(newActiveId, remainingFiles)
          : undefined;
        if (switchingActive && newRootId) {
          _currentPdfRootId = _pdfBytesCache.has(newRootId) ? newRootId : null;
        }

        // Remove folder from folders list
        const newFolders = state.folders.filter(
          (f) => f !== folderPath && !f.startsWith(prefix),
        ); // include exact match since folders list contains folder paths directly

        set((s) => {
          const filteredOpen = s.openFileIds.filter(
            (fileId) => !removedIds.has(fileId),
          );
          const nextOpen = filteredOpen.includes(newActiveId)
            ? filteredOpen
            : newActiveId
              ? [...filteredOpen, newActiveId]
              : filteredOpen;
          return {
            files: remainingFiles,
            folders: newFolders,
            activeFileId: newActiveId,
            openFileIds: nextOpen,
            compileErrorCache,
            compileDiagnosticsCache,
            lastCompiledGenerations,
            ...(switchingActive ? { pdfRevision: s.pdfRevision + 1 } : {}),
            ...(switchingActive && newRootId
              ? {
                  compileError: compileErrorCache.get(newRootId) ?? null,
                }
              : {}),
          };
        });
      });
    } catch (error) {
      log.error("File deletion canceled", { error: String(error) });
      toast.error(`Deletion canceled: ${String(error)}`);
    }
  },

  renameFile: async (id, name) => {
    const file = get().files.find((file) => file.id === id);
    if (!file) return;
    const parent = file.relativePath.includes("/")
      ? file.relativePath.slice(0, file.relativePath.lastIndexOf("/"))
      : "";
    try {
      await moveDocumentPath(
        id,
        parent ? `${parent}/${name}` : name,
        false,
        false,
      );
    } catch (error) {
      log.error("Failed to rename file", { error: String(error) });
      toast.error(`Could not rename file: ${String(error)}`);
    }
  },

  renameFolder: async (folderPath, name) => {
    const parent = folderPath.includes("/")
      ? folderPath.slice(0, folderPath.lastIndexOf("/"))
      : "";
    try {
      return (
        (await moveDocumentPath(
          folderPath,
          parent ? `${parent}/${name}` : name,
          true,
          false,
        )) ?? null
      );
    } catch (error) {
      log.error("Failed to rename folder", { error: String(error) });
      toast.error(`Could not rename folder: ${String(error)}`);
      return null;
    }
  },

  updateFileContent: (id, content, base) => {
    content = normalizeDocumentText(content);
    const current = get().files.find((file) => file.id === id)?.content;
    if (current === undefined) return;
    if (base !== undefined)
      content = rebaseDocumentEdit(base, content, current);
    if (current === content) return;
    if (get().isAgentWorkspaceReadOnly || get().isGitOperationRunning) return;
    set((state) => ({
      files: state.files.map((f) =>
        f.id === id
          ? {
              ...f,
              diskContent: f.diskContent ?? f.content,
              content,
              isDirty: true,
            }
          : f,
      ),
      contentGeneration: state.contentGeneration + 1,
    }));
    scheduleAutoSave();
  },

  setThreadOpen: (open) => set({ isThreadOpen: open }),

  setPdfData: (data, rootFileId?, compiledGeneration?, diagnostics = []) => {
    if (data) {
      prepareForNewPdfRevision();
      const key = rootFileId ?? "__default__";
      _pdfBytesCache.set(key, data);
      _currentPdfRootId = key;
    } else if (rootFileId) {
      _pdfBytesCache.delete(rootFileId);
      if (_currentPdfRootId === rootFileId) _currentPdfRootId = null;
    } else {
      _currentPdfRootId = null;
    }
    if (rootFileId) {
      if (data) {
        const s = get();
        const compileErrorCache = new Map(s.compileErrorCache);
        const compileDiagnosticsCache = new Map(s.compileDiagnosticsCache);
        if (diagnostics.length > 0) {
          compileDiagnosticsCache.set(rootFileId, diagnostics);
        } else {
          compileDiagnosticsCache.delete(rootFileId);
        }
        const lastCompiledGenerations = new Map(s.lastCompiledGenerations);
        compileErrorCache.delete(rootFileId);
        lastCompiledGenerations.set(
          rootFileId,
          compiledGeneration ?? s.contentGeneration,
        );
        set((prev) => ({
          pdfRevision: prev.pdfRevision + 1,
          compileError:
            resolveTexRoot(prev.activeFileId, prev.files) === rootFileId
              ? null
              : prev.compileError,
          compileErrorCache,
          compileDiagnosticsCache,
          lastCompiledGenerations,
        }));
      } else {
        set((prev) => ({
          pdfRevision: prev.pdfRevision + 1,
          compileError: null,
        }));
      }
    } else {
      set((prev) => ({
        pdfRevision: prev.pdfRevision + 1,
        compileError: null,
      }));
    }
  },

  setCompileError: (error, rootFileId?, diagnostics = []) => {
    if (rootFileId) {
      const compileErrorCache = new Map(get().compileErrorCache);
      const compileDiagnosticsCache = new Map(get().compileDiagnosticsCache);
      if (error) {
        if (diagnostics.length)
          compileDiagnosticsCache.set(rootFileId, diagnostics);
        else compileDiagnosticsCache.delete(rootFileId);
      }
      if (error) {
        compileErrorCache.set(rootFileId, error);
      } else {
        compileErrorCache.delete(rootFileId);
      }
      set({
        compileError:
          resolveTexRoot(get().activeFileId, get().files) === rootFileId
            ? error
            : get().compileError,
        compileErrorCache,
        compileDiagnosticsCache,
      });
    } else {
      set({ compileError: error });
    }
  },

  setIsCompiling: (isCompiling) => set({ isCompiling }),
  setPendingRecompile: (pending) => set({ pendingRecompile: pending }),

  setIsSaving: (isSaving) => set({ isSaving }),

  setCursorPosition: (position) =>
    set({ cursorPosition: position, outlineScrollPosition: null }),

  insertAtCursor: (text) => {
    text = normalizeDocumentText(text);
    const state = get();
    if (
      state.isApplyingAgentDraft ||
      state.isAgentWorkspaceReadOnly ||
      state.isGitOperationRunning
    )
      return;
    const activeFile = getActiveFile(state);
    if (!activeFile || activeFile.type === "image" || activeFile.type === "pdf")
      return;

    const content = activeFile.content ?? "";
    const { cursorPosition } = state;
    const newContent =
      content.slice(0, cursorPosition) + text + content.slice(cursorPosition);

    set({
      files: state.files.map((f) =>
        f.id === activeFile.id
          ? {
              ...f,
              diskContent: f.diskContent ?? f.content,
              content: newContent,
              isDirty: true,
            }
          : f,
      ),
      cursorPosition: cursorPosition + text.length,
    });
  },

  replaceSelection: (start, end, text) => {
    text = normalizeDocumentText(text);
    const state = get();
    if (
      state.isApplyingAgentDraft ||
      state.isAgentWorkspaceReadOnly ||
      state.isGitOperationRunning
    )
      return;
    const activeFile = getActiveFile(state);
    if (!activeFile || activeFile.type === "image" || activeFile.type === "pdf")
      return;

    const content = activeFile.content ?? "";
    const newContent = content.slice(0, start) + text + content.slice(end);

    set({
      files: state.files.map((f) =>
        f.id === activeFile.id
          ? {
              ...f,
              diskContent: f.diskContent ?? f.content,
              content: newContent,
              isDirty: true,
            }
          : f,
      ),
      cursorPosition: start + text.length,
    });
  },

  findAndReplace: (find, replace) => {
    find = normalizeDocumentText(find);
    replace = normalizeDocumentText(replace);
    const state = get();
    if (state.isAgentWorkspaceReadOnly || state.isGitOperationRunning)
      return false;
    const activeFile = getActiveFile(state);
    if (!activeFile || activeFile.type === "image" || activeFile.type === "pdf")
      return false;

    const content = activeFile.content ?? "";
    if (!content.includes(find)) return false;

    const newContent = content.replace(find, replace);
    set({
      files: state.files.map((f) =>
        f.id === activeFile.id
          ? {
              ...f,
              diskContent: f.diskContent ?? f.content,
              content: newContent,
              isDirty: true,
            }
          : f,
      ),
    });
    return true;
  },

  setInitialized: () => set({ initialized: true }),

  saveFile: async (id) => {
    if (mutatingDocumentPath) {
      // The requested id may change while waiting for a rename. Flush the
      // current buffers after publication instead of writing an obsolete path.
      await saveDocumentFiles();
      return;
    }
    const state = get();
    if (
      state.isApplyingAgentDraft ||
      state.isAgentWorkspaceReadOnly ||
      state.agentWorkspaceRoot ||
      state.isGitOperationRunning
    )
      return;
    const file = state.files.find((f) => f.id === id);
    if (!file || !file.isDirty || file.content == null) return;
    await persistDocumentFile(file);
    await finishCommentSave(state.projectRoot);
  },

  saveAllFiles: (options) => saveDocumentFiles(options),

  runGitOperation: async (projectRoot, options, operation) => {
    const { assertGitReviewFinished } = await import(
      "./proposed-changes-store"
    );
    const assertProject = () => {
      assertGitReviewFinished();
      const state = get();
      if (
        state.projectRoot !== projectRoot ||
        state.agentWorkspaceRoot ||
        state.isAgentWorkspaceReadOnly
      ) {
        throw new Error(
          "The project changed. Reopen the Git action and try again.",
        );
      }
    };
    assertProject();
    if (mutatingDocumentPath)
      throw new Error(
        "A file operation is still running. Try again when it finishes.",
      );
    if (get().isGitOperationRunning)
      throw new Error("Another Git operation is still running.");
    gitOperationGeneration += 1;
    set({ isGitOperationRunning: true });
    cancelAutoSave();
    try {
      // Drain writes already in flight before saving or discarding buffers.
      await Promise.allSettled([...pendingFileSaves.values()]);
      assertProject();
      const discard = new Set(options.discardFiles ?? []);
      const selected = options.saveFiles ? new Set(options.saveFiles) : null;
      const filesToSave = get().files.filter(
        (file) =>
          file.isDirty &&
          (options.history?.before ||
            (!discard.has(file.id) && (!selected || selected.has(file.id)))),
      );
      const results = await Promise.allSettled(
        filesToSave.map((file) =>
          file.content == null
            ? Promise.reject(new Error("File content is not loaded"))
            : persistDocumentFile(file),
        ),
      );
      const failures = results.flatMap((result, index) =>
        result.status === "rejected" ? [filesToSave[index].relativePath] : [],
      );
      if (failures.length)
        throw new Error(
          `Could not save ${failures.join(", ")}. Git operation canceled.`,
        );
      assertProject();
      if (options.history) {
        await useHistoryStore.getState().init(projectRoot);
        if (options.history.before) {
          await useHistoryStore
            .getState()
            .createSnapshot(
              projectRoot,
              `[git] Before ${options.history.label}`,
            );
        }
        assertProject();
      }
      const checkpointResult = async () => {
        if (!options.history) return;
        try {
          await useHistoryStore
            .getState()
            .createSnapshot(
              projectRoot,
              `[git] After ${options.history.label}`,
            );
        } catch (error) {
          log.error("Git result checkpoint failed", { error: String(error) });
          toast.warning(
            "The Git action ran, but its local history checkpoint could not be saved.",
          );
        }
      };
      let result;
      try {
        result = await operation();
        if (
          result &&
          typeof result === "object" &&
          "commentWarning" in result &&
          result.commentWarning
        )
          toast.warning(
            `Git completed. Comment tracking needs attention: ${String(result.commentWarning)}`,
          );
      } catch (error) {
        gitOperationGeneration += 1;
        await checkpointResult();
        // Git may refuse checkout or partially change the worktree. Keep dirty
        // buffers on failure, and preserve the original Git error if refresh fails.
        if (get().projectRoot === projectRoot)
          await get()
            .refreshFiles()
            .catch(() => {});
        throw error;
      }
      await checkpointResult();
      gitOperationGeneration += 1;
      if (get().projectRoot === projectRoot && !get().agentWorkspaceRoot) {
        // Reset has succeeded: remove discarded buffers before scanning, including
        // deleted/untracked files. Even a failed read must not revive their autosave.
        if (discard.size)
          set((state) => ({
            files: state.files.filter((file) => !discard.has(file.id)),
          }));
        await get().refreshFiles();
      }
      return result;
    } finally {
      set({ isGitOperationRunning: false });
      if (get().files.some((file) => file.isDirty)) scheduleAutoSave();
    }
  },

  saveCurrentFile: async () => {
    const state = get();
    await state.saveFile(state.activeFileId);
    // Manual save → immediate snapshot
    if (state.projectRoot) {
      try {
        await useHistoryStore
          .getState()
          .createSnapshot(state.projectRoot, "[manual] Save");
      } catch {
        // Snapshot failure should not break save
      }
    }
  },

  openProjectInstructionFile: async (fileName) => {
    const state = get();
    const existing = state.files.find((file) => file.relativePath === fileName);
    if (existing) {
      state.setActiveFile(existing.id);
      return;
    }
    const root = state.projectRoot;
    if (
      !root ||
      state.agentWorkspaceRoot ||
      state.isApplyingAgentDraft ||
      state.isAgentWorkspaceReadOnly ||
      state.isGitOperationRunning
    )
      return;
    const generation = workspaceGeneration;
    const stillSourceWorkspace = () => {
      const current = get();
      return (
        generation === workspaceGeneration &&
        current.projectRoot === root &&
        !current.agentWorkspaceRoot &&
        !current.isApplyingAgentDraft &&
        !current.isAgentWorkspaceReadOnly &&
        !current.isGitOperationRunning
      );
    };
    const absolutePath = await join(root, fileName);
    if (!stillSourceWorkspace()) return;
    // An instruction file may have appeared since the missing row rendered.
    // Creating against a missing baseline preserves that version rather than
    // truncating it, and returns its text to the ordinary project editor.
    const result = await invoke<{
      written: boolean;
      current: string | null;
      commentWarning?: string;
    }>("save_file_if_unchanged", {
      projectRoot: root,
      filePath: fileName,
      expected: null,
      content: "",
    });
    if (result.commentWarning) toast.warning(result.commentWarning);
    if (!stillSourceWorkspace()) return;
    if (result.current === null)
      throw new Error("The instruction file could not be created.");
    const content = result.current;
    set((current) => ({
      files: current.files.some((file) => file.relativePath === fileName)
        ? current.files
        : [
            ...current.files,
            {
              id: fileName,
              name: fileName,
              relativePath: fileName,
              absolutePath,
              type: "other",
              content: normalizeDocumentText(content),
              diskContent: content,
              isDirty: false,
            },
          ],
    }));
    get().setActiveFile(fileName);
  },

  createNewFile: async (name, type, folder) => {
    const state = get();
    if (!state.projectRoot || state.agentWorkspaceRoot) return;

    const relativePath = folder ? `${folder}/${name}` : name;
    const isTexFile = name.endsWith(".tex") || name.endsWith(".ltx");
    const content = isTexFile
      ? `\\documentclass{article}\n\n\\begin{document}\n\n% Your content here\n\n\\end{document}\n`
      : "";

    const fullPath = await createFileOnDisk(
      state.projectRoot,
      relativePath,
      content,
    );

    set((s) => ({
      files: [
        ...s.files,
        {
          id: relativePath,
          name,
          relativePath,
          absolutePath: fullPath,
          type,
          content: type !== "image" ? content : undefined,
          isDirty: false,
        },
      ],
      activeFileId: relativePath,
      openFileIds: s.openFileIds.includes(relativePath)
        ? s.openFileIds
        : [...s.openFileIds, relativePath],
    }));
  },

  createFolder: async (name, parentFolder) => {
    const state = get();
    if (!state.projectRoot || state.agentWorkspaceRoot) return;

    const relativePath = parentFolder ? `${parentFolder}/${name}` : name;
    const absolutePath = await join(state.projectRoot, relativePath);
    await createDirectory(absolutePath);
    set((s) => ({
      folders: [...s.folders, relativePath],
    }));
  },

  importFiles: async (sourcePaths, targetFolder) => {
    const state = get();
    if (!state.projectRoot || state.agentWorkspaceRoot) return [];

    const importedPaths: string[] = [];
    for (const sourcePath of sourcePaths) {
      // Handle both Unix (/) and Windows (\) path separators
      const fileName = sourcePath.split(/[/\\]/).pop() || sourcePath;
      const targetName = targetFolder
        ? `${targetFolder}/${fileName}`
        : fileName;
      // copyFileToProject returns the actual (possibly deduplicated) relative path
      const actualName = await copyFileToProject(
        state.projectRoot,
        sourcePath,
        targetName,
      );
      importedPaths.push(actualName);
    }
    await state.refreshFiles();
    return importedPaths;
  },

  moveFile: async (fileId, targetFolder) => {
    const state = get();
    const file = state.files.find((item) => item.id === fileId);
    if (!file) return;
    const desiredPath = targetFolder
      ? `${targetFolder}/${file.name}`
      : file.name;
    if (desiredPath === fileId) return;
    return moveDocumentPath(fileId, desiredPath, false);
  },

  moveFolder: async (folderPath, targetFolder) => {
    if (!get().folders.includes(folderPath)) return;
    const name = folderPath.split("/").pop()!;
    const desiredPath = targetFolder ? `${targetFolder}/${name}` : name;
    if (
      desiredPath === folderPath ||
      isPathInsideFolder(desiredPath, folderPath)
    )
      return;
    return moveDocumentPath(folderPath, desiredPath, true);
  },

  reloadFile: async (relativePath) => {
    const state = get();
    const file = state.files.find((f) => f.relativePath === relativePath);
    if (!file) return;

    if (
      file.type === "tex" ||
      file.type === "csv" ||
      file.type === "bib" ||
      file.type === "style" ||
      file.type === "other"
    ) {
      const content = await readTexFileContent(file.absolutePath);
      // A slow read must not replace edits, a reopened file, or another
      // project's same-named document that arrived while it was in flight.
      const current = get();
      if (
        current.projectRoot !== state.projectRoot ||
        current.agentWorkspaceRoot !== state.agentWorkspaceRoot ||
        current.files.find((candidate) => candidate.id === file.id) !== file
      )
        return;
      set((s) => ({
        files: s.files.map((f) =>
          f.id === file.id
            ? {
                ...f,
                content: normalizeDocumentText(content),
                diskContent: content,
                isDirty: false,
                externalChange: undefined,
              }
            : f,
        ),
        contentGeneration: s.contentGeneration + 1,
      }));
    }
  },

  refreshExternalFiles: async (paths, rescan = false) => {
    const start = get();
    const root = start.projectRoot;
    if (
      !root ||
      mutatingDocumentPath ||
      start.agentWorkspaceRoot ||
      start.isGitOperationRunning
    )
      return;
    const generation = gitOperationGeneration;
    const selected = paths ? new Set(paths) : null;
    const tree = rescan ? await scanProjectFolder(root) : null;
    const diskPaths = tree
      ? new Set(tree.files.map((file) => file.relativePath))
      : null;
    const initialFiles = new Map(
      start.files.map((file) => [file.relativePath, file]),
    );
    const observed = new Map<string, string | null>();
    const images = new Map<string, string>();
    const pdfTimes = new Map<string, number>();
    // Wait for our own writes before reading their notifications.
    await Promise.allSettled([...pendingFileSaves.values()]);
    await Promise.all(
      start.files
        .filter(
          (file) =>
            !selected ||
            selected.has(file.relativePath) ||
            (diskPaths && !diskPaths.has(file.relativePath)),
        )
        .map(async (file) => {
          try {
            if (!(await exists(file.absolutePath))) {
              observed.set(file.relativePath, null);
            } else if (file.content !== undefined && !file.isBinary) {
              observed.set(
                file.relativePath,
                await readTexFileContent(file.absolutePath),
              );
            } else if (file.type === "image" && file.dataUrl) {
              images.set(
                file.relativePath,
                await readImageAsDataUrl(file.absolutePath),
              );
            } else if (file.type === "pdf") {
              const info = await stat(file.absolutePath);
              pdfTimes.set(file.relativePath, info.mtime?.getTime() ?? 0);
            }
          } catch (error) {
            // A locked or partially replaced file is not evidence of deletion.
            log.debug("External file read deferred", {
              path: file.relativePath,
              error: String(error),
            });
          }
        }),
    );
    const latest = get();
    if (
      latest.projectRoot !== root ||
      latest.agentWorkspaceRoot ||
      latest.isGitOperationRunning ||
      generation !== gitOperationGeneration
    )
      return;
    set((state) => {
      let files = state.files.flatMap((file) => {
        if (observed.has(file.relativePath)) {
          const disk = observed.get(file.relativePath)!;
          const initial = initialFiles.get(file.relativePath);
          if (
            initial &&
            (initial.diskContent ?? initial.content) !==
              (file.diskContent ?? file.content) &&
            disk !== file.diskContent
          )
            return [file];
          if (
            disk === null &&
            !file.isDirty &&
            (!state.openFileIds.includes(file.id) || file.content === undefined)
          )
            return [];
          return [reconcileFile(file, disk)];
        }
        const diskModifiedAt = pdfTimes.get(file.relativePath);
        if (
          diskModifiedAt !== undefined &&
          diskModifiedAt !== file.diskModifiedAt
        )
          return [{ ...file, diskModifiedAt }];
        const dataUrl = images.get(file.relativePath);
        return [
          dataUrl && dataUrl !== file.dataUrl ? { ...file, dataUrl } : file,
        ];
      });
      if (tree) {
        const known = new Set(files.map((file) => file.relativePath));
        files = [
          ...files,
          ...tree.files
            .filter((file) => !known.has(file.relativePath))
            .map((file) => ({
              ...file,
              id: file.relativePath,
              name: file.relativePath.split("/").pop()!,
              isDirty: false,
            })),
        ];
      }
      const changed =
        files.length !== state.files.length ||
        files.some((file, index) => file !== state.files[index]);
      return {
        files: changed ? files : state.files,
        openFileIds: state.openFileIds.filter((id) =>
          files.some((file) => file.id === id),
        ),
        activeFileId: files.some((file) => file.id === state.activeFileId)
          ? state.activeFileId
          : (files[0]?.id ?? ""),
        folders: tree?.folders ?? state.folders,
        contentGeneration: state.contentGeneration + Number(changed),
      };
    });
  },

  resolveExternalFile: async (id, changeId, content) => {
    const state = get();
    const file = state.files.find((item) => item.id === id);
    const conflict = file?.externalChange;
    if (
      !state.projectRoot ||
      !file ||
      !conflict ||
      conflict.id !== changeId ||
      state.agentWorkspaceRoot ||
      state.isGitOperationRunning
    )
      throw new Error("The file changed again. Review its latest version.");
    if (content === null) {
      if (await exists(file.absolutePath)) {
        await get().refreshExternalFiles([id]);
        throw new Error("The file has reappeared. Review its latest version.");
      }
      if (
        get().projectRoot !== state.projectRoot ||
        get().files.find((item) => item.id === id) !== file
      )
        throw new Error("The file changed during review.");
      set((current) => ({
        files: current.files.filter((item) => item.id !== id),
        openFileIds: current.openFileIds.filter((item) => item !== id),
        activeFileId:
          current.activeFileId === id
            ? (current.files.find((item) => item.id !== id)?.id ?? "")
            : current.activeFileId,
      }));
      return;
    }
    content = normalizeDocumentText(content);
    const diskText = encodeDocumentText(
      content,
      conflict.disk ?? file.diskContent ?? "",
    );
    const result = await invoke<{
      written: boolean;
      current: string | null;
      commentWarning?: string;
    }>("save_file_if_unchanged", {
      projectRoot: state.projectRoot,
      filePath: file.relativePath,
      expected: conflict.disk,
      content: diskText,
    });
    if (result.commentWarning)
      toast.error(
        `File saved. Comment tracking needs attention: ${result.commentWarning}`,
      );
    if (get().projectRoot !== state.projectRoot) return;
    if (!result.written && result.current !== diskText) {
      set((current) => ({
        files: current.files.map((item) =>
          item.id === id ? reconcileFile(item, result.current) : item,
        ),
      }));
      throw new Error(
        "The file changed again on disk. Your edits are still preserved; review the latest version.",
      );
    }
    set((current) => ({
      files: current.files.map((item) =>
        item.id === id
          ? {
              ...item,
              content: item.content === file.content ? content : item.content,
              diskContent: diskText,
              isDirty: item.content !== file.content,
              externalChange: undefined,
            }
          : item,
      ),
      contentGeneration: current.contentGeneration + 1,
    }));
  },

  refreshFiles: async (options) => {
    if (mutatingDocumentPath) return;
    const generation = gitOperationGeneration;
    const {
      projectRoot,
      agentWorkspaceRoot,
      files,
      activeFileId,
      sourceViewSnapshot,
    } = get();
    if (!projectRoot) return;
    const scanRoot = agentWorkspaceRoot ?? projectRoot;

    const { files: fsFiles, folders: fsFolders } =
      await scanProjectFolder(scanRoot);
    const existingMap = new Map(files.map((f) => [f.relativePath, f]));
    const diskPaths = new Set(fsFiles.map((f) => f.relativePath));

    const merged: ProjectFile[] = [];

    for (const fsFile of fsFiles) {
      const existing = existingMap.get(fsFile.relativePath);

      if (existing) {
        // Existing file — reload content from disk unless the user has unsaved edits
        if (existing.isDirty) {
          merged.push(existing);
        } else {
          const updated = { ...existing, fileSize: fsFile.fileSize };
          if (
            updated.type === "tex" ||
            updated.type === "csv" ||
            updated.type === "bib" ||
            updated.type === "style" ||
            updated.type === "other"
          ) {
            const isLargeNonEssential =
              (updated.type === "csv" || updated.type === "other") &&
              fsFile.fileSize > LARGE_FILE_THRESHOLD;
            // Only reload if it was previously loaded (not a skipped large file)
            if (!isLargeNonEssential || updated.content !== undefined) {
              try {
                updated.diskContent = await readTexFileContent(
                  updated.absolutePath,
                );
                updated.content = normalizeDocumentText(updated.diskContent);
              } catch {
                /* keep previous content */
              }
            }
          }
          merged.push(updated);
        }
      } else {
        // New file on disk
        const pf: ProjectFile = {
          id: fsFile.relativePath,
          name: fsFile.relativePath.split(/[/\\]/).pop() || fsFile.relativePath,
          relativePath: fsFile.relativePath,
          absolutePath: fsFile.absolutePath,
          type: fsFile.type,
          isDirty: false,
          fileSize: fsFile.fileSize,
        };
        const isLargeNonEssential =
          (pf.type === "csv" || pf.type === "other") &&
          fsFile.fileSize > LARGE_FILE_THRESHOLD;
        if (
          pf.type === "tex" ||
          pf.type === "bib" ||
          pf.type === "style" ||
          ((pf.type === "csv" || pf.type === "other") && !isLargeNonEssential)
        ) {
          try {
            pf.diskContent = await readTexFileContent(pf.absolutePath);
            pf.content = normalizeDocumentText(pf.diskContent);
          } catch {
            /* skip unreadable */
          }
        } else if (
          pf.type === "image" &&
          fsFile.fileSize <= LARGE_FILE_THRESHOLD
        ) {
          try {
            pf.dataUrl = await readImageAsDataUrl(pf.absolutePath);
          } catch {
            /* skip unreadable */
          }
        }
        // PDF files and large files are loaded on-demand
        merged.push(pf);
      }
    }

    // Some unresolved files are absent from disk or filtered by the normal
    // scanner (for example .bin). Preserve their tabs on a failed Git action so
    // the file's conflict UI and error remain available for retry.
    const missingCleanFiles = files.filter(
      (file) => !diskPaths.has(file.relativePath) && !file.isDirty,
    );
    if (!agentWorkspaceRoot && missingCleanFiles.length > 0) {
      try {
        const overview = await invoke<{
          files: Array<{ document_path: string | null }>;
        }>("git_panel_conflicts", { projectRoot });
        const unresolved = new Set(
          overview.files.map((file) => file.document_path),
        );
        for (const file of missingCleanFiles) {
          if (!unresolved.has(file.relativePath)) continue;
          merged.push(file);
          const parts = file.relativePath.split("/");
          for (let i = 1; i < parts.length; i++) {
            const folder = parts.slice(0, i).join("/");
            if (!fsFolders.includes(folder)) fsFolders.push(folder);
          }
        }
      } catch {
        /* A repository without conflict data uses normal file refresh. */
      }
    }

    // A draft may delete a file or contain formats hidden by the normal scanner.
    // Keep those review entries reachable until the transaction settles.
    if (agentWorkspaceRoot) {
      const { useProposedChangesStore } = await import(
        "./proposed-changes-store"
      );
      const review = useProposedChangesStore.getState().workspaceReview;
      if (review?.session.sessionId === get().agentWorkspaceSessionId) {
        for (const file of files) {
          if (
            !diskPaths.has(file.relativePath) &&
            !file.isDirty &&
            review.originalChanges.some(
              (change) => change.filePath === file.relativePath,
            )
          ) {
            merged.push(file);
            const parts = file.relativePath.split("/");
            for (let index = 1; index < parts.length; index++) {
              const folder = parts.slice(0, index).join("/");
              if (!fsFolders.includes(folder)) fsFolders.push(folder);
            }
          }
        }
      }
    }

    // Keep dirty files that were deleted from disk (user hasn't saved yet)
    for (const f of files) {
      if (!diskPaths.has(f.relativePath) && f.isDirty) {
        merged.push(f);
      }
    }

    const newActiveId = merged.some((f) => f.id === activeFileId)
      ? activeFileId
      : (merged[0]?.id ?? "");

    const latest = get();
    if (
      generation !== gitOperationGeneration ||
      latest.projectRoot !== projectRoot ||
      latest.agentWorkspaceRoot !== agentWorkspaceRoot
    ) {
      return;
    }

    set((s) => {
      // Reading disk yields. Preserve typing, completed saves, and conflicts
      // observed after the scan began, including newly dirty missing files.
      const mergedIndices = new Map(
        merged.map((file, index) => [file.relativePath, index]),
      );
      for (const current of s.files) {
        const before = existingMap.get(current.relativePath);
        if (
          current.isDirty ||
          current.externalChange ||
          (before &&
            (current.content !== before.content ||
              current.diskContent !== before.diskContent))
        ) {
          const index = mergedIndices.get(current.relativePath);
          if (index === undefined) {
            mergedIndices.set(current.relativePath, merged.length);
            merged.push(current);
          } else merged[index] = current;
        }
      }
      // Settlement briefly scans source before reopening the remaining draft.
      // A pending added/renamed file may exist only in that draft. Retain a
      // selection made during this scan until the draft is restored.
      const pendingReviewPaths = new Set(options?.pendingReviewPaths);
      const active =
        merged.some((file) => file.id === s.activeFileId) ||
        pendingReviewPaths.has(s.activeFileId)
          ? s.activeFileId
          : newActiveId;
      const filteredOpen = s.openFileIds.filter(
        (id) => merged.some((f) => f.id === id) || pendingReviewPaths.has(id),
      );
      return {
        ...(!agentWorkspaceRoot &&
        sourceViewSnapshot &&
        s.sourceViewSnapshot === sourceViewSnapshot
          ? { sourceViewSnapshot: null, isAgentWorkspaceReadOnly: false }
          : {}),
        files: merged,
        folders: fsFolders,
        activeFileId: active,
        openFileIds: filteredOpen.includes(active)
          ? filteredOpen
          : active
            ? [...filteredOpen, active]
            : filteredOpen,
        contentGeneration: s.contentGeneration + 1,
      };
    });
    if (!agentWorkspaceRoot) await finishCommentSave(projectRoot);
  },

  activateAgentWorkspace: async (sessionId, candidateRoot) => {
    const activation = ++agentWorkspaceActivation;
    const state = get();
    if (!state.projectRoot) return;
    const sourceViewSnapshot = state.sourceViewSnapshot ?? {
      files: state.files.map((file) => ({ ...file })),
      folders: [...state.folders],
      activeFileId: state.activeFileId,
      openFileIds: [...state.openFileIds],
      pdfBytesCache: new Map(_pdfBytesCache),
      currentPdfRootId: _currentPdfRootId,
      compileError: state.compileError,
      compileErrorCache: new Map(state.compileErrorCache),
      compileDiagnosticsCache: new Map(state.compileDiagnosticsCache),
      lastCompiledGenerations: new Map(state.lastCompiledGenerations),
    };
    const { files, folders } = await loadProjectTree(candidateRoot);
    if (
      activation !== agentWorkspaceActivation ||
      get().projectRoot !== state.projectRoot
    )
      return;
    const current = get();
    const activeFileId = files.some((file) => file.id === current.activeFileId)
      ? current.activeFileId
      : (pickDefaultOpenFile(files)?.id ?? files[0]?.id ?? "");
    const openFileIds = current.openFileIds.filter((id) =>
      files.some((file) => file.id === id),
    );
    if (activeFileId && !openFileIds.includes(activeFileId)) {
      openFileIds.push(activeFileId);
    }
    set({
      agentWorkspaceSessionId: sessionId,
      agentWorkspaceRoot: candidateRoot,
      isAgentWorkspaceReadOnly: true,
      sourceViewSnapshot,
      files,
      folders,
      activeFileId,
      openFileIds,
      contentGeneration: state.contentGeneration + 1,
    });
  },

  restoreRecoveredDirtyBuffers: async (buffers) => {
    const state = get();
    if (
      !state.projectRoot ||
      state.agentWorkspaceRoot ||
      buffers.length === 0
    ) {
      return;
    }
    const projectRoot = state.projectRoot;
    const files = [...state.files];
    const folders = new Set(state.folders);
    for (const buffer of buffers) {
      const relativePath = buffer.relativePath.replace(/\\/g, "/");
      const index = files.findIndex(
        (file) => file.relativePath === relativePath,
      );
      if (index >= 0) {
        files[index] = {
          ...files[index],
          diskContent: files[index].diskContent ?? files[index].content,
          content: normalizeDocumentText(buffer.content),
          isDirty: true,
        };
        continue;
      }
      const pathParts = relativePath.split("/");
      pathParts.pop();
      for (let length = 1; length <= pathParts.length; length += 1) {
        folders.add(pathParts.slice(0, length).join("/"));
      }
      files.push({
        id: relativePath,
        name: relativePath.split("/").pop() || relativePath,
        relativePath,
        absolutePath: await join(projectRoot, relativePath),
        type: editableFileType(relativePath),
        content: normalizeDocumentText(buffer.content),
        isDirty: true,
      });
    }
    if (get().projectRoot !== projectRoot || get().agentWorkspaceRoot) return;
    set((current) => ({
      files,
      folders: [...folders].sort(),
      activeFileId: current.activeFileId || files[0]?.id || "",
      openFileIds:
        current.openFileIds.length > 0
          ? current.openFileIds
          : files[0]
            ? [files[0].id]
            : [],
      contentGeneration: current.contentGeneration + 1,
    }));
  },

  addAgentWorkspaceReviewFiles: async (changes) => {
    const state = get();
    if (!state.agentWorkspaceRoot) return;
    const additions: ProjectFile[] = [];
    for (const change of changes) {
      if (state.files.some((file) => file.relativePath === change.filePath)) {
        continue;
      }
      additions.push({
        id: change.filePath,
        name: change.filePath.split(/[/\\]/).pop() || change.filePath,
        relativePath: change.filePath,
        absolutePath:
          change.candidateAbsolutePath ??
          (await join(state.agentWorkspaceRoot, change.filePath)),
        type: getFileType(change.filePath) ?? "other",
        isBinary: change.binary,
        ...(change.binary
          ? {}
          : {
              content: normalizeDocumentText(
                change.oldContent ?? change.newContent ?? "",
              ),
            }),
        isDirty: false,
      });
    }
    set((current) => ({
      files: [
        ...current.files.map((file) => {
          const change = changes.find(
            (item) => item.filePath === file.relativePath,
          );
          return change?.binary
            ? { ...file, isBinary: true, content: undefined }
            : file;
        }),
        ...additions,
      ],
      folders: [
        ...new Set([
          ...current.folders,
          ...additions.flatMap((file) => {
            const parts = file.relativePath.split("/");
            return parts
              .slice(0, -1)
              .map((_, index) => parts.slice(0, index + 1).join("/"));
          }),
        ]),
      ],
      openFileIds:
        current.openFileIds.length > 0
          ? current.openFileIds
          : additions.length
            ? [additions[0].id]
            : [],
      activeFileId: current.activeFileId || additions[0]?.id || "",
    }));
  },

  setAgentWorkspaceReadOnly: (readOnly) => {
    if (!get().agentWorkspaceRoot) return;
    set({ isAgentWorkspaceReadOnly: readOnly });
  },

  restoreSourceWorkspace: async (appliedPaths = [], options) => {
    ++agentWorkspaceActivation;
    const state = get();
    if (!state.projectRoot) return;
    const applied = new Set(
      appliedPaths.map((path) => path.replace(/\\/g, "/")),
    );
    const snapshot = state.sourceViewSnapshot;
    if (snapshot) {
      _pdfBytesCache.clear();
      for (const [rootId, bytes] of snapshot.pdfBytesCache) {
        _pdfBytesCache.set(rootId, bytes);
      }
      const rootId = resolveTexRoot(state.activeFileId, snapshot.files);
      _currentPdfRootId = options?.preserveSelection
        ? _pdfBytesCache.has(rootId)
          ? rootId
          : null
        : snapshot.currentPdfRootId;
    }
    set({
      agentWorkspaceSessionId: null,
      agentWorkspaceRoot: null,
      // Keep the old source snapshot read-only until fresh disk text is
      // installed. Comment refresh can continue after editing is enabled.
      isAgentWorkspaceReadOnly: Boolean(snapshot),
      sourceViewSnapshot: snapshot,
      ...(snapshot
        ? {
            files: snapshot.files.map((file) =>
              applied.has(file.relativePath.replace(/\\/g, "/"))
                ? { ...file, isDirty: false }
                : file,
            ),
            folders: snapshot.folders,
            // Review settlement keeps the current file and tabs, including
            // navigation made while the decision was being applied.
            activeFileId: options?.preserveSelection
              ? state.activeFileId
              : snapshot.activeFileId,
            openFileIds: options?.preserveSelection
              ? state.openFileIds
              : snapshot.openFileIds,
            pdfRevision: state.pdfRevision + 1,
            compileError: options?.preserveSelection
              ? (snapshot.compileErrorCache.get(
                  resolveTexRoot(state.activeFileId, snapshot.files),
                ) ?? null)
              : snapshot.compileError,
            compileErrorCache: snapshot.compileErrorCache,
            compileDiagnosticsCache: snapshot.compileDiagnosticsCache,
            lastCompiledGenerations: snapshot.lastCompiledGenerations,
          }
        : {}),
    });
    try {
      await get().refreshFiles({
        pendingReviewPaths: options?.pendingReviewPaths,
      });
    } finally {
      if (
        snapshot &&
        get().projectRoot === state.projectRoot &&
        !get().agentWorkspaceRoot &&
        get().sourceViewSnapshot === snapshot
      )
        set({ sourceViewSnapshot: null, isAgentWorkspaceReadOnly: false });
    }
  },

  loadFileContent: async (id) => {
    const state = get();
    const file = state.files.find((f) => f.id === id);
    if (!file || file.content !== undefined) return; // already loaded
    try {
      const content = await readTexFileContent(file.absolutePath);
      set((s) => ({
        files: s.files.map((f) =>
          f.absolutePath === file.absolutePath &&
          f.content === undefined &&
          !f.isDirty
            ? {
                ...f,
                content: normalizeDocumentText(content),
                diskContent: content,
              }
            : f,
        ),
      }));
    } catch {
      set((s) => ({
        files: s.files.map((f) => (f.id === id ? { ...f, content: "" } : f)),
      }));
    }
  },

  get fileName() {
    const activeFile = getActiveFile(get());
    return activeFile?.name ?? "main.tex";
  },

  get content() {
    const activeFile = getActiveFile(get());
    return activeFile?.content ?? "";
  },

  setFileName: (name) => {
    const state = get();
    set({
      files: state.files.map((f) =>
        f.id === state.activeFileId ? { ...f, name } : f,
      ),
    });
  },

  setContent: (content, base) => {
    content = normalizeDocumentText(content);
    const current = getActiveFile(get())?.content ?? "";
    if (base !== undefined)
      content = rebaseDocumentEdit(base, content, current);
    if (current === content) return;
    const state = get();
    if (
      state.isApplyingAgentDraft ||
      state.isAgentWorkspaceReadOnly ||
      state.isGitOperationRunning
    )
      return;
    set({
      files: state.files.map((f) =>
        f.id === state.activeFileId
          ? {
              ...f,
              diskContent: f.diskContent ?? f.content,
              content,
              isDirty: true,
            }
          : f,
      ),
      contentGeneration: state.contentGeneration + 1,
    });
    scheduleAutoSave();
  },
}));

connectPanelDocumentView(useDocumentStore);
storeRef = useDocumentStore;

// Observe transitions rather than comparing root strings: A → B → A is a new
// workspace even when an old disk request still refers to A.
useDocumentStore.subscribe((state, previous) => {
  // Manual prompt visibility lasts for one file visit. Only the owner resets
  // shared chat state; pinned editor/preview windows have local file selections.
  if (
    !getPanelWindowSession() &&
    (state.activeFileId !== previous.activeFileId ||
      state.projectRoot !== previous.projectRoot)
  ) {
    const { tabs } = useAgentChatStore.getState();
    if (tabs.some((tab) => tab.miniPromptsExpanded !== undefined)) {
      useAgentChatStore.setState({
        tabs: tabs.map((tab) =>
          tab.miniPromptsExpanded === undefined
            ? tab
            : { ...tab, miniPromptsExpanded: undefined },
        ),
      });
    }
  }
  if (state.projectRoot && state.projectRoot !== previous.projectRoot) {
    useSettingsStore.getState().initializeProjectAutoCompile(state.projectRoot);
  }
  if (
    state.projectRoot !== previous.projectRoot ||
    state.agentWorkspaceRoot !== previous.agentWorkspaceRoot ||
    state.agentWorkspaceSessionId !== previous.agentWorkspaceSessionId
  ) {
    workspaceGeneration += 1;
    cancelAutoSave();
  }
});
