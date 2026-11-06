import type { PdfCommentAnchor } from "@/components/workspace/editor/inline-comments";
import type { StructuredTextData } from "./types";

/** Exact, case-sensitive text matching after whitespace/ligature normalization. */
export function locatePdfCommentPassage(
  data: StructuredTextData,
  page: number,
  passage: string,
): PdfCommentAnchor["regions"] {
  const chars = data.blocks.flatMap((block) =>
    block.lines.flatMap((line) => [
      ...(line.chars ?? []).map((char) => ({
        char: char.c,
        quad: char.quad,
        line,
      })),
      { char: "\n", quad: [] as number[], line },
    ]),
  );
  const normalized: string[] = [];
  const indices: number[] = [];
  chars.forEach((glyph, index) => {
    for (const char of glyph.char.normalize("NFKC")) {
      const value = /\s/u.test(char) ? " " : char;
      if (value === " " && normalized[normalized.length - 1] === " ") continue;
      // String offsets are UTF-16; retain one mapping entry per code unit.
      for (const unit of value.split("")) {
        normalized.push(unit);
        indices.push(index);
      }
    }
  });
  const text = normalized.join("");
  const needle = passage.normalize("NFKC").replace(/\s+/gu, " ").trim();
  const start = needle ? text.indexOf(needle) : -1;
  if (start < 0)
    throw new Error(
      "missing_passage: quote selectable text returned by read_pdf",
    );
  if (text.indexOf(needle, start + 1) >= 0)
    throw new Error(
      "ambiguous_passage: quote more surrounding text on this page",
    );
  const selected = chars
    .slice(indices[start], indices[start + needle.length - 1] + 1)
    .filter((glyph) => glyph.quad.length === 8);
  const groups = new Map<object, number[][]>();
  for (const glyph of selected) {
    const group = groups.get(glyph.line) ?? [];
    group.push(glyph.quad);
    groups.set(glyph.line, group);
  }
  const regions = [...groups.values()].map((quads) => {
    const xs = quads.flatMap((q) => [q[0], q[2], q[4], q[6]]);
    const ys = quads.flatMap((q) => [q[1], q[3], q[5], q[7]]);
    const x = xs.reduce((a, b) => Math.min(a, b), Infinity),
      y = ys.reduce((a, b) => Math.min(a, b), Infinity);
    return {
      page,
      x,
      y,
      width: xs.reduce((a, b) => Math.max(a, b), -Infinity) - x,
      height: ys.reduce((a, b) => Math.max(a, b), -Infinity) - y,
    };
  });
  if (!regions.length)
    throw new Error(
      "missing_text_geometry: this page has no selectable text geometry",
    );
  return regions;
}
