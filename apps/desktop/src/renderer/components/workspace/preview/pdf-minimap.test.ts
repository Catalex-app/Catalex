import { describe, expect, it, vi } from "vitest";
import { locatePdfMinimapComments } from "./pdf-minimap";
import type { PdfCommentTarget } from "./pdf-comments";

function target(filePath: string, id: string): PdfCommentTarget {
  return {
    filePath,
    firstLine: 8,
    lastLine: 9,
    sourceText: "A passage",
    sourceBefore: "",
    sourceAfter: "",
    comment: { id, from: 0, to: 9, line: 8, text: "A comment" },
  };
}

describe("PDF minimap locations", () => {
  it("finds comments on unvisited pages using the full source path, and omits unmapped comments", async () => {
    const a = target("a/main.tex", "a");
    const b = target("b/main.tex", "b");
    const missing = target("missing.tex", "missing");
    const lookup = vi.fn(async (page: number) =>
      page === 3
        ? [
            {
              x: 1,
              y: 200,
              width: 40,
              height: 10,
              sources: [{ file: "b/main.tex", line: 8 }],
            },
            {
              x: 1,
              y: 100,
              width: 40,
              height: 10,
              sources: [{ file: "a/main.tex", line: 9 }],
            },
            {
              x: 1,
              y: 80,
              width: 40,
              height: 10,
              sources: [{ file: "a/main.tex", line: 8 }],
            },
          ]
        : [],
    );
    const result = await locatePdfMinimapComments(
      { targets: [b, a, missing], lookup, navigate: vi.fn() },
      4,
      new AbortController().signal,
    );
    expect(result).toEqual([
      { target: a, page: 3, y: 80 },
      { target: b, page: 3, y: 200 },
    ]);
  });
  it("uses standalone anchors without loading source maps and ignores pages beyond the snapshot", async () => {
    const a = target("paper.pdf", "a");
    a.comment.pdf = {
      fingerprint: "a".repeat(40),
      text: "A passage",
      regions: [{ page: 2, x: 10, y: 100, width: 50, height: 10 }],
    };
    const lookup = vi.fn(async () => []);
    const context = { targets: [a], lookup, navigate: vi.fn() };
    expect(
      await locatePdfMinimapComments(context, 3, new AbortController().signal),
    ).toEqual([{ target: a, page: 2, y: 100 }]);
    expect(
      await locatePdfMinimapComments(context, 1, new AbortController().signal),
    ).toEqual([]);
    expect(lookup).not.toHaveBeenCalled();
  });
  it("discards an in-flight lookup when the preview or compilation changes", async () => {
    const controller = new AbortController();
    const lookup = vi.fn(async () => {
      controller.abort();
      return [
        {
          x: 1,
          y: 80,
          width: 40,
          height: 10,
          sources: [{ file: "main.tex", line: 8 }],
        },
      ];
    });
    expect(
      await locatePdfMinimapComments(
        { targets: [target("main.tex", "a")], lookup, navigate: vi.fn() },
        100,
        controller.signal,
      ),
    ).toEqual([]);
    expect(lookup).toHaveBeenCalledTimes(1);
  });
});
