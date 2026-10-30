import {
  Compartment,
  EditorSelection,
  EditorState,
  Transaction,
} from "@codemirror/state";
import {
  history,
  isolateHistory,
  redo,
  redoDepth,
  undo,
  undoDepth,
} from "@codemirror/commands";
import { describe, expect, it } from "vitest";
import {
  captureEditorHistory,
  createReviewedEditHistory,
} from "./editor-history";
import {
  createInlineCommentExtension,
  readCommentDocument,
  updateInlineCommentsEffect,
} from "./inline-comments";
import { mapDocumentComments } from "./comment-document-model";
import { createDocumentChangeSet } from "./document-changes";

function commandTarget(
  getState: () => EditorState,
  setState: (state: EditorState) => void,
) {
  return {
    get state() {
      return getState();
    },
    dispatch(transaction: ReturnType<EditorState["update"]>) {
      setState(transaction.state);
    },
  };
}

describe("reviewed editor history", () => {
  it.each([
    true,
    false,
  ])("accepted destructive edits retain anchor inverses (in-memory history: %s)", (retained) => {
    const compartment = new Compartment();
    const original = {
      id: "a",
      from: 2,
      to: 5,
      line: 1,
      text: "Keep feedback",
      resolved: true,
    };
    let state = EditorState.create({
      doc: "abcdef",
      extensions: [
        compartment.of(history()),
        createInlineCommentExtension([original], { hidden: true }),
      ],
    });
    const baseline = captureEditorHistory(state);
    if (!retained) delete baseline.retained;
    state = state.update({
      changes: { from: 0, to: 6, insert: "replacement" },
      effects: updateInlineCommentsEffect.of({
        comments: [],
        actions: { hidden: true },
      }),
      annotations: Transaction.addToHistory.of(false),
    }).state;
    const finalText = "replacement";
    const comments = mapDocumentComments(
      [original],
      createDocumentChangeSet(baseline.document, finalText),
      finalText,
      baseline.document,
    );
    state = state.update({
      effects: [
        compartment.reconfigure(
          createReviewedEditHistory(state, baseline, finalText),
        ),
        updateInlineCommentsEffect.of({ comments, actions: { hidden: true } }),
      ],
    }).state;
    const target = commandTarget(
      () => state,
      (next) => {
        state = next;
      },
    );
    expect(undo(target)).toBe(true);
    expect(state.doc.toString()).toBe("abcdef");
    expect(readCommentDocument(state)!.comments[0]).toMatchObject(original);
    expect(redo(target)).toBe(true);
    expect(state.doc.toString()).toBe(finalText);
    expect(readCommentDocument(state)!.comments).toEqual(comments);
    expect(undo(target)).toBe(true);
    expect(readCommentDocument(state)!.comments[0]).toMatchObject(original);
  });

  it("captures source comments when a review opens from a different document", () => {
    const original = {
      id: "source",
      from: 2,
      to: 5,
      line: 1,
      text: "Source feedback",
    };
    const proposed = EditorState.create({
      doc: "proposed content",
      extensions: [history()],
    });
    const snapshot = captureEditorHistory(proposed, "abcdef", [original]);
    expect(snapshot.document).toBe("abcdef");
    expect(snapshot.comments).toEqual([original]);
    expect(snapshot.history.done).toEqual([]);
  });
  it("appends an accepted agent edit after the existing undo history", () => {
    const historyCompartment = new Compartment();
    let state = EditorState.create({
      doc: "draft",
      extensions: [historyCompartment.of(history())],
    });
    state = state.update({
      changes: { from: state.doc.length, insert: " by user" },
      annotations: isolateHistory.of("full"),
    }).state;
    state = state.update({
      selection: EditorSelection.range(0, state.doc.length),
    }).state;
    const baseline = captureEditorHistory(state);

    state = state.update({
      changes: {
        from: 0,
        to: state.doc.length,
        insert: "draft by user and agent",
      },
      selection: { anchor: "draft by user".length },
      annotations: Transaction.addToHistory.of(false),
    }).state;
    expect(undoDepth(state)).toBe(0);

    state = state.update({
      effects: historyCompartment.reconfigure(
        createReviewedEditHistory(state, baseline, state.doc.toString()),
      ),
    }).state;

    expect(undoDepth(state)).toBe(2);
    const target = commandTarget(
      () => state,
      (nextState) => {
        state = nextState;
      },
    );

    expect(undo(target)).toBe(true);
    expect(state.doc.toString()).toBe("draft by user");
    expect(state.selection.main.empty).toBe(true);
    expect(state.selection.main.anchor).toBe("draft by user".length);
    expect(state.selection.main.head).toBe("draft by user".length);
    expect(undo(target)).toBe(true);
    expect(state.doc.toString()).toBe("draft");
    expect(redoDepth(state)).toBe(2);
    expect(redo(target)).toBe(true);
    expect(state.doc.toString()).toBe("draft by user");
    expect(redo(target)).toBe(true);
    expect(state.doc.toString()).toBe("draft by user and agent");
    expect(state.selection.main.empty).toBe(true);
  });

  it("restores the original history when the agent edit is rejected", () => {
    const historyCompartment = new Compartment();
    let state = EditorState.create({
      doc: "draft",
      extensions: [historyCompartment.of(history())],
    });
    state = state.update({ changes: { from: 5, insert: " by user" } }).state;
    const baseline = captureEditorHistory(state);

    state = state.update({
      changes: {
        from: 0,
        to: state.doc.length,
        insert: "agent replacement",
      },
      annotations: Transaction.addToHistory.of(false),
    }).state;
    state = state.update({
      changes: {
        from: 0,
        to: state.doc.length,
        insert: baseline.document,
      },
      annotations: Transaction.addToHistory.of(false),
    }).state;
    state = state.update({
      effects: historyCompartment.reconfigure(
        createReviewedEditHistory(state, baseline, baseline.document),
      ),
    }).state;

    const target = commandTarget(
      () => state,
      (nextState) => {
        state = nextState;
      },
    );
    expect(undoDepth(state)).toBe(1);
    expect(undo(target)).toBe(true);
    expect(state.doc.toString()).toBe("draft");
  });
});

