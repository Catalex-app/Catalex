import {
  remapCommentPath,
  isCommentDetached,
  trackCommentPath,
  type CommentPathChange,
} from "./comment-paths";
import type {
  CommentPatch,
  InlineCommentsByFile,
} from "./inline-comment-storage";
import type { InlineEditorComment } from "./inline-comments";

export interface CommentHistoryScope {
  root: string;
  filePath: string;
}
export interface CommentDraft {
  comment: InlineEditorComment;
  text: string;
}
export const COMMENT_HISTORY_EVENT = "catalex-local-comment-history";
export const COMMENT_DRAFT_EVENT = "catalex-comment-draft";
const drafts = new Map<string, CommentDraft>();
const key = (scope: CommentHistoryScope, id: string) =>
  JSON.stringify([scope.root, scope.filePath, id]);
let group: { key: string; time: number; after: CommentDraft } | null = null;
export function clearCommentDraftHistory() {
  drafts.clear();
  group = null;
}
export function breakCommentTypingGroup() {
  group = null;
}
export function getCommentDraft(scope: CommentHistoryScope, id: string) {
  return drafts.get(key(scope, id));
}
export function setCommentDraft(
  scope: CommentHistoryScope,
  id: string,
  draft: CommentDraft | null,
) {
  trackCommentPath(scope.root, id, scope.filePath);
  if (draft) drafts.set(key(scope, id), draft);
  else drafts.delete(key(scope, id));
  window.dispatchEvent(
    new CustomEvent(COMMENT_DRAFT_EVENT, { detail: { scope, id, draft } }),
  );
}
export function typeCommentDraft(
  scope: CommentHistoryScope,
  comment: InlineEditorComment,
  text: string,
) {
  const draftKey = key(scope, comment.id);
  const previous = drafts.get(draftKey) ?? { comment, text: comment.text };
  if (previous.text === text) return;
  const now = Date.now();
  if (group?.key === draftKey && now - group.time < 750) {
    // History keeps this group endpoint by reference; subsequent keystrokes
    // extend it until blur, another action, undo, or a pause closes the group.
    group.after.text = text;
    group.time = now;
    setCommentDraft(scope, comment.id, group.after);
    return;
  }
  const after = { comment, text };
  const patch: CommentPatch = {
    filePath: scope.filePath,
    id: comment.id,
    before: null,
    after: null,
    draftOnly: true,
    draft: { before: { ...previous }, after },
  };
  group = { key: draftKey, time: now, after };
  setCommentDraft(scope, comment.id, after);
  window.dispatchEvent(
    new CustomEvent(COMMENT_HISTORY_EVENT, {
      detail: { root: scope.root, patches: [patch] },
    }),
  );
}
export function projectCommentDrafts(
  root: string | null,
  files: InlineCommentsByFile,
): InlineCommentsByFile {
  if (!root) return files;
  const result = { ...files };
  for (const [encoded, draft] of drafts) {
    const [draftRoot, path, id] = JSON.parse(encoded) as string[];
    if (draftRoot !== root || isCommentDetached(root, id)) continue;
    const list = result[path] ?? [];
    const existing = list.find((c) => c.id === id);
    const comment = {
      ...(existing ?? { ...draft.comment, text: "" }),
      isEditing: true,
      draftText: draft.text,
    };
    result[path] = existing
      ? list.map((c) => (c.id === id ? comment : c))
      : [...list, comment];
  }
  return result;
}

export function closeCommentDraft(scope: CommentHistoryScope, id: string) {
  const before = getCommentDraft(scope, id);
  if (!before) return;
  breakCommentTypingGroup();
  const patch: CommentPatch = {
    filePath: scope.filePath,
    id,
    before: null,
    after: null,
    draftOnly: true,
    draft: { before: { ...before }, after: null },
  };
  setCommentDraft(scope, id, null);
  window.dispatchEvent(
    new CustomEvent(COMMENT_HISTORY_EVENT, {
      detail: { root: scope.root, patches: [patch] },
    }),
  );
}

export function clearProjectCommentDrafts(root: string, agent: boolean) {
  group = null;
  for (const [encoded, draft] of drafts) {
    const [draftRoot, filePath, id] = JSON.parse(encoded) as string[];
    if (draftRoot === root && Boolean(draft.comment.origin) === agent)
      setCommentDraft({ root, filePath }, id, null);
  }
}

export function remapCommentDraftPaths(
  root: string,
  changes: CommentPathChange[],
) {
  group = null;
  for (const [encoded, draft] of [...drafts]) {
    const [draftRoot, filePath, id] = JSON.parse(encoded) as string[];
    if (draftRoot !== root) continue;
    const target = remapCommentPath(filePath, changes);
    if (target === filePath) continue;
    drafts.delete(encoded);
    drafts.set(key({ root, filePath: target }, id), draft);
  }
}
