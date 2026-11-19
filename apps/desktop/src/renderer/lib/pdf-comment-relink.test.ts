import { describe, expect, it, vi } from "vitest";
import { relocatePdfCommentAnchor } from "./pdf-comment-relink";
import type { StructuredTextData } from "./mupdf/types";

function page(...texts: string[]) {
  const data: StructuredTextData = {
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
  return { data, text: texts.join("").replace(/\s+/gu, "") };
}

const anchor = (text: string, savedPage: number) => ({
  fingerprint: "a".repeat(40),
  text,
  regions: [{ page: savedPage, x: 1, y: 1, width: 1, height: 1 }],
});
const current = "b".repeat(40);

describe("PDF comment relinking", () => {
  it("finds the quoted text on the nearest page of the replaced PDF", async () => {
    const pages = [
      page("Introduction"),
      page("Background"),
      page("A key result", "follows here"),
      page("A key result again"),
    ];
    const read = vi.fn(async (number: number) => pages[number - 1]);
    const moved = await relocatePdfCommentAnchor(
      anchor("key result\nfollows", 2),
      current,
      pages.length,
      read,
    );
    expect(moved).toMatchObject({
      fingerprint: current,
      text: "key result\nfollows",
    });
    expect(moved?.regions.map((region) => region.page)).toEqual([3, 3]);
    // Pages are read outward from the saved one, and only until a match.
    expect(read.mock.calls.map(([number]) => number)).toEqual([2, 1, 3]);
  });

  it("leaves missing or repeated text unplaced", async () => {
    const pages = [page("Same words. Same words."), page("Same words.")];
    const read = async (number: number) => pages[number - 1];
    expect(
      await relocatePdfCommentAnchor(
        anchor("Same words.", 1),
        current,
        2,
        read,
      ),
    ).toBeNull();
    expect(
      await relocatePdfCommentAnchor(anchor("Removed", 9), current, 2, read),
    ).toBeNull();
  });
});
