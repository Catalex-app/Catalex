import { describe, expect, it } from "vitest";
import {
  pdfFileCommentRegions,
  pdfFileCommentTargets,
  validPdfCommentRegions,
} from "./pdf-file-comments";

const comment = {
  id: "pdf-note",
  from: 0,
  to: 0,
  line: 2,
  text: "Explain this result",
  pdf: {
    fingerprint: "a".repeat(40),
    text: "Result continued across pages",
    regions: [
      { page: 2, x: 40, y: 700, width: 200, height: 12 },
      { page: 3, x: 40, y: 40, width: 180, height: 12 },
    ],
  },
};
describe("PDF file comment anchors", () => {
  it("shows only current, open, valid anchors and preserves multi-page geometry", () => {
    const targets = pdfFileCommentTargets(
      "a/paper.pdf",
      comment.pdf.fingerprint,
      [
        comment,
        { ...comment, id: "resolved", resolved: true },
        {
          ...comment,
          id: "old",
          pdf: { ...comment.pdf, fingerprint: "b".repeat(40) },
        },
        { ...comment, id: "empty", pdf: { ...comment.pdf, regions: [] } },
      ],
    );
    expect(targets).toHaveLength(1);
    expect(targets[0].filePath).toBe("a/paper.pdf");
    expect(pdfFileCommentRegions(targets, 1)).toEqual([]);
    expect(pdfFileCommentRegions(targets, 2)[0].bounds).toEqual({
      x: 40,
      y: 700,
      w: 200,
      h: 12,
    });
    expect(pdfFileCommentRegions(targets, 3)[0].bounds).toEqual({
      x: 40,
      y: 40,
      w: 180,
      h: 12,
    });
    expect(pdfFileCommentTargets("a/paper.pdf", null, [comment])).toEqual([]);
  });
  it("rejects unbounded and invalid selection geometry", () => {
    for (const invalid of [
      { page: 0 },
      { page: 1.5 },
      { x: NaN },
      { y: Infinity },
      { width: 0 },
      { height: -1 },
    ]) {
      expect(
        validPdfCommentRegions([{ ...comment.pdf.regions[0], ...invalid }]),
      ).toBe(false);
    }
    expect(validPdfCommentRegions(comment.pdf.regions)).toBe(true);
  });
});
