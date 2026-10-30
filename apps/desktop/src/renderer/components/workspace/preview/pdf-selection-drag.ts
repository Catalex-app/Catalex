import { canHandleEscape } from "@/lib/keyboard-events";
import { useEffect, type RefObject } from "react";

type Endpoint = { node: Node; offset: number };

/** One owner for PDF mouse dragging; the DOM Selection remains the copy source. */
export function usePdfSelectionDrag(
  viewportRef: RefObject<HTMLDivElement | null>,
  prepareSelectAll: () => void,
  finishSelection: () => void,
) {
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    let anchor: Endpoint | null = null;
    let frame = 0;
    let x = 0,
      y = 0;
    let pendingAll: MutationObserver | null = null;
    const lines = () => [
      ...viewport.querySelectorAll<SVGTextElement>(".mupdf-text-layer text"),
    ];
    const endpoint = (): Endpoint | null => {
      // Choose a page by vertical distance, then a row by height and column.
      const distance = (value: number, start: number, end: number) =>
        Math.max(start - value, value - end, 0);
      const page = [...viewport.querySelectorAll(".mupdf-page")].sort(
        (a, b) => {
          const ar = a.getBoundingClientRect(),
            br = b.getBoundingClientRect();
          return (
            distance(y, ar.top, ar.bottom) - distance(y, br.top, br.bottom)
          );
        },
      )[0];
      const row = [
        ...(page?.querySelectorAll<SVGTextElement>(".mupdf-text-layer text") ??
          []),
      ]
        .map((element) => ({ element, rect: element.getBoundingClientRect() }))
        .sort(
          (a, b) =>
            distance(y, a.rect.top, a.rect.bottom) -
              distance(y, b.rect.top, b.rect.bottom) ||
            distance(x, a.rect.left, a.rect.right) -
              distance(x, b.rect.left, b.rect.right),
        )[0];
      const node = row?.element.firstChild;
      if (!node || !row) return null;
      const text = row.element;
      const matrix = text.getScreenCTM();
      if (!matrix) return null;
      const point = new DOMPoint(x, y).matrixTransform(matrix.inverse());
      const chars = Array.from(node.textContent ?? "");
      let offset = 0;
      for (
        let index = 0;
        index < Math.min(chars.length, text.getNumberOfChars());
        index++
      ) {
        const start = text.getStartPositionOfChar(index);
        const end =
          index + 1 < text.getNumberOfChars()
            ? text.getStartPositionOfChar(index + 1)
            : text.getEndPositionOfChar(index);
        if (point.x < (start.x + end.x) / 2) break;
        offset += chars[index].length;
      }
      return { node, offset };
    };
    const update = () => {
      if (!anchor?.node.isConnected) return;
      const focus = endpoint();
      const selection = window.getSelection();
      if (!focus || !selection) return;
      if (
        selection.anchorNode === anchor.node &&
        selection.anchorOffset === anchor.offset &&
        selection.focusNode === focus.node &&
        selection.focusOffset === focus.offset
      )
        return;
      selection.setBaseAndExtent(
        anchor.node,
        anchor.offset,
        focus.node,
        focus.offset,
      );
    };
    const stop = () => {
      const wasSelecting = anchor !== null || pendingAll !== null;
      anchor = null;
      cancelAnimationFrame(frame);
      pendingAll?.disconnect();
      pendingAll = null;
      if (wasSelecting) finishSelection();
    };
    const down = (event: MouseEvent) => {
      if (pendingAll) stop();
      if (
        event.button !== 0 ||
        event.detail > 1 ||
        !(event.target instanceof Element) ||
        !(
          event.target.closest(".mupdf-text-layer") ||
          event.target instanceof HTMLCanvasElement ||
          event.target.classList.contains("mupdf-page")
        )
      )
        return;
      x = event.clientX;
      y = event.clientY;
      const hit = endpoint();
      if (!hit) return;
      // Keep text nodes mounted so crossing a page boundary cannot detach the anchor.
      prepareSelectAll();
      const selection = window.getSelection();
      anchor =
        event.shiftKey &&
        selection?.anchorNode &&
        viewport.contains(selection.anchorNode)
          ? { node: selection.anchorNode, offset: selection.anchorOffset }
          : hit;
      event.preventDefault();
      viewport.focus({ preventScroll: true });
      update();
      const tick = () => {
        if (!anchor) return;
        const rect = viewport.getBoundingClientRect();
        const speed =
          y < rect.top + 24
            ? -Math.min(18, (rect.top + 24 - y) / 3)
            : y > rect.bottom - 24
              ? Math.min(18, (y - rect.bottom + 24) / 3)
              : 0;
        if (speed) viewport.scrollTop += speed;
        update();
        frame = requestAnimationFrame(tick);
      };
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(tick);
    };
    const move = (event: MouseEvent) => {
      if (!anchor) return;
      if (!(event.buttons & 1)) {
        stop();
        return;
      }
      x = event.clientX;
      y = event.clientY;
      event.preventDefault();
      update();
    };
    const up = () => {
      if (anchor) update();
      stop();
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.target !== viewport) return;
      if (
        canHandleEscape(event) &&
        (anchor || pendingAll || window.getSelection()?.isCollapsed === false)
      ) {
        // The viewer owns clearing both the DOM and retained selection.
        // Stop dragging, but leave Escape available to that shared handler.
        stop();
      }
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "a")
        return;
      event.preventDefault();
      stop();
      prepareSelectAll();
      const select = () => {
        if (
          viewport.querySelectorAll(".mupdf-page").length !==
          viewport.querySelectorAll(".mupdf-text-layer").length
        )
          return;
        const text = lines();
        const first = text[0]?.firstChild,
          last = text[text.length - 1]?.firstChild;
        if (first && last)
          window
            .getSelection()
            ?.setBaseAndExtent(first, 0, last, last.textContent?.length ?? 0);
        pendingAll?.disconnect();
        pendingAll = null;
        finishSelection();
      };
      pendingAll?.disconnect();
      pendingAll = new MutationObserver(select);
      pendingAll.observe(viewport, { childList: true, subtree: true });
      select();
    };
    const copy = (event: ClipboardEvent) => {
      const selection = window.getSelection();
      if (
        !selection?.rangeCount ||
        !selection.anchorNode ||
        !selection.focusNode ||
        !viewport.contains(selection.anchorNode) ||
        !viewport.contains(selection.focusNode) ||
        !selection.anchorNode.parentElement?.closest(".mupdf-text-layer")
      )
        return;
      const range = selection.getRangeAt(0);
      const content = lines()
        .flatMap((line) => {
          const node = line.firstChild;
          if (!node || !range.intersectsNode(node)) return [];
          const start = range.startContainer === node ? range.startOffset : 0;
          const end =
            range.endContainer === node
              ? range.endOffset
              : node.textContent!.length;
          return end > start ? [node.textContent!.slice(start, end)] : [];
        })
        .join("\n");
      if (!event.clipboardData) return;
      event.preventDefault();
      event.clipboardData.setData("text/plain", content);
    };
    viewport.addEventListener("mousedown", down);
    viewport.addEventListener("keydown", keydown);
    document.addEventListener("mousemove", move, true);
    document.addEventListener("mouseup", up);
    document.addEventListener("copy", copy);
    window.addEventListener("blur", stop);
    return () => {
      stop();
      viewport.removeEventListener("mousedown", down);
      viewport.removeEventListener("keydown", keydown);
      document.removeEventListener("mousemove", move, true);
      document.removeEventListener("mouseup", up);
      document.removeEventListener("copy", copy);
      window.removeEventListener("blur", stop);
    };
  }, [viewportRef, prepareSelectAll, finishSelection]);
}
