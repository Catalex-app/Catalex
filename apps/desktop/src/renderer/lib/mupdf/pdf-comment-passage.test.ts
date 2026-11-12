import { readFileSync } from "node:fs";
import * as mupdf from "mupdf";
import { describe, expect, it } from "vitest";
import { extractStructuredText } from "./structured-text";
import {
  locatePdfCommentPassage,
  recoverPdfCommentRanges,
} from "./pdf-comment-passage";
import type { StructuredTextData } from "./types";

function fixture(...texts: string[]): StructuredTextData {
  return {
    blocks: [
      {
        type: "text",
        bbox: { x: 0, y: 0, w: 300, h: 100 },
        lines: texts.map((text, line) => ({
          text,
          x: 10,
          y: line * 20,
          wmode: 0,
          bbox: { x: 10, y: line * 20, w: 200, h: 12 },
          font: {
            name: "Test",
            family: "serif",
            size: 12,
            weight: "normal",
            style: "normal",
          },
          chars: [...text].map((c, i) => ({
            c,
            origin: { x: 10 + i * 8, y: line * 20 },
            quad: [
              10 + i * 8,
              line * 20,
              18 + i * 8,
              line * 20,
              10 + i * 8,
              line * 20 + 12,
              18 + i * 8,
              line * 20 + 12,
            ],
          })),
        })),
      },
    ],
  };
}

describe("PDF comment passage matching", () => {
  it("matches a partial passage using real PDF glyph coordinates", () => {
    const doc = mupdf.Document.openDocument(
      new Uint8Array(readFileSync("public/examples/paper-standard/main.pdf")),
      "application/pdf",
    );
    const page = doc.loadPage(0),
      text = page.toStructuredText("preserve-whitespace");
    try {
      const data = extractStructuredText(text);
      const full = locatePdfCommentPassage(data, 1, "Your abstract here.");
      const part = locatePdfCommentPassage(data, 1, "abstract");
      expect(part[0].x).toBeGreaterThan(full[0].x);
      expect(part[0].width).toBeLessThan(full[0].width);
      expect(part[0].height).toBeGreaterThan(0);
    } finally {
      text.destroy();
      page.destroy();
      doc.destroy();
    }
  });
  it("handles line breaks, ligatures and Unicode without expanding the highlight", () => {
    const regions = locatePdfCommentPassage(
      fixture("🙂 A ﬁne", "result here"),
      4,
      "fine\n result",
    );
    expect(regions).toHaveLength(2);
    expect(
      recoverPdfCommentRanges(
        { fingerprint: "a".repeat(40), text: "fine result", regions },
        new Map([[4, fixture("🙂 A ﬁne", "result here")]]),
      ),
    ).toEqual([{ page: 4, from: 5, to: 15 }]);
    expect(regions[0]).toMatchObject({
      page: 4,
      x: 42,
      y: 0,
      width: 24,
      height: 12,
    });
    expect(regions[1]).toMatchObject({
      page: 4,
      x: 10,
      y: 20,
      width: 48,
      height: 12,
    });
  });
  it("rejects repeated, missing and non-selectable passages", () => {
    expect(() =>
      locatePdfCommentPassage(fixture("same same"), 1, "same"),
    ).toThrow("ambiguous_passage");
    expect(() => locatePdfCommentPassage(fixture("aaa"), 1, "aa")).toThrow(
      "ambiguous_passage",
    );
    expect(() => locatePdfCommentPassage(fixture("Text"), 1, "text")).toThrow(
      "missing_passage",
    );
    expect(() => locatePdfCommentPassage({ blocks: [] }, 1, "scan")).toThrow(
      "missing_passage",
    );
  });

  it("recovers the occurrence identified by the old highlight and skips ambiguous quotes", () => {
    const pages = new Map([[1, fixture("same same")]]);
    const anchor = {
      fingerprint: "a".repeat(40),
      text: "same",
      regions: [{ page: 1, x: 50, y: 0, width: 32, height: 12 }],
    };
    expect(recoverPdfCommentRanges(anchor, pages)).toEqual([
      { page: 1, from: 5, to: 9 },
    ]);
    expect(
      recoverPdfCommentRanges(
        { ...anchor, regions: [{ ...anchor.regions[0], x: 10, width: 72 }] },
        pages,
      ),
    ).toEqual([]);
  });

  it("recovers a legacy quote across pages, including missing SVG separators", () => {
    const pages = new Map([
      [1, fixture("First page end")],
      [2, fixture("Next page")],
    ]);
    const anchor = {
      fingerprint: "a".repeat(40),
      text: "endNext",
      regions: [
        { page: 1, x: 98, y: 0, width: 24, height: 12 },
        { page: 2, x: 10, y: 0, width: 32, height: 12 },
      ],
    };
    expect(recoverPdfCommentRanges(anchor, pages)).toEqual([
      { page: 1, from: 11, to: 14 },
      { page: 2, from: 0, to: 4 },
    ]);
  });
});
