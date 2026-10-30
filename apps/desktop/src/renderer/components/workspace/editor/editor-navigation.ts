import type { EditorView } from "@codemirror/view";
import { scrollForNavigation } from "@/lib/navigation-scroll";

export function scrollToEditorPosition(
  view: EditorView,
  position: number,
  commentId?: string,
) {
  const scroll = view.scrollDOM;
  scrollForNavigation(scroll, () => {
    const card = commentId
      ? Array.from(
          view.dom.querySelectorAll<HTMLElement>(".cm-inlineCommentCard"),
        ).find((candidate) => candidate.dataset.inlineCommentId === commentId)
      : null;
    const bounds = card?.getBoundingClientRect();
    const block = bounds
      ? null
      : view.lineBlockAt(
          Math.max(0, Math.min(position, view.state.doc.length)),
        );
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
  });
}
