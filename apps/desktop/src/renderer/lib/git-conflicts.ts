import { invoke } from "@/lib/desktop/core";
import { getFileType } from "@/lib/project-files";
import { useDocumentStore } from "@/stores/document-store";

export interface ConflictSide {
  path: string;
  binary: boolean;
  size: number;
  text: string | null;
  preview_url: string | null;
  supported: boolean;
}
export interface ConflictFile {
  path: string;
  document_path: string | null;
  version: string;
  ancestor?: ConflictSide | null;
  current: ConflictSide | null;
  incoming: ConflictSide | null;
}
export interface ConflictOverview {
  rebasing: boolean;
  files: ConflictFile[];
}

/** Advance only after resolution succeeds, without overriding later navigation. */
export async function advanceAfterGitConflictResolution(
  before: {
    projectRoot: string | null;
    fileSelectionRevision: number;
    agentWorkspaceSessionId: string | null;
  },
  resolvedPath: string,
) {
  const selectionIsCurrent = () => {
    const current = useDocumentStore.getState();
    return (
      current.projectRoot === before.projectRoot &&
      current.fileSelectionRevision === before.fileSelectionRevision &&
      current.agentWorkspaceSessionId === before.agentWorkspaceSessionId
    );
  };
  if (!before.projectRoot || !selectionIsCurrent()) return;
  const overview = await invoke<ConflictOverview>("git_panel_conflicts", {
    projectRoot: before.projectRoot,
  }).catch(() => null);
  if (
    !overview ||
    !selectionIsCurrent() ||
    overview.files.some((file) => file.path === resolvedPath)
  )
    return;
  const state = useDocumentStore.getState();
  const next = overview.files
    .map((conflict) =>
      state.files.find(
        (file) =>
          file.relativePath === (conflict.document_path ?? conflict.path),
      ),
    )
    .find(Boolean);
  if (next) state.setActiveFile(next.id);
}

export function isTextEditorConflict(file: ConflictFile) {
  const type = getFileType(file.path);
  return Boolean(
    file.document_path &&
      // An absent ancestor is an add/add conflict. Restoring that version
      // deletes the file, so use the version-guarded whole-file resolver.
      file.ancestor !== null &&
      type &&
      type !== "image" &&
      type !== "pdf" &&
      [file.current, file.incoming].some(Boolean) &&
      [file.ancestor, file.current, file.incoming].every(
        (side) => !side || (side.supported && !side.binary),
      ),
  );
}

// Include conflicted paths in the normal file list even when normally filtered
// out or absent from disk. Loading these entries never writes a working file.
export async function ensureConflictFiles(
  projectRoot: string,
  isCurrent: () => boolean,
) {
  const overview = await invoke<ConflictOverview>("git_panel_conflicts", {
    projectRoot,
  });
  for (const file of overview.files) {
    const path = file.document_path;
    if (!path || !isCurrent()) continue;
    const type = getFileType(file.path);
    const isBinary =
      type !== "image" &&
      type !== "pdf" &&
      [file.current, file.incoming].some((side) => side?.binary);
    let state = useDocumentStore.getState();
    const existing = state.files.find((entry) => entry.id === path);
    if (
      state.projectRoot === projectRoot &&
      !state.agentWorkspaceRoot &&
      existing &&
      isBinary &&
      !existing.isBinary
    ) {
      useDocumentStore.setState({
        files: state.files.map((entry) =>
          entry.id === path ? { ...entry, isBinary: true } : entry,
        ),
      });
    }
    if (
      state.projectRoot !== projectRoot ||
      Boolean(state.agentWorkspaceRoot) ||
      state.files.some((entry) => entry.id === path)
    )
      continue;
    let content: string | undefined;
    if (isTextEditorConflict(file)) {
      const versions = await invoke<{
        current_content: string | null;
        incoming_content: string | null;
      }>("git_conflict_file_content", { projectRoot, filePath: file.path });
      content =
        versions.current_content ?? versions.incoming_content ?? undefined;
    }
    state = useDocumentStore.getState();
    if (
      !isCurrent() ||
      state.projectRoot !== projectRoot ||
      Boolean(state.agentWorkspaceRoot) ||
      state.files.some((entry) => entry.id === path)
    )
      continue;
    const folders = new Set(state.folders);
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++)
      folders.add(parts.slice(0, i).join("/"));
    useDocumentStore.setState({
      files: [
        ...state.files,
        {
          id: path,
          name: parts[parts.length - 1],
          relativePath: path,
          absolutePath: `${projectRoot}/${path}`,
          type: type ?? "other",
          isBinary,
          fileSize: file.current?.size ?? file.incoming?.size,
          content,
          isDirty: false,
        },
      ],
      folders: [...folders].sort(),
    });
  }
}
