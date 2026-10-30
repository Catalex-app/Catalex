import { EditorState } from "@codemirror/state";
import { history, undo, redo, isolateHistory } from "@codemirror/commands";
import { describe, expect, it } from "vitest";
import {
  canApplyCommentHistory,
  commentHistory,
  commentHistoryEffect,
} from "./comment-history";
import {
  captureEditorHistory,
  createReviewedEditHistory,
} from "./editor-history";

const before = {
  id: "one",
  from: 0,
  to: 3,
  line: 1,
  text: "Original",
};
const patch = {
  filePath: "main.tex",
  id: "one",
  before,
  after: { ...before, text: "Edited" },
};
describe("comment history", () => {
  for (const accepted of [false, true])
    it(`retains comment history after text review is ${accepted ? "accepted" : "rejected"}`, () => {
      let state = EditorState.create({
        doc: "abc",
        extensions: [history(), commentHistory(() => {})],
      });
      const effects: unknown[] = [];
      const target = {
        get state() {
          return state;
        },
        dispatch(tr: ReturnType<EditorState["update"]>) {
          effects.push(
            ...tr.effects
              .filter((e) => e.is(commentHistoryEffect))
              .map((e) => e.value),
          );
          state = tr.state;
        },
      };
      state = state.update({
        changes: { from: 3, insert: "d" },
        annotations: isolateHistory.of("full"),
      }).state;
      state = state.update({
        effects: commentHistoryEffect.of(patch),
        annotations: isolateHistory.of("full"),
      }).state;
      const snapshot = captureEditorHistory(state);
      const finalDocument = accepted ? "abcde" : "abcd";
      const previewState = EditorState.create({ doc: finalDocument });
      state = EditorState.create({
        doc: finalDocument,
        extensions: [
          createReviewedEditHistory(previewState, snapshot, finalDocument),
          commentHistory(() => {}),
        ],
      });
      if (accepted) {
        expect(undo(target)).toBe(true);
        expect(state.doc.toString()).toBe("abcd");
      }
      expect(undo(target)).toBe(true);
      expect(state.doc.toString()).toBe("abcd");
      expect(effects[effects.length - 1]).toMatchObject({
        before: { text: "Edited" },
        after: { text: "Original" },
      });
      expect(undo(target)).toBe(true);
      expect(state.doc.toString()).toBe("abc");
      expect(redo(target)).toBe(true);
      expect(redo(target)).toBe(true);
      expect(state.doc.toString()).toBe("abcd");
      expect(effects[effects.length - 1]).toMatchObject({
        before: { text: "Original" },
        after: { text: "Edited" },
      });
      if (accepted) {
        expect(redo(target)).toBe(true);
        expect(state.doc.toString()).toBe(finalDocument);
      }
    });
});

it("keeps unavailable mixed undo retryable, then allows skipped comments and text to advance", () => {
  let ready = false;
  let state = EditorState.create({
    doc: "abc",
    extensions: [history(), commentHistory(() => {})],
  });
  state = state.update({
    changes: { from: 3, insert: "d" },
    effects: commentHistoryEffect.of(patch),
    annotations: isolateHistory.of("full"),
  }).state;
  const target = {
    get state() {
      return state;
    },
    dispatch(tr: ReturnType<EditorState["update"]>) {
      if (canApplyCommentHistory(tr, () => ready)) state = tr.state;
    },
  };
  undo(target);
  expect(state.doc.toString()).toBe("abcd");
  ready = true;
  // The replay callback can skip a disconnected comment without rejecting text.
  undo(target);
  expect(state.doc.toString()).toBe("abc");
  redo(target);
  expect(state.doc.toString()).toBe("abcd");
});

it("does not block text-only undo while comments are unavailable", () => {
  let state = EditorState.create({ doc: "abc", extensions: [history()] });
  state = state.update({ changes: { from: 3, insert: "d" } }).state;
  undo({
    state,
    dispatch(tr) {
      expect(canApplyCommentHistory(tr, () => false)).toBe(true);
      state = tr.state;
    },
  });
  expect(state.doc.toString()).toBe("abc");
});