describe("review decision timeline", () => {
  it("undoes and redoes acceptance, typing, and rejection in order", async () => {
    const { EditorView } = await import("@codemirror/view");
    const { unifiedMergeView, acceptChunk, rejectChunk, getChunks } =
      await import("@codemirror/merge");
    const { reviewDecisionHistory, retainEditorHistory } = await import(
      "./editor-history"
    );
    const original = "old first\n\na\nb\nc\nd\ne\nf\n\nold last\n";
    const proposed = original
      .replace("old first", "new first")
      .replace("old last", "new last");
    const view = new EditorView({
      state: EditorState.create({
        doc: proposed,
        extensions: [
          history(),
          unifiedMergeView({ original }),
          reviewDecisionHistory,
        ],
      }),
    });
    try {
      expect(getChunks(view.state)?.chunks).toHaveLength(2);
      acceptChunk(view, 0);
      expect(getChunks(view.state)?.chunks).toHaveLength(1);
      view.dispatch({
        changes: { from: view.state.doc.length, insert: "typed" },
        annotations: isolateHistory.of("full"),
      });
      expect(undo(view)).toBe(true);
      expect(view.state.doc.toString()).toBe(proposed);
      expect(undo(view)).toBe(true);
      expect(getChunks(view.state)?.chunks).toHaveLength(2);
      expect(redo(view)).toBe(true);
      expect(getChunks(view.state)?.chunks).toHaveLength(1);
      rejectChunk(view, getChunks(view.state)!.chunks[0].fromB);
      expect(view.state.doc.toString()).toContain("old last");
      expect(undo(view)).toBe(true);
      expect(view.state.doc.toString()).toBe(proposed);
      expect(getChunks(view.state)?.chunks).toHaveLength(1);
      const retained = retainEditorHistory(view.state);
      const { getOriginalDoc } = await import("@codemirror/merge");
      view.setState(
        EditorState.create({
          doc: proposed,
          extensions: [
            retained,
            unifiedMergeView({ original: getOriginalDoc(view.state) }),
            reviewDecisionHistory,
          ],
        }),
      );
      expect(undo(view)).toBe(true);
      expect(getChunks(view.state)?.chunks).toHaveLength(2);
    } finally {
      view.destroy();
    }
  });
});
