import { EditorView } from "@codemirror/view";
import { createDocumentChangeSet } from "./editor-history";

/** A text anchor and its vertical offset, independent of removed diff widgets. */
export interface ReviewViewport {
  document: string;
  position: number;
  offset: number;
  viewportTop: number;
  cursor: number;
  focus?: boolean;
}

export function captureReviewViewport(
  view: EditorView,
  position?: number,
): ReviewViewport {
  const { scrollTop, clientHeight } = view.scrollDOM;
  const cursor = view.state.selection.main.head;
  const cursorBlock = view.lineBlockAt(cursor);
  const anchor =
    position ??
    (cursorBlock.top >= scrollTop &&
    cursorBlock.bottom <= scrollTop + clientHeight
      ? cursor
      : view.lineBlockAtHeight(scrollTop).from);
  return {
    document: view.state.doc.toString(),
    position: anchor,
    offset: view.lineBlockAt(anchor).top - scrollTop,
    viewportTop: view.scrollDOM.getBoundingClientRect().top,
    cursor: position ?? cursor,
    focus: position !== undefined,
  };
}

export function mapReviewViewport(
  anchor: ReviewViewport,
  document: string,
): ReviewViewport {
  if (anchor.document === document) return anchor;
  const changes = createDocumentChangeSet(anchor.document, document);
  return {
    ...anchor,
    document,
    position: changes.mapPos(anchor.position, anchor.focus ? -1 : 1),
    cursor: changes.mapPos(anchor.cursor, anchor.focus ? -1 : 1),
  };
}

const restorations = new WeakMap<EditorView, () => void>();

export function cancelReviewViewport(view: EditorView) {
  restorations.get(view)?.();
}

/** Follow layout changes during the handoff, yielding immediately to user input. */
export function restoreReviewViewport(
  view: EditorView,
  anchor: ReviewViewport,
  onInteraction?: () => void,
) {
  cancelReviewViewport(view);
  let frame = 0;
  const apply = () => {
    frame = 0;
    if (anchor.focus) view.focus();
    const mapped = mapReviewViewport(anchor, view.state.doc.toString());
    view.dispatch({
      effects: EditorView.scrollIntoView(mapped.position, {
        y: "start",
        yMargin:
          mapped.offset +
          mapped.viewportTop -
          view.scrollDOM.getBoundingClientRect().top,
      }),
    });
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(apply);
  };
  const observer = new ResizeObserver(schedule);
  const stop = () => {
    cancelAnimationFrame(frame);
    observer.disconnect();
    for (const event of ["wheel", "pointerdown", "keydown", "touchstart"]) {
      view.dom.ownerDocument.removeEventListener(event, interacted, true);
    }
    restorations.delete(view);
  };
  const interacted = () => {
    stop();
    onInteraction?.();
  };
  for (const event of ["wheel", "pointerdown", "keydown", "touchstart"]) {
    view.dom.ownerDocument.addEventListener(event, interacted, {
      capture: true,
      passive: true,
    });
  }
  observer.observe(view.scrollDOM);
  observer.observe(view.contentDOM);
  restorations.set(view, stop);
  schedule();
}
