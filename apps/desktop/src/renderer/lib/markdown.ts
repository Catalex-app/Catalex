import type { ProjectFile } from "@/stores/document-store";

const MARKDOWN_EXTENSIONS = [".md", ".markdown", ".mdown", ".mkd", ".mkdn"];

const DIRECT_URL_PATTERN = /^(?:[a-z][a-z\d+.-]*:|\/\/)/i;

export function isMarkdownPath(path: string | null | undefined): boolean {
  if (!path) return false;
  const lower = path.toLowerCase();
  return MARKDOWN_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

export function isMarkdownFile(
  file: Pick<ProjectFile, "relativePath"> | null | undefined,
): boolean {
  return isMarkdownPath(file?.relativePath);
}

function splitUrlSuffix(value: string): { path: string; suffix: string } {
  const suffixIndex = value.search(/[?#]/);
  if (suffixIndex < 0) return { path: value, suffix: "" };
  return {
    path: value.slice(0, suffixIndex),
    suffix: value.slice(suffixIndex),
  };
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

function decodeUrlPath(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

export function resolveMarkdownProjectFile(
  source: string | null | undefined,
  sourceFile: Pick<ProjectFile, "relativePath">,
  files: ProjectFile[],
): { file: ProjectFile; suffix: string } | null {
  const trimmed = source?.trim();
  if (!trimmed || trimmed.startsWith("#") || DIRECT_URL_PATTERN.test(trimmed)) {
    return null;
  }

  const { path, suffix } = splitUrlSuffix(trimmed);
  const decodedPath = decodeUrlPath(path);
  const sourceDirectory = sourceFile.relativePath
    .replace(/\\/g, "/")
    .split("/")
    .slice(0, -1)
    .join("/");
  const combinedPath = decodedPath.startsWith("/")
    ? decodedPath.slice(1)
    : sourceDirectory
      ? `${sourceDirectory}/${decodedPath}`
      : decodedPath;
  const normalized = normalizeProjectPath(combinedPath);
  if (!normalized) return null;

  const file = files.find(
    (candidate) => candidate.relativePath.replace(/\\/g, "/") === normalized,
  );
  return file ? { file, suffix } : null;
}

export function rewriteMarkdownCssAssetUrls(
  css: string,
  cssFile: ProjectFile,
  files: ProjectFile[],
  toAssetUrl: (absolutePath: string) => string,
): string {
  return css.replace(
    /url\(\s*(["']?)([^"')]+)\1\s*\)/gi,
    (match, quote: string, rawSource: string) => {
      const source = rawSource.trim();
      const resolved = resolveMarkdownProjectFile(source, cssFile, files);
      if (!resolved) return match;
      const assetUrl = `${toAssetUrl(resolved.file.absolutePath)}${resolved.suffix}`;
      const safeQuote = quote || '"';
      return `url(${safeQuote}${assetUrl}${safeQuote})`;
    },
  );
}

/** A portable link from the source file's folder, including URL-sensitive names. */
export function markdownFileLink(
  sourcePath: string,
  targetPath: string,
): string | null {
  const normalize = (path: string) => path.replace(/\\/g, "/");
  const source = normalize(sourcePath).split("/").slice(0, -1);
  const target = normalize(targetPath).split("/");
  if (
    /^[a-z]:$/i.test(source[0]) &&
    source[0].toLowerCase() !== target[0]?.toLowerCase()
  )
    return null;
  while (source.length && target.length && source[0] === target[0]) {
    source.shift();
    target.shift();
  }
  const path = [...source.map(() => ".."), ...target]
    .map((part) =>
      encodeURIComponent(part).replace(
        /[!'()*]/g,
        (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
      ),
    )
    .join("/");
  const name = normalize(targetPath)
    .split("/")
    .pop()
    ?.replace(/([\\[\]])/g, "\\$1")
    .replace(/[\r\n]/g, " ");
  return path && name ? `[${name}](${path})` : null;
}
