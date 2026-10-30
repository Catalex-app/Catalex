import type { PageSize } from "@/lib/mupdf/types";
import {
  cancelNavigationScroll,
  scrollForNavigation,
} from "@/lib/navigation-scroll";

/** A document point held at the viewport center, independent of zoom. */
export interface PdfReadingAnchor {
  page: number;
  pdfX: number;
  pdfY: number;
  viewportX?: number;
  viewportY?: number;
  atTop?: boolean;
}

export interface PdfReadingAnchorControl {
  read: () => PdfReadingAnchor | null;
  align: (anchor: PdfReadingAnchor, animate?: boolean) => void;
  interpolate: (
    from: PdfReadingAnchor,
    to: PdfReadingAnchor,
    fraction: number,
  ) => PdfReadingAnchor;
  restore: () => void;
  preserving: () => boolean;
}

export function readPdfReadingAnchor(
  container: HTMLElement,
  sizes: PageSize[],
): PdfReadingAnchor | null {
  if (container.clientWidth <= 1 || container.clientHeight <= 1) return null;
  const viewport = container.getBoundingClientRect();
  const centerX = viewport.left + container.clientWidth / 2;
  const centerY = viewport.top + container.clientHeight / 2;
  const at = findPdfPageAtY(container, sizes.length, centerY);
  const next = pdfPageElement(container, at);
  const previous = pdfPageElement(container, at - 1);
  const distance = (page: HTMLElement | null) => {
    const rect = page?.getBoundingClientRect();
    return rect
      ? Math.max(rect.top - centerY, centerY - rect.bottom, 0)
      : Infinity;
  };
  const closest = distance(previous) < distance(next) ? previous : next;
  if (!closest) return null;
  const page = Number(closest.dataset.pageNumber);
  const size = sizes[page - 1];
  const rect = closest.getBoundingClientRect();
  if (!size || rect.width <= 0 || rect.height <= 0) return null;
  const x = Math.max(0, Math.min(rect.width, centerX - rect.left));
  const y = Math.max(0, Math.min(rect.height, centerY - rect.top));
  return {
    page,
    pdfX: (x / rect.width) * size.width,
    pdfY: (y / rect.height) * size.height,
    // In page gaps, preserve the nearest edge at its actual viewport position.
    viewportX: (rect.left + x - viewport.left) / container.clientWidth,
    viewportY: (rect.top + y - viewport.top) / container.clientHeight,
    atTop: container.scrollTop <= 1,
  };
}

export function alignPdfReadingAnchor(
  container: HTMLElement,
  sizes: PageSize[],
  anchor: PdfReadingAnchor,
  animate = false,
): DOMRect | null {
  // A collapsed pane still has laid-out pages. Position them before reopening
  // so its first visible frame already shows the intended reading location.
  if (container.clientHeight <= 1) return null;
  const page = pdfPageElement(container, anchor.page);
  const size = sizes[anchor.page - 1];
  if (!page || !size) return null;
  const viewport = container.getBoundingClientRect();
  const rect = page.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  const left =
    container.scrollLeft +
    rect.left +
    (anchor.pdfX / size.width) * rect.width -
    viewport.left -
    container.clientWidth * (anchor.viewportX ?? 0.5);
  const top = anchor.atTop
    ? 0
    : container.scrollTop +
      rect.top +
      (anchor.pdfY / size.height) * rect.height -
      viewport.top -
      container.clientHeight * (anchor.viewportY ?? 0.5);
  if (animate) scrollForNavigation(container, { top, left });
  else {
    cancelNavigationScroll(container);
    container.scrollTop = top;
    container.scrollLeft = left;
  }
  return rect;
}

export const PDF_PAGE_GAP = 12;

/** Page shells are indexed direct children even when their bitmap is virtualized. */
export function pdfPageElement(
  container: HTMLElement,
  page: number,
): HTMLElement | null {
  const content =
    container.querySelector("[data-pdf-scroll-content]") ?? container;
  const candidate = content.children.item(page - 1) as HTMLElement | null;
  if (candidate?.dataset.pageNumber === String(page)) return candidate;
  return container.querySelector(`[data-page-number="${page}"]`);
}

/** Binary search avoids measuring every page on every scroll frame. */
export function findPdfPageAtY(
  container: HTMLElement,
  count: number,
  y: number,
) {
  let low = 1;
  let high = Math.max(1, count);
  while (low < high) {
    const mid = (low + high) >>> 1;
    const rect = pdfPageElement(container, mid)?.getBoundingClientRect();
    if (rect && rect.bottom <= y) low = mid + 1;
    else high = mid;
  }
  return low;
}

export function createPdfAnchorInterpolator(sizes: PageSize[]) {
  const starts = [0];
  for (const size of sizes)
    starts.push(starts[starts.length - 1] + size.height + PDF_PAGE_GAP);
  return (
    from: PdfReadingAnchor,
    to: PdfReadingAnchor,
    fraction: number,
  ): PdfReadingAnchor => {
    const start = starts[from.page - 1];
    const end = starts[to.page - 1];
    if (start === undefined || end === undefined || sizes.length === 0)
      return from;
    const f = Math.max(0, Math.min(1, fraction));
    const y = start + from.pdfY + (end + to.pdfY - start - from.pdfY) * f;
    let low = 0;
    let high = sizes.length;
    while (low + 1 < high) {
      const mid = (low + high) >>> 1;
      if (starts[mid] <= y) low = mid;
      else high = mid;
    }
    return {
      page: low + 1,
      pdfX: from.pdfX + (to.pdfX - from.pdfX) * f,
      pdfY: y - starts[low],
    };
  };
}
