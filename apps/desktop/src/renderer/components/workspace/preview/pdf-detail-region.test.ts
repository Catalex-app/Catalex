import { describe, expect, it } from "vitest";
import { MAX_PDF_DETAIL_PIXELS, MAX_PDF_DETAIL_SIDE } from "@/lib/mupdf/types";
import { pdfDetailCovers, pdfDetailRegion } from "./pdf-detail-region";

describe("PDF detail region", () => {
  it("renders a sharp visible area with enough margin to reuse during small pans", () => {
    const visible = { x: 100, y: 200, w: 100, h: 60 };
    const region = pdfDetailRegion(612, 792, visible, 24)!;
    expect(region.scale).toBe(24);
    expect(pdfDetailCovers(region, visible)).toBe(true);
    expect(pdfDetailCovers(region, { ...visible, x: 105, y: 205 })).toBe(true);
    expect(pdfDetailCovers(region, { ...visible, x: 250 })).toBe(false);
    expect(region.width * region.height).toBeLessThanOrEqual(
      MAX_PDF_DETAIL_PIXELS,
    );
  });
  it("clips at the page edge and ignores pages outside the viewport", () => {
    const region = pdfDetailRegion(
      612,
      792,
      { x: -10, y: -10, w: 100, h: 100 },
      24,
    )!;
    expect(region.x).toBe(0);
    expect(region.y).toBe(0);
    expect(
      pdfDetailRegion(612, 792, { x: 0, y: 900, w: 100, h: 100 }, 24),
    ).toBeNull();
  });
  it("bounds detail allocation even on very large or unusually wide screens", () => {
    for (const visible of [
      { x: 1.12, y: 2.34, w: 600, h: 700 },
      { x: 0, y: 0, w: 20000, h: 1 },
    ]) {
      const region = pdfDetailRegion(30000, 30000, visible, 36)!;
      expect(region.width * region.height).toBeLessThanOrEqual(
        MAX_PDF_DETAIL_PIXELS,
      );
      expect(Math.max(region.width, region.height)).toBeLessThanOrEqual(
        MAX_PDF_DETAIL_SIDE,
      );
      expect(pdfDetailCovers(region, visible)).toBe(true);
    }
  });
});
