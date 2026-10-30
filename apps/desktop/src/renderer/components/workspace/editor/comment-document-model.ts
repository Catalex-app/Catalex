import { type ChangeDesc, type EditorState, Text } from "@codemirror/state";
import {
  DocumentModel,
  type DocumentAnchor,
  type DocumentOperation,
} from "@/lib/document-model";
import type { InlineEditorComment } from "./inline-comments";

type Source = string | EditorState;
type SourceKey = string | Text;
const key = (source: Source): SourceKey =>
  typeof source === "string" ? source : source.doc;
const sourceText = (source: SourceKey) =>
  typeof source === "string" ? source : source.toString();

function boundary(source: SourceKey, offset: number) {
  if (!Number.isInteger(offset) || offset < 0 || offset > source.length)
    return false;
  const around =
    typeof source === "string"
      ? source.slice(offset - 1, offset + 1)
      : source.sliceString(Math.max(0, offset - 1), offset + 1);
  return offset === 0 || !/[\uD800-\uDBFF][\uDC00-\uDFFF]/.test(around);
}

export function resetCommentPosition(
  comment: InlineEditorComment,
  text: string,
): InlineEditorComment {
  let position = Number.isFinite(comment.from)
    ? Math.max(0, Math.min(Math.trunc(comment.from), text.length))
    : 0;
  if (!boundary(text, position)) position--;
  return {
    ...comment,
    removedAnchor: undefined,
    from: position,
    to: position,
    line: text.slice(0, position).split("\n").length,
    positionReset: true,
  };
}

function geometry(comment: InlineEditorComment): DocumentAnchor {
  const removed = comment.removedAnchor;
  const validRemoved =
    removed &&
    Number.isInteger(removed.from) &&
    Number.isInteger(removed.to) &&
    removed.from >= 0 &&
    removed.from <= removed.to &&
    (typeof removed.text === "string"
      ? removed.sha256 === undefined &&
        removed.length === undefined &&
        boundary(removed.text, removed.from) &&
        boundary(removed.text, removed.to)
      : typeof removed.sha256 === "string" &&
        /^[a-f0-9]{64}$/.test(removed.sha256) &&
        Number.isSafeInteger(removed.length) &&
        removed.to <= removed.length);
  return {
    id: comment.id,
    from: comment.from,
    to: comment.to,
    resolved: Boolean(comment.resolved),
    positionReset: Boolean(comment.positionReset),
    ...(validRemoved ? { removedAnchor: removed } : {}),
  };
}

function sameAnchor(a: DocumentAnchor, b: DocumentAnchor) {
  return (
    a.from === b.from &&
    a.to === b.to &&
    a.resolved === b.resolved &&
    a.positionReset === b.positionReset &&
    (a.removedAnchor === b.removedAnchor ||
      JSON.stringify(a.removedAnchor) === JSON.stringify(b.removedAnchor))
  );
}

export function sameCommentAnchor(
  a: InlineEditorComment,
  b: InlineEditorComment,
) {
  return sameAnchor(geometry(a), geometry(b));
}

// CodeMirror owns immutable document states. Native handles are only a bounded
// cache: recreating an evicted state preserves its exact text, anchors, revision.
const retained = new Map<CommentDocument, DocumentModel>();
function retain(document: CommentDocument, model: DocumentModel) {
  retained.set(document, model);
  while (retained.size > 6) {
    const oldest = retained.keys().next().value!;
    const retired = retained.get(oldest)!;
    retained.delete(oldest);
    if (![...retained.values()].includes(retired)) retired.dispose();
  }
}
export function clearCommentDocumentModels() {
  for (const model of new Set(retained.values())) model.dispose();
  retained.clear();
}

function normalize(comments: InlineEditorComment[], source: SourceKey) {
  return comments.map((comment) =>
    comment.id &&
    comment.from <= comment.to &&
    boundary(source, comment.from) &&
    boundary(source, comment.to)
      ? comment
      : resetCommentPosition(comment, sourceText(source)),
  );
}

function applyAnchors(
  comments: InlineEditorComment[],
  anchors: readonly DocumentAnchor[],
  source: SourceKey,
) {
  const mapped = new Map(anchors.map((a) => [a.id, a]));
  const doc = typeof source === "string" ? Text.of(source.split("\n")) : source;
  return comments.map((comment) => {
    const anchor = mapped.get(comment.id);
    if (!anchor) return resetCommentPosition(comment, sourceText(source));
    const previous = geometry(comment);
    const removedAnchor = sameAnchor(previous, {
      ...anchor,
      from: comment.from,
      to: comment.to,
    })
      ? comment.removedAnchor
      : anchor.removedAnchor;
    const line = doc.lineAt(
      anchor.from < anchor.to ? anchor.to - 1 : anchor.from,
    ).number;
    if (
      anchor.from === comment.from &&
      anchor.to === comment.to &&
      line === comment.line &&
      removedAnchor === comment.removedAnchor &&
      Boolean(comment.positionReset) === Boolean(anchor.positionReset)
    )
      return comment;
    return {
      ...comment,
      from: anchor.from,
      to: anchor.to,
      line,
      ...(anchor.positionReset
        ? { positionReset: true }
        : comment.positionReset
          ? { positionReset: undefined }
          : {}),
      ...(removedAnchor
        ? { removedAnchor }
        : comment.removedAnchor
          ? { removedAnchor: undefined }
          : {}),
    };
  });
}

