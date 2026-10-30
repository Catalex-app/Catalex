import { createDocumentChangeSet } from "./document-changes";
import {
  createInlineCommentExtension,
  readCommentDocument,
  type InlineEditorComment,
} from "./inline-comments";
import {
  EditorSelection,
  EditorState,
  type Extension,
} from "@codemirror/state";
import {
  history,
  historyField,
  isolateHistory,
  invertedEffects,
} from "@codemirror/commands";
import { getOriginalDoc, updateOriginalDoc } from "@codemirror/merge";

interface SerializedHistory {
  done: unknown[];
  undone: unknown[];
}

export interface EditorHistorySnapshot {
  document: string;
  history: SerializedHistory;
  retained?: Extension;
  comments?: InlineEditorComment[];
}

function clampSelection(
  selection: EditorSelection,
  documentLength: number,
): EditorSelection {
  const ranges = selection.ranges.map((range) =>
    EditorSelection.range(
      Math.min(range.anchor, documentLength),
      Math.min(range.head, documentLength),
    ),
  );
  return EditorSelection.create(
    ranges,
    Math.min(selection.mainIndex, ranges.length - 1),
  );
}

function collapseSelection(
  selection: EditorSelection,
  documentLength: number,
): EditorSelection {
  const clamped = clampSelection(selection, documentLength);
  return EditorSelection.create(
    clamped.ranges.map((range) => EditorSelection.cursor(range.anchor)),
    clamped.mainIndex,
  );
}

function serializeHistory(state: EditorState): SerializedHistory {
  const value = state.toJSON({ history: historyField }).history;
  if (
    typeof value === "object" &&
    value !== null &&
    "done" in value &&
    Array.isArray(value.done) &&
    "undone" in value &&
    Array.isArray(value.undone)
  ) {
    return { done: value.done, undone: value.undone };
  }
  return { done: [], undone: [] };
}

export { createDocumentChangeSet } from "./document-changes";

export function captureEditorHistory(
  state: EditorState,
  baselineDocument = state.doc.toString(),
  baselineComments?: InlineEditorComment[],
): EditorHistorySnapshot {
  if (state.doc.toString() === baselineDocument) {
    return {
      document: baselineDocument,
      history: serializeHistory(state),
      retained: retainEditorHistory(state),
      comments: baselineComments ?? readCommentDocument(state)?.comments,
    };
  }

  // A pending change can be opened after its file was reloaded or remounted.
  // In that case the current history is based on the proposed content, not the
  // pre-edit baseline, so start from an empty but correctly aligned history.
  const baselineState = EditorState.create({
    doc: baselineDocument,
    extensions: [history()],
  });
  return {
    document: baselineDocument,
    history: serializeHistory(baselineState),
    comments: baselineComments,
  };
}

/**
 * Recreate native CodeMirror history after an agent-edit review.
 *
 * Preview transactions stay out of history. Rejection restores the exact
 * pre-review history, while acceptance appends one isolated native event from
 * the original document to the final reviewed content.
 */
export function createReviewedEditState(
  state: EditorState,
  snapshot: EditorHistorySnapshot,
  finalDocument: string,
): EditorState {
  if (state.doc.toString() !== finalDocument) {
    throw new Error("Editor content must match the reviewed history result");
  }

  const baselineHistory =
    snapshot.retained ??
    retainEditorHistory(
      EditorState.fromJSON(
        {
          doc: snapshot.document,
          selection: EditorSelection.single(0).toJSON(),
          history: snapshot.history,
        },
        { extensions: [history()] },
        { history: historyField },
      ),
    );
  const changes = createDocumentChangeSet(snapshot.document, finalDocument);
  const finalSelection = collapseSelection(
    state.selection,
    finalDocument.length,
  );
  let restored = EditorState.create({
    doc: snapshot.document,
    selection: finalSelection.map(changes.invertedDesc),
    extensions: [
      baselineHistory,
      createInlineCommentExtension(snapshot.comments ?? [], { hidden: true }),
    ],
  });
  if (!changes.empty)
    restored = restored.update({
      changes,
      selection: finalSelection,
      annotations: isolateHistory.of("full"),
    }).state;
  return restored;
}

export function createReviewedEditHistory(
  state: EditorState,
  snapshot: EditorHistorySnapshot,
  finalDocument: string,
): Extension {
  // Keep the actual history field: JSON drops effects, including anchor inverses.
  return retainEditorHistory(
    createReviewedEditState(state, snapshot, finalDocument),
  );
}

/** Keep review decisions in CodeMirror's own timeline alongside typing. */
export const reviewDecisionHistory: Extension = [
  invertedEffects.of((transaction) =>
    transaction.effects.flatMap((effect) => {
      if (!effect.is(updateOriginalDoc)) return [];
      const original = getOriginalDoc(transaction.startState);
      return [
        updateOriginalDoc.of({
          doc: original,
          changes: effect.value.changes.invert(original),
        }),
      ];
    }),
  ),
  EditorState.transactionExtender.of((transaction) =>
    transaction.isUserEvent("accept") || transaction.isUserEvent("revert")
      ? { annotations: isolateHistory.of("full") }
      : null,
  ),
];

/** In-memory history retains merge effects, which JSON history omits. */
export function retainEditorHistory(state: EditorState): Extension {
  const retained = state.field(historyField);
  return [history(), historyField.init(() => retained)];
}
