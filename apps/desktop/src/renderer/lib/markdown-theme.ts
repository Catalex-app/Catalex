import { configDir } from "@/lib/desktop/path";
import { exists, readDir, readTextFile } from "@/lib/desktop/fs";

const DIRECT_URL_PATTERN = /^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i;

export const GITHUB_LIGHT_MARKDOWN_THEME_ID = "__catalex_github_light__";
export const GITHUB_DARK_MARKDOWN_THEME_ID = "__catalex_github_dark__";
export const LEGACY_GITHUB_MARKDOWN_THEME_ID = "__catalex_github__";
export const EXTERNAL_MARKDOWN_THEME_PREFIX = "__catalex_typora__:";
const TYPORA_CONFIG_DIRECTORY_NAMES = ["abnerworks.Typora", "Typora"];

export interface InstalledMarkdownTheme {
  fileName: string;
  label: string;
  path: string;
}

function pathSeparator(path: string) {
  return path.includes("\\") && !path.includes("/") ? "\\" : "/";
}

export function joinMarkdownThemePath(directory: string, fileName: string) {
  const separator = pathSeparator(directory);
  return `${directory.replace(/[\\/]+$/, "")}${separator}${fileName}`;
}

export function markdownThemeFileName(path: string) {
  return path.replace(/\\/g, "/").split("/").pop() ?? path;
}

export function markdownThemeLabel(fileName: string) {
  return fileName.replace(/\.css$/i, "");
}

export function isBuiltInMarkdownTheme(value: string) {
  return (
    value === GITHUB_LIGHT_MARKDOWN_THEME_ID ||
    value === GITHUB_DARK_MARKDOWN_THEME_ID
  );
}

export function defaultTyporaThemeDirectoryCandidates(configDirectory: string) {
  return TYPORA_CONFIG_DIRECTORY_NAMES.map((directoryName) =>
    joinMarkdownThemePath(
      joinMarkdownThemePath(configDirectory, directoryName),
      "themes",
    ),
  );
}

export async function detectDefaultTyporaThemeDirectory() {
  const configDirectory = await configDir();
  for (const candidate of defaultTyporaThemeDirectoryCandidates(
    configDirectory,
  )) {
    if (await exists(candidate)) return candidate;
  }
  return null;
}

export async function resolveMarkdownThemeDirectory(
  overrideDirectory: string | null,
) {
  return overrideDirectory ?? detectDefaultTyporaThemeDirectory();
}

export function externalMarkdownThemeId(path: string) {
  return `${EXTERNAL_MARKDOWN_THEME_PREFIX}${path}`;
}

export function pathFromExternalMarkdownThemeId(id: string) {
  return id.startsWith(EXTERNAL_MARKDOWN_THEME_PREFIX)
    ? id.slice(EXTERNAL_MARKDOWN_THEME_PREFIX.length)
    : null;
}

export async function listMarkdownThemes(
  directory: string,
): Promise<InstalledMarkdownTheme[]> {
  const entries = await readDir(directory);
  return entries
    .filter(
      (entry) =>
        entry.isFile && entry.name.toLocaleLowerCase().endsWith(".css"),
    )
    .map((entry) => ({
      fileName: entry.name,
      label: markdownThemeLabel(entry.name),
      path: joinMarkdownThemePath(directory, entry.name),
    }))
    .sort((left, right) => left.label.localeCompare(right.label));
}

export async function readMarkdownTheme(path: string) {
  return readTextFile(path);
}

function splitUrlSuffix(value: string): { path: string; suffix: string } {
  const suffixIndex = value.search(/[?#]/);
  if (suffixIndex < 0) return { path: value, suffix: "" };
  return {
    path: value.slice(0, suffixIndex),
    suffix: value.slice(suffixIndex),
  };
}

function normalizeAbsoluteThemeAssetPath(
  cssPath: string,
  relativePath: string,
) {
  const normalizedCssPath = cssPath.replace(/\\/g, "/");
  const driveMatch = normalizedCssPath.match(/^([a-z]:)\//i);
  const rooted = normalizedCssPath.startsWith("/");
  const baseParts = normalizedCssPath.split("/").slice(0, -1);
  const minimumParts = driveMatch || rooted ? 1 : 0;

  for (const part of relativePath.replace(/\\/g, "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (baseParts.length <= minimumParts) return null;
      baseParts.pop();
      continue;
    }
    baseParts.push(part);
  }

  const joined = baseParts.join("/");
  if (rooted) return `/${joined.replace(/^\/+/, "")}`;
  return joined;
}

function decodeUrlPath(path: string) {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

export function rewriteExternalMarkdownThemeAssetUrls(
  css: string,
  cssPath: string,
  toAssetUrl: (absolutePath: string) => string,
) {
  return css.replace(
    /url\(\s*(["']?)([^"')]+)\1\s*\)/gi,
    (match, quote: string, rawSource: string) => {
      const source = rawSource.trim();
      if (
        !source ||
        DIRECT_URL_PATTERN.test(source) ||
        source.startsWith("/") ||
        /^[a-z]:[\\/]/i.test(source)
      ) {
        return match;
      }

      const { path, suffix } = splitUrlSuffix(source);
      const absolutePath = normalizeAbsoluteThemeAssetPath(
        cssPath,
        decodeUrlPath(path),
      );
      if (!absolutePath) return match;
      const safeQuote = quote || '"';
      return `url(${safeQuote}${toAssetUrl(absolutePath)}${suffix}${safeQuote})`;
    },
  );
}
