import { EditorView } from "@codemirror/view";
import { highlightNavigationTarget } from "@/lib/navigation-scroll";
import type {
  PdfReadingAnchor,
  PdfReadingAnchorControl,
} from "./preview/pdf-reading-anchor";

export interface EditorScrollPosition {
  scrollTop: number;
  topLineFrom: number;
  topLineOffset: number;
}

export function editorViewInPanel(panel: HTMLElement | null) {
  const editor = panel?.querySelector<HTMLElement>(".cm-editor");
  return editor ? EditorView.findFromDOM(editor) : null;
}

export function captureEditorScroll(view: EditorView): EditorScrollPosition {
  const scrollTop = view.scrollDOM.scrollTop;
  const topBlock = view.lineBlockAtHeight(scrollTop);
  return {
    scrollTop,
    topLineFrom: topBlock.from,
    topLineOffset: scrollTop - topBlock.top,
  };
}

export function readEditorScroll(
  panel: HTMLElement | null,
  includeTop = false,
) {
  const view = editorViewInPanel(panel);
  return view?.scrollDOM.clientHeight &&
    (includeTop || view.scrollDOM.scrollTop > 0)
    ? captureEditorScroll(view)
    : undefined;
}

export function restoreEditorPosition(
  view: EditorView,
  position: EditorScrollPosition | number,
  inPopOut = false,
) {
  const offset = Math.min(
    typeof position === "number" ? position : position.topLineFrom,
    view.state.doc.length,
  );
  if (typeof position !== "number" && !inPopOut) {
    const block = view.lineBlockAt(offset);
    const top = block.top + position.topLineOffset;
    if (view.scrollDOM.scrollTop !== top) view.scrollDOM.scrollTop = top;
    return;
  }
  view.dispatch({
    effects: EditorView.scrollIntoView(
      offset,
      typeof position === "number"
        ? { y: "center" }
        : { y: "start", yMargin: -position.topLineOffset },
    ),
  });
}

export function editorViewportCenter(view: EditorView) {
  const top = view.scrollDOM.getBoundingClientRect().top;
  return view.lineBlockAtHeight(
    top + view.scrollDOM.clientHeight / 2 - view.documentTop,
  ).from;
}

export function editorReadingPosition(view: EditorView, cursor: number) {
  const bounds = view.coordsAtPos(Math.min(cursor, view.state.doc.length));
  const viewport = view.scrollDOM.getBoundingClientRect();
  return bounds &&
    bounds.bottom > viewport.top &&
    bounds.top < viewport.bottom &&
    bounds.right >= viewport.left &&
    bounds.left <= viewport.right
    ? cursor
    : editorViewportCenter(view);
}

export const SOURCE_ELEMENT_SELECTOR = "[data-markdown-source-start]";

export function sourceRangeFromElement(element: HTMLElement) {
  const start = Number(element.dataset.markdownSourceStart);
  const end = Number(element.dataset.markdownSourceEnd);
  if (!Number.isFinite(start)) return null;
  return {
    start,
    end: Number.isFinite(end) ? Math.max(start, end) : start,
  };
}

function sourceElements(frameDocument: Document) {
  return Array.from(
    frameDocument.querySelectorAll<HTMLElement>(SOURCE_ELEMENT_SELECTOR),
  );
}

export function sourceElementForPosition(
  frameDocument: Document,
  position: number,
) {
  let closest: { element: HTMLElement; distance: number } | null = null;
  let containing: { element: HTMLElement; span: number } | null = null;

  for (const element of sourceElements(frameDocument)) {
    const range = sourceRangeFromElement(element);
    if (!range) continue;
    if (position >= range.start && position <= range.end) {
      const span = range.end - range.start;
      if (!containing || span < containing.span) {
        containing = { element, span };
      }
      continue;
    }
    const distance = Math.min(
      Math.abs(position - range.start),
      Math.abs(position - range.end),
    );
    if (!closest || distance < closest.distance) {
      closest = { element, distance };
    }
  }

  return containing?.element ?? closest?.element ?? null;
}

function sourceElementAtPreviewCenter(frameDocument: Document) {
  const viewport = frameDocument.documentElement;
  const centerX = viewport.clientWidth / 2;
  const centerY = viewport.clientHeight / 2;
  const target = frameDocument.elementFromPoint(centerX, centerY);
  const targetSource = target?.closest<HTMLElement>(SOURCE_ELEMENT_SELECTOR);
  if (targetSource) return targetSource;

  let closest: { element: HTMLElement; distance: number } | null = null;
  for (const element of sourceElements(frameDocument)) {
    const rect = element.getBoundingClientRect();
    if (rect.bottom < 0 || rect.top > viewport.clientHeight) continue;
    const distance = Math.abs(rect.top + rect.height / 2 - centerY);
    if (!closest || distance < closest.distance) {
      closest = { element, distance };
    }
  }
  return closest?.element ?? null;
}

export function sourcePositionAtPreviewCenter(frameDocument: Document) {
  const element = sourceElementAtPreviewCenter(frameDocument);
  return element ? sourceRangeFromElement(element)?.start : undefined;
}

export function markdownFrame(panel: HTMLElement | null) {
  return panel?.querySelector("iframe")?.contentDocument ?? null;
}

export function readMarkdownPosition(frame: Document) {
  const element = sourceElementAtPreviewCenter(frame);
  if (!element) return undefined;
  const position = sourceRangeFromElement(element)?.start;
  if (position === undefined) return undefined;
  return { position, topOffset: element.getBoundingClientRect().top };
}

export type MarkdownReadingPosition = NonNullable<
  ReturnType<typeof readMarkdownPosition>
>;

export function restoreMarkdownPosition(
  frame: Document,
  position: number | MarkdownReadingPosition,
) {
  const element = sourceElementForPosition(
    frame,
    typeof position === "number" ? position : position.position,
  );
  if (typeof position === "number") {
    element?.scrollIntoView({ block: "center", inline: "nearest" });
  } else if (element && frame.scrollingElement) {
    const rect = element.getBoundingClientRect();
    frame.scrollingElement.scrollTop += rect.top - position.topOffset;
  }
}

export function highlightMarkdownPosition(frame: Document, position?: number) {
  const scroll = frame.scrollingElement as HTMLElement | null;
  if (!scroll) return;
  highlightNavigationTarget(
    scroll,
    "markdown",
    () =>
      (position === undefined
        ? sourceElementAtPreviewCenter(frame)
        : sourceElementForPosition(frame, position)
      )?.getBoundingClientRect() ?? null,
  );
}

export function readPdfPosition(control: PdfReadingAnchorControl | null) {
  return control?.read() ?? undefined;
}

export function restorePdfPosition(
  control: PdfReadingAnchorControl | null,
  position: PdfReadingAnchor,
) {
  control?.align(position);
}
