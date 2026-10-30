import { describe, expect, it } from "vitest";
import { mapReviewViewport, type ReviewViewport } from "./review-viewport";

const original = "first\nreading here\nlast\n";
const anchor: ReviewViewport = {
  document: original,
  position: 6,
  cursor: 9,
  offset: 120,
  viewportTop: 100,
};
describe("review viewport mapping", () => {
  it("follows surviving text when earlier lines change", () => {
    const document = "a much longer introduction\nreading here\nlast\n";
    const mapped = mapReviewViewport(anchor, document);
    expect(document.slice(mapped.position)).toBe("reading here\nlast\n");
    expect(document.slice(mapped.cursor)).toBe("ding here\nlast\n");
    expect(mapped.offset).toBe(120);
  });
  it("falls back to the deletion boundary when the anchor is removed", () => {
    const document = "first\nlast\n";
    const mapped = mapReviewViewport(anchor, document);
    expect(mapped.position).toBe(6);
    expect(mapped.cursor).toBe(6);
  });
  it("follows the reading text when new text is inserted at its boundary", () => {
    const document = "first\ninserted line\nreading here\nlast\n";
    const mapped = mapReviewViewport(anchor, document);
    expect(document.slice(mapped.position)).toBe("reading here\nlast\n");
  });
  it("retains coordinates for acceptance without text changes", () => {
    expect(mapReviewViewport(anchor, original)).toBe(anchor);
  });
});
