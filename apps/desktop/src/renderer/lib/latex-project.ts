import { resolveTexRoot, type ProjectFile } from "@/stores/document-store";
import { texIncludeClosure } from "./latex-includes";

export function latexDocumentFileIds(
  activeFileId: string,
  files: ProjectFile[],
): Set<string> {
  const rootId = resolveTexRoot(activeFileId, files);
  const rootFile = files.find((file) => file.id === rootId);
  if (!rootFile || rootFile.type !== "tex") return new Set();

  return texIncludeClosure(rootFile, files);
}

export function shouldMuteLatexScrollSync(
  activeFileId: string,
  files: ProjectFile[],
): boolean {
  const relatedFileIds = latexDocumentFileIds(activeFileId, files);
  return relatedFileIds.size > 1 && relatedFileIds.has(activeFileId);
}

export function isIncludedLatexFile(
  fileId: string,
  files: ProjectFile[],
): boolean {
  const rootId = resolveTexRoot(fileId, files);
  return rootId !== fileId && latexDocumentFileIds(fileId, files).has(fileId);
}
