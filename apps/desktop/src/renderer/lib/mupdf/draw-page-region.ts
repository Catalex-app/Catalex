import * as mupdf from "mupdf";
import {
  MAX_PDF_DETAIL_PIXELS,
  MAX_PDF_DETAIL_SIDE,
  type PageRasterRegion,
} from "./types";

/** Allocate only the requested region; never rasterize the enlarged whole page. */
export function drawPageRegion(
  page: mupdf.Page,
  region: PageRasterRegion,
): mupdf.Pixmap {
  const { x, y, width, height, scale } = region;
  if (
    ![x, y, width, height].every(Number.isSafeInteger) ||
    x < 0 ||
    y < 0 ||
    width <= 0 ||
    height <= 0 ||
    !Number.isFinite(scale) ||
    scale <= 0 ||
    width * height > MAX_PDF_DETAIL_PIXELS ||
    Math.max(width, height) > MAX_PDF_DETAIL_SIDE
  )
    throw new Error("Invalid PDF detail region");

  const bounds = page.getBounds();
  const pixmap = new mupdf.Pixmap(
    mupdf.ColorSpace.DeviceRGB,
    [x, y, x + width, y + height],
    false,
  );
  try {
    pixmap.clear(255);
    const device = new mupdf.DrawDevice(mupdf.Matrix.identity, pixmap);
    try {
      page.run(device, [
        scale,
        0,
        0,
        scale,
        -bounds[0] * scale,
        -bounds[1] * scale,
      ]);
      device.close();
    } finally {
      device.destroy();
    }
    return pixmap;
  } catch (error) {
    pixmap.destroy();
    throw error;
  }
}
