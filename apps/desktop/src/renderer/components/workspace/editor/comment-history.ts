import { breakCommentTypingGroup } from "./comment-draft-history";
import {
  StateEffect,
  Transaction,
  type EditorState,
  type Extension,
} from "@codemirror/state";
import { invertedEffects, isolateHistory } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import type { CommentPatch } from "./inline-comment-storage";

// A comment operation is a native history event, between ordinary text edits.
// Anchor-only updates belong to the text edit that moved them, not a new event.
export const commentHistoryEffect = StateEffect.define<CommentPatch>({
  map(patch, changes) {
    const map = (comment: CommentPatch["before"]) => {
      if (!comment) return null;
      const start = changes.mapPos(
        Math.max(0, Math.min(comment.from, changes.length)),
        1,
      );
      const end =
        comment.from === comment.to
          ? start
          : changes.mapPos(
              Math.max(0, Math.min(comment.to, changes.length)),
              -1,
            );
      return {
        ...comment,
        from: Math.min(start, end),
        to: Math.max(start, end),
      };
    };
    return {
      ...patch,
      before: map(patch.before),
      after: map(patch.after),
      draft: patch.draft
        ? {
            before: patch.draft.before
              ? {
                  ...patch.draft.before,
                  comment: map(patch.draft.before.comment)!,
                }
              : null,
            after: patch.draft.after
              ? {
                  ...patch.draft.after,
                  comment: map(patch.draft.after.comment)!,
                }
              : null,
          }
        : undefined,
    };
  },
});
export const inverseCommentPatch = (patch: CommentPatch): CommentPatch => ({
  ...patch,
  draft: patch.draft
    ? { before: patch.draft.after, after: patch.draft.before }
    : undefined,
  before: patch.after,
  after: patch.before,
});
export function commentHistory(
  replay: (patch: CommentPatch) => void,
): Extension {
  return [
    invertedEffects.of((tr) =>
      tr.effects.flatMap((effect) =>
        effect.is(commentHistoryEffect)
          ? [commentHistoryEffect.of(inverseCommentPatch(effect.value))]
          : [],
      ),
    ),
    EditorView.updateListener.of((update) => {
      for (const tr of update.transactions) {
        if (tr.docChanged || tr.isUserEvent("undo") || tr.isUserEvent("redo"))
          breakCommentTypingGroup();
        if (!tr.isUserEvent("undo") && !tr.isUserEvent("redo")) continue;
        for (const effect of tr.effects)
          if (effect.is(commentHistoryEffect)) {
            // Line numbers are derived; position mapping alone cannot update them.
            for (const comment of [effect.value.before, effect.value.after])
              if (comment)
                comment.line = tr.state.doc.lineAt(
                  Math.min(
                    Math.max(comment.from, comment.to - 1),
                    tr.state.doc.length,
                  ),
                ).number;
            replay(effect.value);
          }
      }
    }),
  ];
}
export function recordCommentChange(view: EditorView, patch: CommentPatch) {
  if (!patch.draftOnly) breakCommentTypingGroup();
  view.dispatch(commentChangeTransaction(view.state, patch));
}

export function commentChangeTransaction(
  state: EditorState,
  patch: CommentPatch,
) {
  return state.update({
    effects: commentHistoryEffect.of(patch),
    annotations: [
      isolateHistory.of("full"),
      Transaction.userEvent.of("comment"),
    ],
  });
}

/** Refuse an unavailable comment replay before consuming its history entry. */
export function canApplyCommentHistory(
  tr: Transaction,
  ready: () => boolean,
): boolean {
  return (
    !(tr.isUserEvent("undo") || tr.isUserEvent("redo")) ||
    !tr.effects.some((effect) => effect.is(commentHistoryEffect)) ||
    ready()
  );
}
