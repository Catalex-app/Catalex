export const MIN_PDF_SCALE = 0.25;
export const MAX_PDF_SCALE = 12;

export function clampPdfScale(scale: number): number {
  return Math.max(MIN_PDF_SCALE, Math.min(MAX_PDF_SCALE, scale));
}

// Bound whole-page pixels independently of the displayed zoom. Text, links,
// comments, and page geometry still use the requested document scale.
// A single zoomed page must not consume the entire viewer cache budget.
// Keep the base (including preloaded neighboring pages) small; the existing
// viewport detail layer supplies native-density pixels above this limit.
export const MAX_PDF_RASTER_PIXELS = (32 * 1024 * 1024) / 4;
const MAX_PDF_RASTER_SIDE = 16384;

export function pdfRasterScale(
  width: number,
  height: number,
  scale: number,
  devicePixelRatio: number,
): number {
  return Math.min(
    scale * devicePixelRatio,
    Math.sqrt(MAX_PDF_RASTER_PIXELS / (width * height)),
    MAX_PDF_RASTER_SIDE / Math.max(width, height),
  );
}
