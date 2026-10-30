import { EditorState } from "@codemirror/state";
import { afterEach, expect, it, vi } from "vitest";
import { DocumentModel } from "@/lib/document-model";
import {
  commentsAfterEditorUpdate,
  createInlineCommentExtension,
  updateInlineCommentsEffect,
} from "./inline-comments";
import {
  clearCommentDocumentModels,
  CommentDocument,
  mapDocumentComments,
} from "./comment-document-model";

afterEach(clearCommentDocumentModels);

it("keeps document revisions across cache eviction and independent transaction branches", () => {
  const state = EditorState.create({ doc: "before selected after" });
  const model = CommentDocument.open(state, [
    { id: "a", from: 7, to: 15, line: 1, text: "Review" },
  ]);
  const change = state.update({ changes: { from: 0, insert: "x" } });
  const first = model.apply(change.changes, change.state);
  expect(first.revision).toBe(1);
  const resolved = first.withComments(
    first.comments.map((c) => ({ ...c, resolved: true })),
  );
  expect(resolved.revision).toBe(2);
  const editedMessage = resolved.withComments(
    resolved.comments.map((c) => ({ ...c, text: "New message" })),
  );
  expect(editedMessage.revision).toBe(2);
  clearCommentDocumentModels();
  const nextChange = change.state.update({ changes: { from: 0, insert: "y" } });
  const next = editedMessage.apply(nextChange.changes, nextChange.state);
  expect(next.revision).toBe(3);
  expect(next.comments[0]).toMatchObject({
    from: 9,
    to: 17,
    resolved: true,
    text: "New message",
  });
  const sibling = model.apply(change.changes, change.state);
  expect(sibling.revision).toBe(1);
  expect(sibling.comments[0]).toMatchObject({
    from: 8,
    to: 16,
    text: "Review",
  });
  expect(sibling.comments[0].resolved).toBeUndefined();
});

it("does not allocate a WASM document while typing in a file without comments", () => {
  const before = EditorState.create({ doc: "document text" });
  const model = CommentDocument.open(before, []);
  const change = before.update({ changes: { from: 0, insert: "x" } });
  const open = vi.spyOn(DocumentModel, "open");
  try {
    const next = model.apply(change.changes, change.state);
    expect(next.revision).toBe(1);
    expect(open).not.toHaveBeenCalled();
    const created = next.withComments([
      { id: "new", from: 1, to: 9, line: 1, text: "Review" },
    ]);
    expect(created.revision).toBe(2);
    expect(open).toHaveBeenCalledTimes(1);
  } finally {
    open.mockRestore();
  }
});

it("retains bounded large-deletion recovery after closing the model and reopening the file", () => {
  const text = `😀${"x".repeat(100_000)}`;
  const before = EditorState.create({ doc: text });
  const comments = [{ id: "a", from: 12, to: 24, line: 1, text: "Keep me" }];
  const deletion = before.update({ changes: { from: 0, to: text.length } });
  const removed = mapDocumentComments(
    comments,
    deletion.changes,
    deletion.state,
    before,
  );
  expect(JSON.stringify(removed).length).toBeLessThan(500);
  expect(removed[0].removedAnchor).toMatchObject({ length: text.length });
  clearCommentDocumentModels();
  const reopened = EditorState.create({ doc: "" });
  const restore = reopened.update({ changes: { from: 0, insert: text } });
  expect(
    mapDocumentComments(removed, restore.changes, restore.state, reopened)[0],
  ).toMatchObject({ from: 12, to: 24, removedAnchor: undefined });
});

it.each([
  false,
  true,
])("shares one mapped result with persistence when comments are hidden=%s", (hidden) => {
  const comments = [
    { id: "open", from: 7, to: 15, line: 1, text: "Review" },
    { id: "resolved", from: 7, to: 15, line: 1, text: "Done", resolved: true },
  ];
  const before = EditorState.create({
    doc: "before selected after",
    extensions: [createInlineCommentExtension(comments, { hidden })],
  });
  const fork = vi.spyOn(DocumentModel.prototype, "fork");
  try {
    const transaction = before.update({ changes: { from: 0, insert: "x\n" } });
    const after = transaction.state;
    expect(fork).toHaveBeenCalledTimes(1);
    const result = commentsAfterEditorUpdate(
      comments,
      transaction.changes,
      after,
      before,
    );
    expect(fork).toHaveBeenCalledTimes(1);
    expect(result.map(({ from, to, line }) => ({ from, to, line }))).toEqual([
      { from: 9, to: 17, line: 2 },
      { from: 9, to: 17, line: 2 },
    ]);
    expect(result[1].resolved).toBe(true);
  } finally {
    fork.mockRestore();
  }
});

