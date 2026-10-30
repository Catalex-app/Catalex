import { useLayoutEffect, useRef } from "react";
import { StyleModule } from "style-mod";
import {
  InlineCommentCardWidget,
  inlineCommentStyles,
  type InlineCommentActions,
  type InlineEditorComment,
} from "./inline-comments";

const styles = new StyleModule(inlineCommentStyles, {
  finish: (selector) =>
    selector
      .split(",")
      .map((part) => `.inline-comment-popup ${part.trim()}`)
      .join(", "),
});
const layout = { requestMeasure() {} };

/** Mount the editor's card renderer without creating a source editor. */
export function InlineCommentCard({
  comment,
  actions,
}: {
  comment: InlineEditorComment;
  actions: InlineCommentActions;
}) {
  const host = useRef<HTMLDivElement>(null);
  const mounted = useRef<{
    widget: InlineCommentCardWidget;
    dom: HTMLElement;
  } | null>(null);
  useLayoutEffect(() => {
    StyleModule.mount(document, styles);
    const widget = new InlineCommentCardWidget(comment, 0, actions);
    const previous = mounted.current;
    if (previous && widget.updateDOM(previous.dom, layout)) {
      mounted.current = { widget, dom: previous.dom };
    } else {
      if (previous) previous.widget.destroy(previous.dom);
      const dom = widget.toDOM(layout);
      dom.style.margin = "0";
      dom.style.width = "100%";
      host.current?.replaceChildren(dom);
      mounted.current = { widget, dom };
    }
  }, [comment, actions]);
  useLayoutEffect(
    () => () => {
      const previous = mounted.current;
      if (previous) previous.widget.destroy(previous.dom);
      mounted.current = null;
    },
    [],
  );
  return <div ref={host} className="inline-comment-popup" />;
}
