import katex from "katex";
import { describe, expect, it, vi } from "vitest";
import type { StructuredTextLine } from "@/lib/mupdf/types";
import { pdfCommentEndpoint } from "./pdf-comment-resize";
const line = (text: string) => ({ text }) as StructuredTextLine;
describe("PDF comment endpoint mapping", () => {
  it("maps a plain line boundary", () => {
    const source = "% context\nYour abstract here.\n";
    expect(pdfCommentEndpoint(source, line("Your abstract here."), 5, 2)).toBe(
      source.indexOf("abstract"),
    );
  });
  it("maps through formatting without choosing a repeated occurrence", () => {
    const source = "First phrase.\nYour \\emph{abstract} here.\nFirst phrase.";
    expect(pdfCommentEndpoint(source, line("Your abstract here."), 5, 2)).toBe(
      source.indexOf("\\emph"),
    );
    expect(pdfCommentEndpoint(source, line("First phrase."), 6, 1)).toBe(6);
    expect(pdfCommentEndpoint(source, line("First phrase."), 6, 2)).toBeNull();
  });
});

it("reuses document math parsing across seven comment endpoint lookups", () => {
  const source = Array.from(
    { length: 40 },
    (_, i) => `Paragraph ${i} with unique prose. $x_{${i}}^2$\n`,
  ).join("");
  const render = vi.spyOn(katex, "renderToString");
  const started = performance.now();
  try {
    for (let i = 0; i < 7; i++) {
      const text = `Paragraph ${i} with unique prose.`;
      expect(pdfCommentEndpoint(source, line(text), 0, i + 1)).toBe(
        source.indexOf(text),
      );
      expect(pdfCommentEndpoint(source, line(text), text.length, i + 1)).toBe(
        source.indexOf(text) + text.length,
      );
    }
    console.info("Seven-comment endpoint mapping", {
      milliseconds: performance.now() - started,
      mathParses: render.mock.calls.length,
    });
    expect(render.mock.calls.length).toBeLessThanOrEqual(40);
  } finally {
    render.mockRestore();
  }
});

it("uses fresh offsets after edits and evicts old document indexes", () => {
  const render = vi.spyOn(katex, "renderToString");
  const first = "Original phrase. $q_1$";
  const second = "Second phrase. $q_2$";
  const third = "Third phrase. $q_3$";
  try {
    expect(pdfCommentEndpoint(first, line("Original phrase."), 0, 1)).toBe(0);
    expect(pdfCommentEndpoint(second, line("Second phrase."), 0, 1)).toBe(0);
    expect(pdfCommentEndpoint(third, line("Third phrase."), 0, 1)).toBe(0);
    render.mockClear();
    expect(pdfCommentEndpoint(first, line("Original phrase."), 0, 1)).toBe(0);
    expect(render).toHaveBeenCalledTimes(1);
    expect(
      pdfCommentEndpoint(`Inserted.\n${first}`, line("Original phrase."), 0, 2),
    ).toBe(10);
  } finally {
    render.mockRestore();
  }
});
