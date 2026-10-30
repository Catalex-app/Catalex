import { afterEach, expect, it, vi } from "vitest";
import {
  COMMENT_HISTORY_EVENT,
  clearCommentDraftHistory,
  typeCommentDraft,
  breakCommentTypingGroup,
  projectCommentDrafts,
} from "./comment-draft-history";
import { inverseCommentPatch } from "./comment-history";
import type { CommentPatch } from "./inline-comment-storage";
const scope = { root: "/project", filePath: "paper.md" };
const comment = { id: "one", from: 1, to: 5, line: 1, text: "Saved" };
afterEach(() => {
  clearCommentDraftHistory();
  vi.useRealTimers();
});
it("groups continuous typing without changing the group's original undo value", () => {
  const patches: CommentPatch[] = [];
  const record = (event: Event) =>
    patches.push(...(event as CustomEvent).detail.patches);
  window.addEventListener(COMMENT_HISTORY_EVENT, record);
  try {
    typeCommentDraft(scope, comment, "Saved a");
    const inverse = inverseCommentPatch(patches[0]);
    typeCommentDraft(scope, comment, "Saved abc");
    expect(patches).toHaveLength(1);
    expect(inverse.draft?.after?.text).toBe("Saved");
    expect(inverse.draft?.before?.text).toBe("Saved abc");
    breakCommentTypingGroup();
    typeCommentDraft(scope, comment, "Saved abc!");
    expect(patches).toHaveLength(2);
    expect(patches[0].draft?.after?.text).toBe("Saved abc");
    expect(patches[1].draft?.before?.text).toBe("Saved abc");
  } finally {
    window.removeEventListener(COMMENT_HISTORY_EVENT, record);
  }
});
it("a typing pause starts another undo group", () => {
  vi.useFakeTimers();
  const patches: CommentPatch[] = [];
  const record = (event: Event) =>
    patches.push(...(event as CustomEvent).detail.patches);
  window.addEventListener(COMMENT_HISTORY_EVENT, record);
  try {
    typeCommentDraft(scope, comment, "First");
    vi.advanceTimersByTime(800);
    typeCommentDraft(scope, comment, "Second");
    expect(patches).toHaveLength(2);
    expect(patches[1].draft?.before?.text).toBe("First");
  } finally {
    window.removeEventListener(COMMENT_HISTORY_EVENT, record);
  }
});
it("drafts preserve saved text and stay scoped to their project and file", () => {
  typeCommentDraft(scope, comment, "Unsaved");
  const files = { "paper.md": [comment], "other.md": [comment] };
  const displayed = projectCommentDrafts(scope.root, files);
  expect(displayed["paper.md"][0]).toMatchObject({
    text: "Saved",
    draftText: "Unsaved",
    isEditing: true,
  });
  expect(displayed["other.md"][0]).toEqual(comment);
  expect(projectCommentDrafts("/other-project", files)).toEqual(files);
  expect(files["paper.md"][0]).toEqual(comment);
});
