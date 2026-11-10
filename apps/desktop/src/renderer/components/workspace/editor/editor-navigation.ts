import type { EditorView } from "@codemirror/view";
import {
  highlightNavigationTarget,
  scrollForNavigation,
} from "@/lib/navigation-scroll";

export function scrollToEditorPosition(
  view: EditorView,
  position: number,
  { commentId, highlight }: { commentId?: string; highlight?: boolean } = {},
) {
  const scroll = view.scrollDOM;
  const targetPosition = Math.max(0, Math.min(position, view.state.doc.length));
  const destination = () => {
    const card = commentId
      ? Array.from(
          view.dom.querySelectorAll<HTMLElement>(".cm-inlineCommentCard"),
        ).find((candidate) => candidate.dataset.inlineCommentId === commentId)
      : null;
    const bounds = card?.getBoundingClientRect();
    const block = bounds ? null : view.lineBlockAt(targetPosition);
    const center = bounds
      ? bounds.top + bounds.height / 2
      : view.documentTop + block!.top + block!.height / 2;
    return {
      top:
        scroll.scrollTop +
        center -
        scroll.getBoundingClientRect().top -
        scroll.clientHeight / 2,
    };
  };
  scrollForNavigation(
    scroll,
    destination,
    highlight
      ? () =>
          highlightNavigationTarget(scroll, "editor", () => {
            if (targetPosition > view.state.doc.length) return null;
            const { node } = view.domAtPos(targetPosition);
            const element = node instanceof Element ? node : node.parentElement;
            return (
              element?.closest(".cm-line")?.getBoundingClientRect() ?? null
            );
          })
      : undefined,
  );
}
