import {
  getActiveComment,
  setActiveComment,
  subscribeActiveComment,
} from "./active-comment";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import type {
  InlineCommentActions,
  InlineEditorComment,
} from "./inline-comments";
import {
  resizeCommentRange,
  expandPointCommentRange,
  commentRangePreviewEffect,
  startCommentRangeDrag,
  styleCommentRangeHandle,
  COMMENT_RANGE_HANDLE_OUTLINE,
  type CommentRange,
} from "./comment-range";

export function commentRangeExtension(
  read: () => {
    comments: InlineEditorComment[];
    actions: InlineCommentActions;
  },
) {
  return ViewPlugin.fromClass(
    class {
      destroyed = false;
      overlay = document.createElement("div");
      frame = 0;
      cancelDrag?: () => void;
      preview: CommentRange | null = null;
      active: string | null = null;
      unsubscribe: () => void;
      constructor(readonly view: EditorView) {
        this.active = getActiveComment();
        this.unsubscribe = subscribeActiveComment(() => {
          this.active = getActiveComment();
          this.render();
        });
        Object.assign(this.overlay.style, {
          position: "absolute",
          inset: "0",
          pointerEvents: "none",
          overflow: "hidden",
          zIndex: "6",
        });
        this.overlay.dataset.commentRangeOverlay = "";
        view.dom.append(this.overlay);
        view.dom.addEventListener("pointerdown", this.focus, true);
        view.dom.addEventListener("click", this.focus, true);
        view.dom.addEventListener("focusin", this.focus, true);

        this.render();
      }
      focus = (event: Event) => {
        const element = event.target as HTMLElement;
        const id = element.closest<HTMLElement>(
          ".cm-inlineCommentCard[data-inline-comment-id]",
        )?.dataset.inlineCommentId;
        if (!id) {
          if (
            element.closest(".cm-content") &&
            !element.closest(".cm-inlineCommentCard")
          )
            setActiveComment(null);
          return;
        }
        if (id === this.active) return;
        setActiveComment(id);
      };
      update(update: ViewUpdate) {
        if (update.docChanged)
          queueMicrotask(() => {
            if (!this.destroyed) {
              this.cancelDrag?.();
              this.render();
            }
          });
        else if (
          update.transactions.some((transaction) => transaction.effects.length)
        )
          this.render();
      }
      render() {
        // Keep the captured pointer target alive while its preview changes.
        if (this.cancelDrag) return;
        cancelAnimationFrame(this.frame);
        this.overlay.replaceChildren();
        const { comments, actions } = read();
        const handles: {
          handle: HTMLButtonElement;
          comment: InlineEditorComment;
          edge: "from" | "to";
          point: boolean;
        }[] = [];
        for (const comment of comments) {
          const point = comment.from === comment.to;
          if (
            comment.resolved ||
            comment.from < 0 ||
            comment.from > comment.to ||
            comment.to > this.view.state.doc.length ||
            (!point && comment.id !== this.active)
          )
            continue;
          if (!point && !actions.onResize) continue;
          for (const edge of point
            ? (["from"] as const)
            : (["from", "to"] as const)) {
            const handle = document.createElement("button");
            styleCommentRangeHandle(handle, edge, !!comment.origin);
            if (point) {
              handle.dataset.commentRangeHandle = "point";
              handle.setAttribute(
                "aria-label",
                "Expand point comment selection",
              );
              handle.title =
                "Drag left or right to select text for this comment";
            }
            handle.style.visibility = "hidden";
            handle.onpointerdown = (event) => {
              if (event.button !== 0) return;
              if (!actions.onResize || this.view.state.doc.length === 0) {
                event.preventDefault();
                setActiveComment(comment.id);
                return;
              }
              const source = this.view.state.doc.toString();
              this.preview = {
                from: comment.from,
                to: comment.to,
                line: comment.line,
              };
              this.cancelDrag = startCommentRangeDrag(
                event,
                handle,
                (x, y) => {
                  this.overlay.style.visibility = "hidden";
                  const offset = this.view.posAtCoords({ x, y });
                  this.overlay.style.visibility = "visible";
                  const range =
                    offset == null
                      ? null
                      : point
                        ? expandPointCommentRange(source, comment, offset)
                        : resizeCommentRange(source, comment, edge, offset);
                  if (!range) return;
                  this.preview = range;
                  this.view.dispatch({
                    effects: commentRangePreviewEffect.of({
                      id: comment.id,
                      range,
                    }),
                  });
                },
                (commit) => {
                  const range = this.preview;
                  this.preview = null;
                  this.cancelDrag = undefined;
                  if (
                    commit &&
                    range &&
                    (range.from !== comment.from || range.to !== comment.to)
                  ) {
                    const latest = read();
                    const current = latest.comments.find(
                      (item) => item.id === comment.id,
                    );
                    if (
                      current?.from === comment.from &&
                      current.to === comment.to
                    )
                      latest.actions.onResize?.(comment.id, range);
                  }
                  if (!this.destroyed)
                    queueMicrotask(() => {
                      if (!this.destroyed) {
                        this.view.dispatch({
                          effects: commentRangePreviewEffect.of(null),
                        });
                        this.render();
                      }
                    });
                },
              );
              setActiveComment(comment.id);
            };
            this.overlay.append(handle);
            handles.push({ handle, comment, edge, point });
          }
        }
        if (!handles.length) return;
        const measure = () => {
          const origin = this.view.dom.getBoundingClientRect();
          const viewport = this.view.scrollDOM.getBoundingClientRect();
          for (const { handle, comment, edge, point } of handles) {
            const range =
              comment.id === this.active ? (this.preview ?? comment) : comment;
            const position =
              point && this.preview && comment.id === this.active
                ? range.from < comment.from
                  ? range.from
                  : range.to
                : range[edge];
            const rect = this.view.coordsAtPos(
              position,
              edge === "from" ? 1 : -1,
            );
            handle.style.display = rect ? "block" : "none";
            if (point) {
              const tip = handle.firstElementChild as HTMLElement;
              tip.style.width = comment.id === this.active ? "2px" : "1px";
              tip.style.boxShadow =
                comment.id === this.active
                  ? COMMENT_RANGE_HANDLE_OUTLINE
                  : "none";
              tip.style.opacity = comment.id === this.active ? "1" : "0.8";
            }
            if (rect)
              Object.assign(handle.style, {
                visibility:
                  rect.top >= viewport.top && rect.bottom <= viewport.bottom
                    ? "visible"
                    : "hidden",
                left: `${rect.left - origin.left}px`,
                top: `${rect.top - origin.top}px`,
                height: `${rect.bottom - rect.top}px`,
              });
          }
          this.frame = requestAnimationFrame(measure);
        };
        this.frame = requestAnimationFrame(measure);
      }
      destroy() {
        this.destroyed = true;
        this.cancelDrag?.();
        cancelAnimationFrame(this.frame);
        this.overlay.remove();
        this.view.dom.removeEventListener("pointerdown", this.focus, true);
        this.view.dom.removeEventListener("click", this.focus, true);
        this.view.dom.removeEventListener("focusin", this.focus, true);
        this.unsubscribe();
      }
    },
  );
}
