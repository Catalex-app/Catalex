import type { InlineCommentsByFile } from "./inline-comment-storage";
export interface CommentPathChange {
  oldPath: string;
  newPath: string;
  folder?: boolean;
}
export const COMMENT_PATHS_CHANGED_EVENT = "catalex:comment-paths-changed";
const paths = new Map<string, Map<string, string>>();
const detached = new Map<string, Set<string>>();
export function detachComments(root: string, ids: string[]) {
  detached.set(root, new Set(ids));
}
export function isCommentDetached(root: string, id: string) {
  return detached.get(root)?.has(id) ?? false;
}
export function remapCommentPath(path: string, changes: CommentPathChange[]) {
  for (const change of changes) {
    if (path === change.oldPath) return change.newPath;
    if (change.folder && path.startsWith(`${change.oldPath}/`))
      return change.newPath + path.slice(change.oldPath.length);
  }
  return path;
}
export function trackCommentPath(root: string, id: string, path: string) {
  const known = paths.get(root) ?? new Map();
  // A delayed old-path save must not undo a migration already published.
  if (!known.has(id)) known.set(id, path);
  paths.set(root, known);
}
export function resolveCommentPath(root: string, id: string, fallback: string) {
  return paths.get(root)?.get(id) ?? fallback;
}
export function clearCommentPaths(root: string) {
  paths.delete(root);
  detached.delete(root);
}
export function remapTrackedCommentPaths(
  root: string,
  changes: CommentPathChange[],
) {
  for (const [id, path] of paths.get(root) ?? [])
    paths.get(root)!.set(id, remapCommentPath(path, changes));
}
export function remapCommentFiles(
  files: InlineCommentsByFile,
  changes: CommentPathChange[],
): InlineCommentsByFile {
  const result: InlineCommentsByFile = {};
  for (const [path, comments] of Object.entries(files)) {
    const target = remapCommentPath(path, changes);
    result[target] = [...(result[target] ?? []), ...comments];
  }
  return result;
}

export function reconnectTrackedComments(
  root: string,
  ids: string[],
  path: string,
) {
  const known = paths.get(root) ?? new Map<string, string>();
  for (const id of ids) {
    known.set(id, path);
    detached.get(root)?.delete(id);
  }
  paths.set(root, known);
}
