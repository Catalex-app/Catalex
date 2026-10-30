import { history, redo, undo } from "@codemirror/commands";
import {
  EditorState,
  Transaction,
  type TransactionSpec,
} from "@codemirror/state";
import { afterEach, expect, it, vi } from "vitest";
import { clearCommentDocumentModels } from "./comment-document-model";
import { DocumentModel } from "@/lib/document-model";
import {
  commentsAfterEditorUpdate,
  createInlineCommentExtension,
  updateInlineCommentsEffect,
  type InlineEditorComment,
} from "./inline-comments";

afterEach(clearCommentDocumentModels);

it("restores many overlapping comments after a long grouped deletion", () => {
  const source = "A paragraph with selected words.\n".repeat(7000);
  const original = Array.from({ length: 1000 }, (_, index) => ({
    id: `many-${index}`,
    from: 20 + (index % 50),
    to: 100 + (index % 50),
    line: 4 + Math.floor((index % 50) / 33),
    text: `Feedback ${index}`,
    resolved: index % 2 === 0,
  }));
  const view = editor(source, original);
  const start = performance.now();
  for (let index = 0; index < 30; index++)
    view.edit({
      changes: { from: 40, to: 41 },
      annotations: Transaction.userEvent.of("delete.backward"),
    });
  const edited = performance.now();
  const deleted = view.comments;
  view.undo();
  const restored = performance.now();
  expect(view.text).toBe(source);
  expect(
    view.comments.map(({ id, from, to, resolved }) => ({
      id,
      from,
      to,
      resolved,
    })),
  ).toEqual(
    original.map(({ id, from, to, resolved }) => ({ id, from, to, resolved })),
  );
  if (process.env.CATALEX_PROFILE_COMMENTS === "1")
    console.log({
      groupedDeleteMs: edited - start,
      groupedUndoMs: restored - edited,
    });
  view.redo();
  expect(view.comments).toEqual(deleted);
  view.undo();
  expect(view.comments.map(({ from, to }) => [from, to])).toEqual(
    original.map(({ from, to }) => [from, to]),
  );
});

function editor(text: string, initial: InlineEditorComment[]) {
  let comments = initial;
  let state = EditorState.create({
    doc: text,
    extensions: [history(), createInlineCommentExtension(comments)],
  });
  const dispatch = (transaction: Transaction) => {
    comments = commentsAfterEditorUpdate(
      comments,
      transaction.changes,
      transaction.state,
      state,
    );
    state = transaction.state;
  };
  return {
    get comments() {
      return comments;
    },
    get text() {
      return state.doc.toString();
    },
    edit(spec: TransactionSpec) {
      dispatch(state.update(spec));
    },
    publish(next: InlineEditorComment[]) {
      comments = next;
      state = state.update({
        effects: updateInlineCommentsEffect.of({ comments, actions: {} }),
      }).state;
    },
    undo() {
      expect(undo({ state, dispatch })).toBe(true);
    },
    redo() {
      expect(redo({ state, dispatch })).toBe(true);
    },
  };
}

it.each([
  { name: "partial prefix deletion", from: 0, to: 3, insert: "" },
  { name: "partial suffix deletion", from: 4, to: 6, insert: "" },
  { name: "enclosing replacement", from: 0, to: 6, insert: "replacement" },
  {
    name: "partially overlapping replacement",
    from: 0,
    to: 3,
    insert: "replacement",
  },
])("restores the whole selected range after $name and repeated undo/redo", ({
  from,
  to,
  insert,
}) => {
  const original = {
    id: "a",
    from: 2,
    to: 5,
    line: 1,
    text: "Review",
    resolved: true,
  };
  const view = editor("abcdef", [original]);
  view.edit({ changes: { from, to, insert } });
  const changed = view.comments[0];
  for (let i = 0; i < 3; i++) {
    view.undo();
    expect(view.text).toBe("abcdef");
    expect(view.comments[0]).toMatchObject(original);
    view.redo();
    expect(view.comments[0]).toMatchObject(changed);
  }
});

it("preserves newer message/status changes but does not override a later resize or resurrect a deletion", () => {
  const original = { id: "a", from: 2, to: 5, line: 1, text: "Review" };
  const view = editor("abcdef", [original]);
  view.edit({ changes: { from: 0, to: 3 } });
  view.publish([{ ...view.comments[0], text: "Updated", resolved: true }]);
  view.undo();
  expect(view.comments[0]).toMatchObject({
    from: 2,
    to: 5,
    text: "Updated",
    resolved: true,
  });
  view.redo();
  view.publish([{ ...view.comments[0], from: 0, to: 1 }]);
  view.undo();
  expect(view.comments[0]).toMatchObject({ from: 3, to: 4 });
  view.redo();
  view.publish([]);
  view.undo();
  expect(view.comments).toEqual([]);
});

it.each([
  "abcdefghij",
  "aaaaaaaaaa",
])("retains sparse inverses across grouped deletions in %s", (source) => {
  const original = { id: "a", from: 2, to: 7, line: 1, text: "Review" };
  const view = editor(source, [original]);
  view.edit({
    changes: { from: 0, to: 3 },
    annotations: Transaction.userEvent.of("delete.backward"),
  });
  view.edit({
    changes: { from: 0, to: 2 },
    annotations: Transaction.userEvent.of("delete.backward"),
  });
  view.undo();
  expect(view.text).toBe(source);
  expect(view.comments[0]).toMatchObject(original);
});

