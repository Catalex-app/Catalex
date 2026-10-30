import { useEffect, type RefObject } from "react";
import { pdfSelectionFragments } from "./pdf-selection-geometry";

/** Paint native selection in each page's SVG coordinate system. Zoom and scroll
 * then move it with the text without an independent positioning loop. */
export function PdfSelectionHighlight({
  viewportRef,
  retainedSelection,
}: {
  viewportRef: RefObject<HTMLDivElement | null>;
  retainedSelection: RefObject<Range | null>;
}) {
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const groups: SVGGElement[] = [];
    let frame = 0;
    const clear = () => {
      for (const group of groups) group.remove();
      groups.length = 0;
    };
    const paint = () => {
      frame = 0;
      clear();
      const selection = window.getSelection();
      const active =
        viewport.contains(document.activeElement) ||
        Boolean(
          document.activeElement?.closest("[data-selection-toolbar]") &&
            selection?.anchorNode &&
            viewport.contains(selection.anchorNode),
        );
      const nativeRange =
        selection?.rangeCount && !selection.isCollapsed
          ? selection.getRangeAt(0)
          : null;
      const range = active
        ? nativeRange
        : (retainedSelection.current ?? nativeRange);
      if (
        !range ||
        !viewport.contains(range.startContainer) ||
        !viewport.contains(range.endContainer)
      )
        return;
      const pages = new Map<SVGSVGElement, SVGGElement>();
      for (const fragment of pdfSelectionFragments(range, viewport)) {
        const svg = fragment.element.ownerSVGElement;
        if (!svg) continue;
        let group = pages.get(svg);
        if (!group) {
          group = document.createElementNS("http://www.w3.org/2000/svg", "g");
          group.setAttribute("aria-hidden", "true");
          group.setAttribute("data-pdf-selection-highlight", "true");
          group.style.pointerEvents = "none";
          svg.prepend(group);
          pages.set(svg, group);
          groups.push(group);
        }
        const rect = document.createElementNS(
          "http://www.w3.org/2000/svg",
          "rect",
        );
        rect.setAttribute("class", "pdf-selection-highlight");
        if (!active) rect.style.fill = "rgba(140, 140, 140, 0.25)";
        rect.setAttribute("x", String(fragment.left));
        rect.setAttribute("y", String(fragment.top));
        rect.setAttribute("width", String(fragment.right - fragment.left));
        rect.setAttribute("height", String(fragment.bottom - fragment.top));
        group.append(rect);
      }
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(paint);
    };
    viewport.classList.add("pdf-selection-managed");
    document.addEventListener("selectionchange", schedule);
    document.addEventListener("focusin", schedule, true);
    document.addEventListener("focusout", schedule, true);
    // Rebuild when virtualization replaces text nodes, but ignore our own paint.
    const observer = new MutationObserver((records) => {
      if (
        records.some((record) =>
          [...record.addedNodes, ...record.removedNodes].some(
            (node) =>
              node instanceof Element &&
              !node.closest("[data-pdf-selection-highlight]"),
          ),
        )
      )
        schedule();
    });
    observer.observe(viewport, { childList: true, subtree: true });
    schedule();
    return () => {
      observer.disconnect();
      document.removeEventListener("selectionchange", schedule);
      document.removeEventListener("focusin", schedule, true);
      document.removeEventListener("focusout", schedule, true);
      cancelAnimationFrame(frame);
      clear();
      viewport.classList.remove("pdf-selection-managed");
    };
  }, [viewportRef, retainedSelection]);
  return null;
}
