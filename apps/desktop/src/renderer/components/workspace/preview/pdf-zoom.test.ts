import { describe, expect, it } from "vitest";
import {
  clampPdfScale,
  MAX_PDF_RASTER_PIXELS,
  pdfRasterScale,
} from "./pdf-zoom";

describe("PDF zoom range and pixel allocation", () => {
  it("accepts zoom beyond 400% and clamps only at 25% and 1200%", () => {
    expect([0, 0.25, 4, 9.99, 12, 20, Infinity].map(clampPdfScale)).toEqual([
      0.25, 0.25, 4, 9.99, 12, 12, 12,
    ]);
  });

  it("keeps native-density pixels for ordinary pages when they fit the budget", () => {
    expect(pdfRasterScale(612, 792, 1, 2)).toBe(2);
    expect(pdfRasterScale(612, 792, 2, 2)).toBe(4);
    expect(pdfRasterScale(50, 100, 12, 2)).toBe(24);
  });

  it("caps zoomed neighboring pages independently of the viewer cache", () => {
    const density = pdfRasterScale(612, 792, 4, 2);
    expect(612 * 792 * density ** 2 * 4).toBeCloseTo(32 * 1024 * 1024);
    expect(density).toBeLessThan(8);
    expect(pdfRasterScale(612, 792, 12, 2)).toBe(density);
  });

  it.each([
    1, 2, 3,
  ])("bounds whole-page pixels at 1200% with device ratio %s", (dpr) => {
    const pixelScale = pdfRasterScale(612, 792, 12, dpr);
    expect(612 * 792 * pixelScale ** 2).toBeCloseTo(MAX_PDF_RASTER_PIXELS, 5);
    expect(pixelScale).toBeLessThan(12 * dpr);
    // Increasing the displayed zoom after saturation reuses the same bitmap.
    expect(pdfRasterScale(612, 792, 10, dpr)).toBe(pixelScale);
  });

  it("also bounds the longest side of unusually wide pages", () => {
    const pixelScale = pdfRasterScale(100000, 10, 12, 2);
    expect(100000 * pixelScale).toBe(16384);
    expect(100000 * 10 * pixelScale ** 2).toBeLessThan(MAX_PDF_RASTER_PIXELS);
  });
});
