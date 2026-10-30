import type { ProjectFile } from "@/stores/document-store";

/** Cache one immutable files snapshot, not an accumulating document history. */
export function createFilesSelector<T>(derive: (files: ProjectFile[]) => T) {
  let previousFiles: ProjectFile[] | undefined;
  let result: T;
  return (state: { files: ProjectFile[] }): T => {
    if (state.files !== previousFiles) {
      result = derive(state.files);
      previousFiles = state.files;
    }
    return result;
  };
}

export type FileListEntry = Pick<
  ProjectFile,
  "id" | "name" | "relativePath" | "type" | "isDirty"
>;

/** File lists display metadata; body edits must not invalidate their snapshot. */
export function createFileListSelector() {
  let entries: FileListEntry[] = [];
  return createFilesSelector((files) => {
    const unchanged =
      files.length === entries.length &&
      files.every((file, i) => {
        const previous = entries[i];
        return (
          file.id === previous.id &&
          file.name === previous.name &&
          file.relativePath === previous.relativePath &&
          file.type === previous.type &&
          file.isDirty === previous.isDirty
        );
      });
    if (!unchanged)
      entries = files.map(({ id, name, relativePath, type, isDirty }) => ({
        id,
        name,
        relativePath,
        type,
        isDirty,
      }));
    return entries;
  });
}
