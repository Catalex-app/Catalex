import { readFileSync } from "node:fs";
import * as mupdf from "mupdf";
import { describe, expect, it } from "vitest";
import { extractStructuredText } from "./structured-text";

describe("MuPDF text extraction", () => {
  it("extracts actual PDF text, baselines and glyph geometry", () => {
    const bytes = readFileSync("public/examples/paper-standard/main.pdf");
    const doc = mupdf.Document.openDocument(
      new Uint8Array(bytes),
      "application/pdf",
    );
    const page = doc.loadPage(0);
    const text = page.toStructuredText("preserve-whitespace");
    try {
      const lines = extractStructuredText(text).blocks.flatMap(
        (block) => block.lines,
      );
      expect(lines.map((line) => line.text).join(" ")).toContain(
        "Your abstract here.",
      );
      const title = lines.find((line) => line.text === "Title")!;
      expect(title.y).toBeGreaterThan(title.bbox.y);
      expect(title.font.size).toBeGreaterThan(12);
      expect(title.chars?.[0].quad).toHaveLength(8);
      expect(title.chars?.map((char) => char.c).join("")).toBe("Title");
    } finally {
      text.destroy();
      page.destroy();
      doc.destroy();
    }
  });
});
