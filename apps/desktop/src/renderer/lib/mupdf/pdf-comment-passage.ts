import type { PdfCommentAnchor } from "@/components/workspace/editor/inline-comments";
import type {
  PdfTextRange,
  StructuredTextData,
  StructuredTextLine,
} from "./types";

interface PdfGlyph extends PdfTextRange {
  char: string;
  quad?: number[];
  line: StructuredTextLine;
}

function pageGlyphs(data: StructuredTextData, page: number): PdfGlyph[] {
  let offset = 0;
  return data.blocks.flatMap((block) =>
    block.lines.flatMap((line) => {
      const glyphs = Array.from(line.text, (char, index) => {
        const from = offset;
        offset += char.length;
        return {
          page,
          from,
          to: offset,
          char,
          quad: line.chars?.[index]?.quad,
          line,
        };
      });
      const end = offset++;
      return [
        ...glyphs,
        { page, from: end, to: offset, char: "\n", quad: undefined, line },
      ];
    }),
  );
}

function normalizeGlyphText(text: string, compact: boolean): string {
  return Array.from(text, (char) => char.normalize("NFKC"))
    .join("")
    .replace(/\s+/gu, compact ? "" : " ");
}

function indexGlyphs(glyphs: PdfGlyph[], compact = false) {
  const units: string[] = [];
  const positions: PdfGlyph[] = [];
  for (const glyph of glyphs) {
    for (const unit of normalizeGlyphText(glyph.char, compact).split("")) {
      if (unit === " " && units[units.length - 1] === " ") continue;
      units.push(unit);
      positions.push(glyph);
    }
  }
  return { text: units.join(""), positions };
}

/** Exact, case-sensitive text matching after whitespace/ligature normalization. */
export function locatePdfCommentPassage(
  data: StructuredTextData,
  page: number,
  passage: string,
): PdfCommentAnchor["regions"] {
  const { text, positions } = indexGlyphs(pageGlyphs(data, page));
  const needle = normalizeGlyphText(passage, false).trim();
  const start = needle ? text.indexOf(needle) : -1;
  if (start < 0)
    throw new Error(
      "missing_passage: quote selectable text returned by read_pdf",
    );
  if (text.indexOf(needle, start + 1) >= 0)
    throw new Error(
      "ambiguous_passage: quote more surrounding text on this page",
    );
  const regions = glyphRegions(positions.slice(start, start + needle.length));
  if (!regions.length)
    throw new Error(
      "missing_text_geometry: this page has no selectable text geometry",
    );
  return regions;
}

function glyphRegions(glyphs: PdfGlyph[]): PdfCommentAnchor["regions"] {
  const groups = new Map<StructuredTextLine, number[][]>();
  for (const { line, quad } of new Set(glyphs)) {
    if (quad?.length !== 8) continue;
    const group = groups.get(line) ?? [];
    group.push(quad);
    groups.set(line, group);
  }
  return [...groups.values()].map((quads) => {
    const xs = quads.flatMap((q) => [q[0], q[2], q[4], q[6]]);
    const ys = quads.flatMap((q) => [q[1], q[3], q[5], q[7]]);
    const x = xs.reduce((a, b) => Math.min(a, b), Infinity),
      y = ys.reduce((a, b) => Math.min(a, b), Infinity);
    return {
      page: glyphs[0].page,
      x,
      y,
      width: xs.reduce((a, b) => Math.max(a, b), -Infinity) - x,
      height: ys.reduce((a, b) => Math.max(a, b), -Infinity) - y,
    };
  });
}

export type PdfTextPoint = { page: number; offset: number };

/** Rebuild a quote and its per-line rectangles from two PDF text positions. */
export function pdfCommentPassageBetween(
  pages: ReadonlyMap<number, StructuredTextData>,
  start: PdfTextPoint,
  end: PdfTextPoint,
): Pick<PdfCommentAnchor, "text" | "regions"> | null {
  if (
    start.page > end.page ||
    (start.page === end.page && start.offset >= end.offset)
  )
    return null;
  const regions: PdfCommentAnchor["regions"] = [];
  const textParts: string[] = [];
  for (let page = start.page; page <= end.page; page++) {
    const data = pages.get(page);
    if (!data) return null;
    const from = page === start.page ? start.offset : 0;
    const to = page === end.page ? end.offset : Infinity;
    const glyphs = pageGlyphs(data, page).filter(
      (glyph) => glyph.from >= from && glyph.to <= to,
    );
    textParts.push(
      glyphs
        .map(({ char }) => char)
        .join("")
        .trim(),
    );
    regions.push(...glyphRegions(glyphs));
  }
  const text = textParts.filter(Boolean).join("\n");
  return text && regions.length ? { text, regions } : null;
}

function coversGlyphCenter(
  regions: PdfCommentAnchor["regions"],
  glyph: PdfGlyph,
) {
  const q = glyph.quad;
  if (q?.length !== 8) return false;
  const x = (q[0] + q[2] + q[4] + q[6]) / 4;
  const y = (q[1] + q[3] + q[5] + q[7]) / 4;
  return regions.some(
    (r) =>
      r.page === glyph.page &&
      x >= r.x &&
      x <= r.x + r.width &&
      y >= r.y &&
      y <= r.y + r.height,
  );
}

/** Resolve saved highlights against the immutable PDF's text in page order. */
export function recoverPdfCommentRanges(
  anchor: PdfCommentAnchor,
  pages: ReadonlyMap<number, StructuredTextData>,
): PdfTextRange[] {
  const pageNumbers = [...new Set(anchor.regions.map((r) => r.page))].sort(
    (a, b) => a - b,
  );
  const glyphs = pageNumbers.flatMap((page) => {
    const data = pages.get(page);
    return data ? pageGlyphs(data, page) : [];
  });

  function findMatch(compact: boolean) {
    const { text, positions } = indexGlyphs(glyphs, compact);
    const needle = normalizeGlyphText(anchor.text, compact).trim();
    if (!needle) return null;
    const candidates: Array<{ first: PdfGlyph; last: PdfGlyph }> = [];
    for (
      let offset = text.indexOf(needle);
      offset >= 0;
      offset = text.indexOf(needle, offset + 1)
    ) {
      const first = positions[offset];
      const last = positions[offset + needle.length - 1];
      if (
        first.page === pageNumbers[0] &&
        last.page === pageNumbers[pageNumbers.length - 1]
      )
        candidates.push({ first, last });
    }
    if (!compact && candidates.length === 1) return candidates[0];
    const located = candidates.filter(
      ({ first, last }) =>
        coversGlyphCenter(anchor.regions, first) &&
        coversGlyphCenter(anchor.regions, last),
    );
    return located.length === 1 ? located[0] : null;
  }

  // Some older browser selections omitted the separator between SVG text lines.
  const match = findMatch(false) ?? findMatch(true);
  if (!match) return [];
  const ranges = new Map<number, PdfTextRange>();
  for (const { page, from, to, char } of glyphs) {
    if (char === "\n") continue;
    if (page === match.first.page && from < match.first.from) continue;
    if (page === match.last.page && to > match.last.to) continue;
    const current = ranges.get(page);
    if (current) current.to = to;
    else ranges.set(page, { page, from, to });
  }
  return [...ranges.values()];
}
