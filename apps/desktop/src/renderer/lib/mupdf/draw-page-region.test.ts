import * as mupdf from "mupdf";
import { describe, expect, it } from "vitest";
import { drawPageRegion } from "./draw-page-region";

describe("clipped MuPDF rasterization", () => {
  for (const rotation of [0, 90, 180, 270] as const) {
    it(`aligns with whole-page pixels on a cropped, ${rotation} degree rotated page`, () => {
      const doc = new mupdf.PDFDocument();
      const object = doc.addPage(
        [20, 30, 160, 230],
        rotation,
        {},
        "0.9 0.2 0.1 rg 30 50 85 125 re f 0 0.7 0.2 RG 3 w 22 32 m 158 228 l S",
      );
      doc.insertPage(-1, object);
      const page = doc.loadPage(0);
      const full = page.toPixmap(
        mupdf.Matrix.scale(3, 3),
        mupdf.ColorSpace.DeviceRGB,
        false,
        true,
      );
      const region = { x: 37, y: 31, width: 83, height: 79, scale: 3 };
      const detail = drawPageRegion(page, region);
      try {
        expect(detail.getWidth()).toBe(83);
        expect(detail.getHeight()).toBe(79);
        const all = full.getPixels();
        const part = detail.getPixels();
        let difference = 0;
        let maxDifference = 0;
        for (let y = 0; y < region.height; y++) {
          const offset = ((y + region.y) * full.getWidth() + region.x) * 3;
          for (let x = 0; x < region.width * 3; x++) {
            const delta = Math.abs(
              part[y * region.width * 3 + x] - all[offset + x],
            );
            difference += delta;
            maxDifference = Math.max(maxDifference, delta);
          }
        }
        // Clipping a rotated diagonal slightly changes edge antialiasing.
        expect(maxDifference).toBeLessThanOrEqual(8);
        expect(difference / part.length).toBeLessThan(0.05);
      } finally {
        detail.destroy();
        full.destroy();
        page.destroy();
        object.destroy();
        doc.destroy();
      }
    });
  }

  it("rejects an oversized region before allocating pixels", () => {
    const doc = new mupdf.PDFDocument();
    const object = doc.addPage([0, 0, 100, 100], 0, {}, "");
    doc.insertPage(-1, object);
    const page = doc.loadPage(0);
    try {
      expect(() =>
        drawPageRegion(page, {
          x: 0,
          y: 0,
          width: 10000,
          height: 10000,
          scale: 24,
        }),
      ).toThrow("Invalid PDF detail region");
    } finally {
      page.destroy();
      object.destroy();
      doc.destroy();
    }
  });
});
