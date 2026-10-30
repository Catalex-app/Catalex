import { canHandleEscape, consumeKey } from "@/lib/keyboard-events";
// Comment IDs are shared by source cards and preview highlights.
let activeComment: string | null = null;
const listeners = new Set<() => void>();

export const getActiveComment = () => activeComment;
export function setActiveComment(id: string | null) {
  if (activeComment === id) return;
  activeComment = id;
  for (const listener of listeners) listener();
}

function pointerDown(event: PointerEvent) {
  const target = event.target as Element;
  const card = target.closest<HTMLElement>(
    ".cm-inlineCommentCard[data-inline-comment-id]",
  );
  if (card) {
    setActiveComment(card.dataset.inlineCommentId ?? null);
    return;
  }
  if (
    target.closest(
      "[data-comment-range-handle], [data-pdf-comment-surface], [data-comment-popup], [data-comment-layout-control]",
    )
  )
    return;
  setActiveComment(null);
}
function dismissOnEscape(event: KeyboardEvent) {
  // Drag cancellation consumes Escape in the capture phase.
  if (!activeComment || !canHandleEscape(event)) return;
  const editor = (event.target as Element)?.closest?.(".cm-editor");
  const ownsComment =
    editor &&
    Array.from(
      editor.querySelectorAll<HTMLElement>("[data-inline-comment-id]"),
    ).some((card) => card.dataset.inlineCommentId === activeComment);
  if (ownsComment) {
    consumeKey(event);
    setActiveComment(null);
  }
}
export function subscribeActiveComment(listener: () => void) {
  if (!listeners.size) {
    document.addEventListener("pointerdown", pointerDown, true);
    window.addEventListener("keydown", dismissOnEscape);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      document.removeEventListener("pointerdown", pointerDown, true);
      window.removeEventListener("keydown", dismissOnEscape);
    }
  };
}
