import { describe, expect, it } from "vitest";
import {
  findPreviewMatches,
  findCommentIdMatches,
  searchPdfText,
  type PreviewSearchQuery,
} from "./preview-search";
import type { StructuredTextLine } from "./mupdf/types";
const query = (
  text: string,
  options: Partial<PreviewSearchQuery> = {},
): PreviewSearchQuery => ({
  text,
  caseSensitive: false,
  wholeWord: false,
  regex: false,
  ...options,
});
describe("preview search", () => {
  it("supports literal punctuation, whitespace, case and whole words", () => {
    expect(findPreviewMatches("A+b a+b", query("a+b"))).toHaveLength(2);
    expect(
      findPreviewMatches("A+b a+b", query("a+b", { caseSensitive: true })),
    ).toHaveLength(1);
    expect(
      findPreviewMatches("the other Thé", query("the", { wholeWord: true })),
    ).toHaveLength(1);
    expect(findPreviewMatches("one\ntwo", query("one two"))).toEqual([
      { start: 0, end: 7 },
    ]);
  });
  it("supports regex, rejects invalid expressions and skips empty matches", () => {
    expect(
      findPreviewMatches("abc123 def45", query("\\d+", { regex: true })),
    ).toEqual([
      { start: 3, end: 6 },
      { start: 10, end: 12 },
    ]);
    expect(() =>
      findPreviewMatches("abc", query("[", { regex: true })),
    ).toThrow();
    expect(findPreviewMatches("abc", query("^", { regex: true }))).toEqual([]);
  });
  it("maps multi-line matches to page rectangles including multi-character glyphs", () => {
    const line = (text: string, y: number): StructuredTextLine => ({
      text,
      bbox: { x: 10, y, w: 30, h: 10 },
      x: 10,
      y,
      wmode: 0,
      font: {
        name: "test",
        family: "test",
        size: 10,
        weight: "normal",
        style: "normal",
      },
      chars: [
        {
          c: text,
          quad: [10, y, 40, y, 10, y + 10, 40, y + 10],
          origin: { x: 10, y },
        },
      ],
    });
    const data = {
      blocks: [
        {
          type: "text" as const,
          bbox: { x: 10, y: 10, w: 30, h: 30 },
          lines: [line("first", 10), line("second", 30)],
        },
      ],
    };
    expect(searchPdfText(data, query("first second"))).toEqual([
      [
        { x: 10, y: 10, w: 30, h: 10 },
        { x: 10, y: 30, w: 30, h: 10 },
      ],
    ]);
    expect(searchPdfText(data, query("missing"))).toEqual([]);
  });
});

it("accepts comment ID separators and case without matching other numbers or altering regex", () => {
  for (const text of ["H-8", "h-8", "H8", "h8", "H 8", "h 8"]) {
    expect(
      findCommentIdMatches("H-8", query(text, { caseSensitive: true })),
    ).toEqual([{ start: 0, end: 3 }]);
    expect(findCommentIdMatches("H-80", query(text))).toEqual([]);
    expect(findPreviewMatches("H-8", query("h8"))).toEqual([]);
  }
  expect(findCommentIdMatches("A-7", query("a7"))).toHaveLength(1);
  expect(findCommentIdMatches("A-7", query("h7"))).toEqual([]);
  expect(findCommentIdMatches("H-8", query("h8", { regex: true }))).toEqual([]);
});
