import { resolveTexRoot, type ProjectFile } from "@/stores/document-store";

const LATEX_SOURCE_INCLUDE_PATTERN =
  /\\(input|include|subfile)\s*(?:\[[^\]]*\]\s*)?\{([^{}]+)\}/g;

const sourceIncludes = new WeakMap<
  ProjectFile,
  { content: string; paths: string[] }
>();

function includedPaths(sourceFile: ProjectFile): string[] {
  const content = sourceFile.content ?? "";
  const cached = sourceIncludes.get(sourceFile);
  if (cached?.content === content) return cached.paths;
  const paths = Array.from(
    stripLatexComments(content).matchAll(LATEX_SOURCE_INCLUDE_PATTERN),
    (match) => match[2],
  );
  // Keep syntax facts per file revision, but resolve paths against the current
  // project below: an unchanged include can gain, lose, or rename its target.
  sourceIncludes.set(sourceFile, { content, paths });
  return paths;
}

function stripLatexComments(content: string): string {
  return content
    .split("\n")
    .map((line) => {
      for (let index = 0; index < line.length; index += 1) {
        if (line[index] !== "%") continue;
        let slashCount = 0;
        for (
          let previous = index - 1;
          previous >= 0 && line[previous] === "\\";
          previous -= 1
        ) {
          slashCount += 1;
        }
        if (slashCount % 2 === 0) return line.slice(0, index);
      }
      return line;
    })
    .join("\n");
}

function normalizeProjectPath(path: string): string | null {
  const parts: string[] = [];
  for (const part of path.replace(/\\/g, "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) return null;
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.join("/");
}

function ensureTexExtension(path: string): string {
  return path.toLowerCase().endsWith(".tex") ? path : `${path}.tex`;
}

function resolveIncludedTexFile(
  rawPath: string,
  sourceFile: ProjectFile,
  files: ProjectFile[],
): ProjectFile | null {
  const trimmed = rawPath.trim();
  if (!trimmed || /[\\#$]/.test(trimmed)) return null;

  const includePath = ensureTexExtension(trimmed);
  const sourceDirectory = sourceFile.relativePath
    .replace(/\\/g, "/")
    .split("/")
    .slice(0, -1)
    .join("/");
  const candidates = [
    normalizeProjectPath(includePath),
    normalizeProjectPath(
      sourceDirectory ? `${sourceDirectory}/${includePath}` : includePath,
    ),
  ].filter((path): path is string => !!path);

  for (const candidatePath of new Set(candidates)) {
    const match = files.find(
      (file) =>
        file.type === "tex" &&
        file.relativePath.replace(/\\/g, "/") === candidatePath,
    );
    if (match) return match;
  }
  return null;
}

function includedTexFiles(sourceFile: ProjectFile, files: ProjectFile[]) {
  if (sourceFile.type !== "tex" || !sourceFile.content) return [];
  const included: ProjectFile[] = [];
  for (const path of includedPaths(sourceFile)) {
    const file = resolveIncludedTexFile(path, sourceFile, files);
    if (file && !included.some((candidate) => candidate.id === file.id)) {
      included.push(file);
    }
  }
  return included;
}

export function latexDocumentFileIds(
  activeFileId: string,
  files: ProjectFile[],
): Set<string> {
  const rootId = resolveTexRoot(activeFileId, files);
  const rootFile = files.find((file) => file.id === rootId);
  if (!rootFile || rootFile.type !== "tex") return new Set();

  const relatedFileIds = new Set<string>();
  const pending = [rootFile];
  while (pending.length > 0) {
    const sourceFile = pending.pop();
    if (!sourceFile || relatedFileIds.has(sourceFile.id)) continue;
    relatedFileIds.add(sourceFile.id);
    for (const includedFile of includedTexFiles(sourceFile, files)) {
      if (!relatedFileIds.has(includedFile.id)) pending.push(includedFile);
    }
  }
  return relatedFileIds;
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
