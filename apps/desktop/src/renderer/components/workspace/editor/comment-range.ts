import { StateEffect } from "@codemirror/state";
import type { InlineEditorComment } from "./inline-comments";

export const COMMENT_RANGE_HANDLE_OUTLINE =
  "0 0 0 1px var(--comment-range-handle-outline, white)";

export const commentRangePreviewEffect = StateEffect.define<{
  id: string;
  range: CommentRange;
} | null>();

export type CommentRangeEdge = "from" | "to";
export type CommentRange = Pick<InlineEditorComment, "from" | "to" | "line">;

/** Keep the opposite endpoint fixed and never collapse or invert a comment. */
export function resizeCommentRange(
  source: string,
  original: CommentRange,
  edge: CommentRangeEdge,
  offset: number,
): CommentRange | null {
  if (!Number.isInteger(offset) || offset < 0 || offset > source.length)
    return null;
  const from = edge === "from" ? offset : original.from;
  const to = edge === "to" ? offset : original.to;
  if (from >= to || to - from > 20_000 || !source.slice(from, to).trim())
    return null;
  return { from, to, line: source.slice(0, to - 1).split("\n").length };
}

/** A point expands in either direction around its original fixed position. */
export function expandPointCommentRange(
  source: string,
  original: CommentRange,
  offset: number,
): CommentRange | null {
  if (!Number.isInteger(offset) || offset < 0 || offset > source.length)
    return null;
  if (offset === original.from) return { ...original };
  return resizeCommentRange(
    source,
    original,
    offset < original.from ? "from" : "to",
    offset,
  );
}

/** A drag owns pointer capture; cancellation never commits its preview. */
export function startCommentRangeDrag(
  event: PointerEvent,
  handle: HTMLElement,
  move: (x: number, y: number) => void,
  finish: (commit: boolean) => void,
) {
  if (event.button !== 0) return () => {};
  event.preventDefault();
  event.stopPropagation();
  const doc = handle.ownerDocument;
  const pointerId = event.pointerId;
  let active = true;
  let frame = 0;
  let point = { x: event.clientX, y: event.clientY };
  const scroll =
    handle.closest<HTMLElement>('[data-testid="pdf-scroll-container"]') ??
    handle.closest(".cm-editor")?.querySelector<HTMLElement>(".cm-scroller");
  const autoScroll = () => {
    if (!active) return;
    if (scroll) {
      const rect = scroll.getBoundingClientRect();
      const delta =
        point.y < rect.top + 32
          ? Math.max(-18, (point.y - rect.top - 32) / 3)
          : point.y > rect.bottom - 32
            ? Math.min(18, (point.y - rect.bottom + 32) / 3)
            : 0;
      const before = scroll.scrollTop;
      if (point.x >= rect.left && point.x <= rect.right)
        scroll.scrollTop += delta;
      if (before !== scroll.scrollTop) move(point.x, point.y);
    }
    frame = requestAnimationFrame(autoScroll);
  };
  frame = requestAnimationFrame(autoScroll);
  handle.setPointerCapture(pointerId);
  const cleanup = (commit: boolean) => {
    if (!active) return;
    active = false;
    cancelAnimationFrame(frame);
    handle.removeEventListener("pointermove", onMove);
    handle.removeEventListener("pointerup", onUp);
    handle.removeEventListener("pointercancel", cancel);
    handle.removeEventListener("lostpointercapture", cancel);
    doc.removeEventListener("keydown", onKey, true);
    doc.defaultView?.removeEventListener("blur", cancel);
    if (handle.hasPointerCapture(pointerId))
      handle.releasePointerCapture(pointerId);
    finish(commit);
  };
  const onMove = (e: PointerEvent) => {
    if (e.pointerId !== pointerId) return;
    e.preventDefault();
    point = { x: e.clientX, y: e.clientY };
    move(e.clientX, e.clientY);
  };
  const onUp = (e: PointerEvent) => {
    if (e.pointerId !== pointerId) return;
    e.preventDefault();
    e.stopPropagation();
    cleanup(true);
  };
  const cancel = () => cleanup(false);
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopImmediatePropagation();
    cancel();
  };
  handle.addEventListener("pointermove", onMove);
  handle.addEventListener("pointerup", onUp);
  handle.addEventListener("pointercancel", cancel);
  handle.addEventListener("lostpointercapture", cancel);
  doc.addEventListener("keydown", onKey, true);
  doc.defaultView?.addEventListener("blur", cancel);
  return cancel;
}

export function styleCommentRangeHandle(
  handle: HTMLButtonElement,
  edge: CommentRangeEdge,
  agent: boolean,
) {
  handle.type = "button";
  handle.dataset.commentRangeHandle = edge;
  handle.setAttribute(
    "aria-label",
    `Resize comment ${edge === "from" ? "start" : "end"}`,
  );
  handle.title = `Drag to change selection ${edge === "from" ? "start" : "end"}`;
  Object.assign(handle.style, {
    position: "absolute",
    width: "14px",
    padding: "0",
    border: "0",
    background: "transparent",
    cursor: "ew-resize",
    touchAction: "none",
    pointerEvents: "auto",
    zIndex: "8",
    transform: "translateX(-50%)",
    color: agent ? "#7252b5" : "#ca8a04",
  });
  const tip = document.createElement("span");
  Object.assign(tip.style, {
    position: "absolute",
    left: "6px",
    top: "10%",
    bottom: "10%",
    width: "2px",
    borderRadius: "1px",
    background: "currentColor",
    boxShadow: COMMENT_RANGE_HANDLE_OUTLINE,
  });
  handle.append(tip);
  handle.onclick = (event) => {
    event.preventDefault();
    event.stopPropagation();
  };
}
