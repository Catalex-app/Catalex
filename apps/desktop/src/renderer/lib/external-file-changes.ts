import type { ProjectFile } from "@/stores/document-store";
import { normalizeDocumentText } from "./document-text";

/** A disk observation never replaces unsaved text. */
export function reconcileFile(
  file: ProjectFile,
  disk: string | null,
): ProjectFile {
  const content = disk === null ? null : normalizeDocumentText(disk);
  if (disk !== null && content === file.content) {
    if (!file.isDirty && !file.externalChange && file.diskContent === disk)
      return file;
    return {
      ...file,
      diskContent: disk,
      isDirty: false,
      externalChange: undefined,
    };
  }
  const base = file.diskContent ?? file.content ?? "";
  if (
    disk !== null &&
    content === normalizeDocumentText(base) &&
    !file.externalChange
  ) {
    return disk === base ? file : { ...file, diskContent: disk };
  }
  if (disk !== null && !file.isDirty) {
    return {
      ...file,
      content: content!,
      diskContent: disk,
      isDirty: false,
      externalChange: undefined,
    };
  }
  if (disk === base && !file.externalChange) return file;
  if (file.externalChange?.disk === disk) return file;
  return {
    ...file,
    content: file.externalChange?.reviewContent ?? file.content,
    externalChange: {
      id: crypto.randomUUID(),
      base: file.externalChange?.base ?? base,
      disk,
    },
  };
}
