import { invertedEffects, isolateHistory } from "@codemirror/commands";
import {
  StateEffect,
  ChangeSet,
  type ChangeDesc,
  EditorState,
  Text,
  Transaction,
} from "@codemirror/state";
import {
  type CommentDocument,
  mapDocumentComments,
} from "./comment-document-model";
import { createDocumentChangeSet } from "./document-changes";
import type { InlineEditorComment } from "./inline-comments";

type Geometry = Pick<
  InlineEditorComment,
  "from" | "to" | "positionReset" | "removedAnchor"
>;
interface RestoreAnchor {
  id: string;
  target: Geometry;
}
const geometry = ({
  from,
  to,
  positionReset,
  removedAnchor,
}: InlineEditorComment): Geometry => ({
  from,
  to,
  positionReset,
  removedAnchor,
});
const same = (a: Geometry, b: Geometry) =>
  a.from === b.from &&
  a.to === b.to &&
  Boolean(a.positionReset) === Boolean(b.positionReset) &&
  (a.removedAnchor === b.removedAnchor ||
    JSON.stringify(a.removedAnchor) === JSON.stringify(b.removedAnchor));

export interface AnchorInverse {
  basis: Text;
  anchors: RestoreAnchor[];
  external?: ChangeDesc;
}
// Keep an immutable CodeMirror text reference, not another full string copy.
// Grouping and non-history edits map history effects in different coordinate
// frames. Retain the actual basis and use the shared model at replay instead.
export const restoreCommentAnchors = StateEffect.define<AnchorInverse>({
  map(inverse, changes) {
    // Group joining maps targets through an exact inverse ChangeSet. External
    // mappings describe edits in the post-event document. Retain those positions
    // until replay, when the complete (possibly grouped) undo is available.
    if (!(changes instanceof ChangeSet)) {
      return {
        ...inverse,
        external: inverse.external
          ? inverse.external.composeDesc(changes)
          : changes,
      };
    }
    if (changes.length !== inverse.basis.length) return inverse;
    const basis = changes.apply(inverse.basis);
    const mapped = mapDocumentComments(
      inverse.anchors.map((item) => ({
        ...item.target,
        id: item.id,
        line: 1,
        text: "",
      })),
      changes,
      EditorState.create({ doc: basis }),
      EditorState.create({ doc: inverse.basis }),
    );
    return {
      basis,
      anchors: inverse.anchors.map((item, index) => ({
        ...item,
        target: geometry(mapped[index]),
      })),
    };
  },
});

export function applyCommentAnchorRestores(
  document: CommentDocument,
  inverses: readonly AnchorInverse[],
  before: CommentDocument,
  transaction: Transaction,
) {
  const current =
    typeof document.source === "string"
      ? Text.of(document.source.split("\n"))
      : document.source;
  const items = inverses.flatMap((inverse) => {
    if (!inverse.external && inverse.basis.eq(current)) return inverse.anchors;
    let changes: ChangeSet;
    if (inverse.external) {
      const external = inverse.external;
      if (external.newLength !== transaction.changes.length) return [];
      const originalUndo = transaction.changes.desc.mapDesc(
        external.invertedDesc,
      );
      const before = external.mapDesc(originalUndo, true);
      if (
        before.length !== inverse.basis.length ||
        before.newLength !== current.length
      )
        return [];
      const edits: { from: number; to: number; insert: Text }[] = [];
      before.iterChangedRanges((from, to, start, end) => {
        edits.push({ from, to, insert: current.slice(start, end) });
      }, true);
      changes = ChangeSet.of(edits, inverse.basis.length);
      if (!changes.apply(inverse.basis).eq(current)) return [];
    } else {
      changes = createDocumentChangeSet(
        inverse.basis.toString(),
        current.toString(),
        "\n",
      );
    }
    const mapped = mapDocumentComments(
      inverse.anchors.map((item, index) => ({
        ...item.target,
        id: `${index}:target`,
        line: 1,
        text: "",
      })),
      changes,
      EditorState.create({ doc: current }),
      EditorState.create({ doc: inverse.basis }),
    );
    return inverse.anchors.map((item, index) => ({
      ...item,
      target: geometry(mapped[index]),
    }));
  });
  // Project every sparse target in one operation, then publish one document
  // revision. Grouped undo can carry many effects for the same document/ID.
  const targets = items.map((item, index) => ({
    ...item.target,
    id: `${index}:target`,
    line: 1,
    text: "",
  }));
  const projected = transaction.docChanged
    ? mapDocumentComments(
        targets,
        transaction.changes.invert(transaction.startState.doc),
        transaction.startState,
        transaction.state,
      )
    : targets;
  const actual = new Map(before.comments.map((c) => [c.id, c]));
  const patches = new Map<string, Geometry>();
  for (const [index, item] of items.entries()) {
    const prior = actual.get(item.id);
    // Preserve newer explicit range edits. Ordered effects retain the same
    // last valid inverse for an ID as sequential replay, without N full scans.
    const expected = projected[index];
    // A grouped deletion may retain only its last removed fragment, whereas
    // projecting the entire inverse removes the whole selection at once. Range
    // and removal state must match; fragment text need not. Explicit resizing
    // clears the removal marker and therefore still invalidates this inverse.
    if (
      prior &&
      prior.from === expected.from &&
      prior.to === expected.to &&
      Boolean(prior.positionReset) === Boolean(expected.positionReset) &&
      Boolean(prior.removedAnchor) === Boolean(expected.removedAnchor)
    )
      patches.set(item.id, item.target);
  }
  return document.withComments(
    document.comments.map((comment) => {
      const target = patches.get(comment.id);
      return target ? { ...comment, ...target } : comment;
    }),
  );
}

export function commentAnchorHistory(
  read: (state: EditorState) => CommentDocument | null,
) {
  return [
    EditorState.transactionExtender.of((transaction) =>
      transaction.docChanged &&
      transaction.annotation(Transaction.addToHistory) === false
        ? { annotations: isolateHistory.of("full") }
        : null,
    ),
    invertedEffects.of((transaction) => {
      const before = read(transaction.startState);
      if (!before?.comments.length) return [];
      const candidates = new Set<string>();
      for (const effect of transaction.effects)
        if (effect.is(restoreCommentAnchors))
          for (const item of effect.value.anchors) candidates.add(item.id);
      // Insertions are reversible by ordinary range mapping. Deletions and
      // replacements can destroy boundaries and need a sparse inverse.
      transaction.changes.iterChangedRanges((from, to) => {
        if (from === to) return;
        for (const comment of before.comments)
          if (
            comment.from === comment.to
              ? comment.from >= from && comment.from < to
              : comment.from < to && comment.to > from
          )
            candidates.add(comment.id);
      });
      if (!candidates.size) return [];
      const after = read(transaction.state);
      if (!after) return [];
      const mappedBack = transaction.docChanged
        ? after.apply(
            transaction.changes.invert(transaction.startState.doc),
            transaction.startState,
          )
        : after;
      const expected = new Map(mappedBack.comments.map((c) => [c.id, c]));
      const inverse: RestoreAnchor[] = [];
      for (const comment of before.comments) {
        const mapped = expected.get(comment.id);
        if (candidates.has(comment.id) && mapped && !same(comment, mapped))
          inverse.push({
            id: comment.id,
            target: geometry(comment),
          });
      }
      return inverse.length
        ? [
            restoreCommentAnchors.of({
              basis: transaction.startState.doc,
              anchors: inverse,
            }),
          ]
        : [];
    }),
  ];
}
