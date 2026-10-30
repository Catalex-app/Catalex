import {
  MAX_PDF_DETAIL_PIXELS,
  MAX_PDF_DETAIL_SIDE,
  type PageRasterRegion,
  type Rect,
} from "@/lib/mupdf/types";

/** Visible page coordinates plus a small scrolling margin, snapped to pixels. */
export function pdfDetailRegion(
  pageWidth: number,
  pageHeight: number,
  visible: Rect,
  requestedScale: number,
): PageRasterRegion | null {
  const left = Math.max(0, visible.x);
  const top = Math.max(0, visible.y);
  const right = Math.min(pageWidth, visible.x + visible.w);
  const bottom = Math.min(pageHeight, visible.y + visible.h);
  if (right <= left || bottom <= top) return null;
  const x = Math.max(0, left - (right - left) * 0.15);
  const y = Math.max(0, top - (bottom - top) * 0.15);
  const w = Math.min(pageWidth, right + (right - left) * 0.15) - x;
  const h = Math.min(pageHeight, bottom + (bottom - top) * 0.15) - y;
  // Reserve rounding headroom for the outward-snapped rectangle.
  const scale = Math.min(
    requestedScale,
    Math.sqrt((MAX_PDF_DETAIL_PIXELS - 4 * MAX_PDF_DETAIL_SIDE) / (w * h)),
    (MAX_PDF_DETAIL_SIDE - 2) / Math.max(w, h),
  );
  const px = Math.floor(x * scale);
  const py = Math.floor(y * scale);
  return {
    x: px,
    y: py,
    width: Math.ceil((x + w) * scale) - px,
    height: Math.ceil((y + h) * scale) - py,
    scale,
  };
}

export function pdfDetailCovers(
  region: PageRasterRegion,
  visible: Rect,
): boolean {
  return (
    region.x / region.scale <= visible.x &&
    region.y / region.scale <= visible.y &&
    (region.x + region.width) / region.scale >= visible.x + visible.w &&
    (region.y + region.height) / region.scale >= visible.y + visible.h
  );
}