/** An immutable text/anchor revision. Preparing a transaction never alters its
 * parent. Message/provenance/UI metadata stays on the existing comment records. */
export class CommentDocument {
  private constructor(
    readonly source: SourceKey,
    readonly comments: InlineEditorComment[],
    readonly revision: number,
  ) {}

  static open(source: Source, comments: InlineEditorComment[]) {
    const text = key(source);
    return new CommentDocument(text, normalize(comments, text), 0);
  }

  private model() {
    let model = retained.get(this);
    if (!model) {
      model = DocumentModel.open(
        sourceText(this.source),
        this.comments.map(geometry),
        this.revision,
      );
      retain(this, model);
    }
    return model;
  }

  withComments(comments: InlineEditorComment[]) {
    const normalized = normalize(comments, this.source);
    const incoming = new Map(normalized.map((c) => [c.id, geometry(c)]));
    if (incoming.size !== normalized.length)
      throw new Error("Duplicate comment ID");
    const previous = new Map(this.comments.map((c) => [c.id, geometry(c)]));
    const operations: DocumentOperation[] = [];
    for (const id of previous.keys())
      if (!incoming.has(id)) operations.push({ type: "removeAnchor", id });
    for (const anchor of incoming.values()) {
      const before = previous.get(anchor.id);
      if (
        before &&
        sameAnchor({ ...before, resolved: anchor.resolved }, anchor)
      ) {
        if (before.resolved !== anchor.resolved)
          operations.push({
            type: "resolve",
            id: anchor.id,
            resolved: Boolean(anchor.resolved),
          });
      } else operations.push({ type: "putAnchor", anchor });
    }
    if (!operations.length) {
      if (
        normalized.length === this.comments.length &&
        normalized.every((c, i) => c === this.comments[i])
      )
        return this;
      const next = new CommentDocument(this.source, normalized, this.revision);
      const cached = retained.get(this);
      if (cached) retain(next, cached);
      return next;
    }
    const advanced = this.model().fork(operations, this.revision);
    const next = new CommentDocument(
      this.source,
      applyAnchors(normalized, advanced.anchors, this.source),
      advanced.revision,
    );
    retain(next, advanced);
    return next;
  }

  apply(changes: ChangeDesc, nextSource: Source) {
    const nextText = key(nextSource);
    if (
      this.source.length !== changes.length ||
      nextText.length !== changes.newLength
    )
      throw new Error("Comment update does not match the document revision");
    if (changes.empty) return this;
    const edits: { from: number; to: number; insert: string }[] = [];
    changes.iterChangedRanges((from, to, fromB, toB) =>
      edits.push({
        from,
        to,
        insert:
          typeof nextText === "string"
            ? nextText.slice(fromB, toB)
            : nextText.sliceString(fromB, toB),
      }),
    );
    // With no anchors, CodeMirror already owns the validated text operation.
    // Keep its revision without allocating a second manuscript buffer in WASM.
    // The first comment materializes that exact revision lazily.
    if (!this.comments.length) {
      const changed = edits.some(
        ({ from, to, insert }) =>
          insert !==
          (typeof this.source === "string"
            ? this.source.slice(from, to)
            : this.source.sliceString(from, to)),
      );
      return new CommentDocument(
        nextText,
        this.comments,
        this.revision + Number(changed),
      );
    }
    const advanced = this.model().fork(
      [{ type: "text", edits }],
      this.revision,
    );
    const next = new CommentDocument(
      nextText,
      applyAnchors(this.comments, advanced.anchors, nextText),
      advanced.revision,
    );
    retain(next, advanced);
    return next;
  }
}

/** Boundary adapter for snapshots outside a live editor (load/recovery). */
export function mapDocumentComments(
  comments: InlineEditorComment[],
  changes: ChangeDesc,
  nextSource: Source,
  previousSource?: Source,
): InlineEditorComment[] {
  if (!comments.length) return comments;
  if (previousSource === undefined) {
    if (
      comments.every(
        (c) => c.from < 0 || c.to > changes.length || c.from > c.to,
      )
    )
      return comments.map((c) =>
        resetCommentPosition(c, sourceText(key(nextSource))),
      );
    throw new Error("Comment updates require their source document revision");
  }
  // Invalid stored coordinates use a reset point in the destination document;
  // they cannot be interpreted as a real range in the prior revision.
  const previous = key(previousSource);
  const valid = comments.filter(
    (c) =>
      c.id &&
      c.from <= c.to &&
      boundary(previous, c.from) &&
      boundary(previous, c.to),
  );
  if (
    previous.length !== changes.length ||
    key(nextSource).length !== changes.newLength
  )
    throw new Error("Comment update does not match the document revision");
  if (valid.length === comments.length)
    return CommentDocument.open(previousSource, comments).apply(
      changes,
      nextSource,
    ).comments;
  const mapped = new Map(
    CommentDocument.open(previousSource, valid)
      .apply(changes, nextSource)
      .comments.map((c) => [c.id, c]),
  );
  return comments.map(
    (c) =>
      mapped.get(c.id) ?? resetCommentPosition(c, sourceText(key(nextSource))),
  );
}