it("retains current message edits and new comments while consuming an editor transaction", () => {
  const comment = { id: "a", from: 7, to: 15, line: 1, text: "Old message" };
  const before = EditorState.create({
    doc: "before selected after",
    extensions: [createInlineCommentExtension([comment])],
  });
  const transaction = before.update({ changes: { from: 0, insert: "x" } });
  const result = commentsAfterEditorUpdate(
    [
      { ...comment, text: "New message" },
      { id: "new", from: 0, to: 6, line: 1, text: "Agent message" },
    ],
    transaction.changes,
    transaction.state,
    before,
  );
  expect(result).toMatchObject([
    { id: "a", from: 8, to: 16, text: "New message" },
    { id: "new", from: 1, to: 7, text: "Agent message" },
  ]);
  const synced = transaction.state.update({
    effects: updateInlineCommentsEffect.of({ comments: result, actions: {} }),
  }).state;
  const next = synced.update({ changes: { from: 0, insert: "y" } });
  expect(
    commentsAfterEditorUpdate(result, next.changes, next.state, synced),
  ).toMatchObject([
    { id: "a", from: 9, to: 17 },
    { id: "new", from: 2, to: 8 },
  ]);
});

it("keeps creation, resize, resolve, reopen, and deletion aligned with following text edits", () => {
  const original = { id: "a", from: 7, to: 15, line: 1, text: "Review" };
  let comments = [original];
  let state = EditorState.create({
    doc: "before selected after",
    extensions: [createInlineCommentExtension(comments)],
  });
  const publish = (next: typeof comments) => {
    comments = next;
    state = state.update({
      effects: updateInlineCommentsEffect.of({ comments, actions: {} }),
    }).state;
  };
  const type = () => {
    const transaction = state.update({ changes: { from: 0, insert: "x" } });
    comments = commentsAfterEditorUpdate(
      comments,
      transaction.changes,
      transaction.state,
      state,
    );
    state = transaction.state;
  };
  publish([original, { ...original, id: "new", from: 0, to: 6 }]);
  type();
  expect(comments.map((c) => [c.from, c.to])).toEqual([
    [8, 16],
    [1, 7],
  ]);
  publish([
    { ...comments[0], from: 9, to: 15, resolved: true } as typeof original,
  ]);
  type();
  expect(comments[0]).toMatchObject({
    id: "a",
    from: 10,
    to: 16,
    resolved: true,
  });
  publish([{ ...comments[0], resolved: false } as typeof original]);
  type();
  expect(comments[0]).toMatchObject({ from: 11, to: 17, resolved: false });
  publish([]);
  type();
  expect(comments).toEqual([]);
  publish([{ ...original, id: "last", from: 0, to: 4 }]);
  type();
  expect(comments).toMatchObject([{ id: "last", from: 1, to: 5 }]);
});

it("preparing and discarding one transaction cannot alter a sibling transaction", () => {
  const before = EditorState.create({ doc: "before selected after" });
  const comments = [
    { id: "a", from: 7, to: 15, line: 1, text: "Review", resolved: true },
  ];
  const unused = before.update({ changes: { from: 0, insert: "unused " } });
  const unusedComments = mapDocumentComments(
    comments,
    unused.changes,
    unused.state,
    before,
  );
  const actual = before.update({ changes: { from: 0, insert: "x" } });
  const actualComments = mapDocumentComments(
    comments,
    actual.changes,
    actual.state,
    before,
  );
  expect(actualComments[0]).toMatchObject({ from: 8, to: 16, resolved: true });
  expect(unusedComments[0]).toMatchObject({ from: 14, to: 22 });
  expect(comments[0]).toMatchObject({ from: 7, to: 15 });
});

it("reconstructs an evicted editor state and retains new comments from the same text revision", () => {
  const before = EditorState.create({ doc: "before selected after" });
  const comments = [{ id: "a", from: 7, to: 15, line: 1, text: "Review" }];
  for (let i = 0; i < 12; i++) {
    const other = EditorState.create({ doc: `file ${i}` });
    const change = other.update({ changes: { from: 0, insert: "x" } });
    mapDocumentComments(
      [{ id: "other", from: 0, to: 4, line: 1, text: "Other" }],
      change.changes,
      change.state,
      other,
    );
  }
  const change = before.update({ changes: { from: 0, insert: "x" } });
  const first = mapDocumentComments(
    comments,
    change.changes,
    change.state,
    before,
  );
  const second = mapDocumentComments(
    [...comments, { id: "b", from: 0, to: 6, line: 1, text: "Agent" }],
    change.changes,
    change.state,
    before,
  );
  expect(second[0]).toEqual(first[0]);
  expect(second[1]).toMatchObject({ from: 1, to: 7 });
});

it("rejects a source-revision mismatch instead of silently shifting the wrong text", () => {
  const before = EditorState.create({ doc: "before selected after" });
  const change = before.update({ changes: { from: 0, insert: "x" } });
  expect(() =>
    mapDocumentComments(
      [{ id: "a", from: 0, to: 3, line: 1, text: "Review" }],
      change.changes,
      change.state,
      "wrong revision",
    ),
  ).toThrow("revision");
});