it("does not compute inverse anchor snapshots for ordinary typing", () => {
  const view = editor("abcdef", [
    { id: "a", from: 2, to: 5, line: 1, text: "Review" },
  ]);
  const fork = vi.spyOn(DocumentModel.prototype, "fork");
  try {
    view.edit({
      changes: { from: 3, insert: "x" },
      annotations: Transaction.userEvent.of("input.type"),
    });
    expect(fork).toHaveBeenCalledTimes(1);
    view.undo();
    expect(view.comments[0]).toMatchObject({ from: 2, to: 5 });
  } finally {
    fork.mockRestore();
  }
});

it("maps a pending undo through an external prefix edit without touching newer comments", () => {
  const view = editor("abcdef", [
    { id: "a", from: 2, to: 5, line: 1, text: "Review" },
  ]);
  view.edit({ changes: { from: 0, to: 3 } });
  view.edit({
    changes: { from: 0, insert: "xx" },
    annotations: Transaction.addToHistory.of(false),
  });
  view.publish([
    ...view.comments,
    { id: "later", from: 2, to: 3, line: 1, text: "New comment" },
  ]);
  view.undo();
  expect(view.text).toBe("xxabcdef");
  expect(view.comments).toMatchObject([
    { id: "a", from: 4, to: 7 },
    { id: "later", from: 5, to: 6 },
  ]);
});

it.each([
  "aaaaaaaaaa",
  "abcdefghij",
])("rebases sparse inverses through same-length replacements and repeated external prefixes in %s", (source) => {
  for (const external of [
    { from: 0, insert: "aa" },
    { from: 2, to: 3, insert: "Z" },
    { from: 1, insert: "a" },
  ]) {
    const initial = { id: "a", from: 2, to: 7, line: 1, text: "Review" };
    const view = editor(source, [initial]);
    view.edit({ changes: { from: 0, to: 3 } });
    view.edit({
      changes: external,
      annotations: Transaction.addToHistory.of(false),
    });
    const expected = editor(source, [initial]);
    expected.edit({
      changes: {
        ...external,
        from: external.from === 0 ? 0 : external.from + 3,
        ...(external.to === undefined ? {} : { to: external.to + 3 }),
      },
    });
    view.undo();
    expect(view.text).toBe(expected.text);
    expect(view.comments.map(({ from, to }) => [from, to])).toEqual(
      expected.comments.map(({ from, to }) => [from, to]),
    );
  }
});

it.each([
  1, 2, 30,
])("rebases %i grouped deletions across repeated external text, then preserves new typing as a separate undo", (count) => {
  const source = "a".repeat(120);
  const original = Array.from({ length: 10 }, (_, i) => ({
    id: `a${i}`,
    from: 2 + i,
    to: 80 + i,
    line: 1,
    text: "Review",
  }));
  const view = editor(source, original);
  for (let i = 0; i < count; i++)
    view.edit({
      changes: { from: 0, to: 3 },
      annotations: Transaction.userEvent.of("delete.backward"),
    });
  view.edit({
    changes: { from: 0, insert: "aa" },
    annotations: Transaction.addToHistory.of(false),
  });
  view.edit({
    changes: { from: 0, insert: "b" },
    annotations: Transaction.userEvent.of("input.type"),
  });
  view.undo();
  expect(view.text).toBe(`aa${source.slice(3 * count)}`);
  view.undo();
  expect(view.text).toBe(`aa${source}`);
  expect(view.comments.map(({ from, to }) => [from, to])).toEqual(
    original.map(({ from, to }) => [from + 2, to + 2]),
  );
  view.redo();
  view.undo();
  expect(view.comments.map(({ from, to }) => [from, to])).toEqual(
    original.map(({ from, to }) => [from + 2, to + 2]),
  );
});

it("retains external deletions and newer explicit point resizing during undo", () => {
  for (const source of ["a".repeat(30), "abcdefghijklmnopqrstuvwxyz1234"]) {
    const initial = { id: "a", from: 2, to: 12, line: 1, text: "Review" };
    const view = editor(source, [initial]);
    view.edit({ changes: { from: 0, to: 3 } });
    view.edit({
      changes: { from: 2, to: 4 },
      annotations: Transaction.addToHistory.of(false),
    });
    const expected = editor(source, [initial]);
    expected.edit({ changes: { from: 5, to: 7 } });
    view.undo();
    expect(view.text).toBe(expected.text);
    expect(view.comments.map(({ from, to }) => [from, to])).toEqual([[2, 10]]);
  }
  const view = editor("selected tail", [
    { id: "a", from: 0, to: 8, line: 1, text: "Review" },
  ]);
  view.edit({ changes: { from: 0, to: 8 } });
  view.publish([
    { ...view.comments[0], from: 0, to: 0, removedAnchor: undefined },
  ]);
  view.undo();
  expect(view.comments[0]).toMatchObject({ from: 8, to: 8 });
});
