import type { StructuredTextLine } from "@/lib/mupdf/types";
import { matchPdfCommentRange } from "./pdf-comment-selection";
import {
  normalizePdfCommentText,
  projectVisibleText,
} from "./pdf-comment-text";

/** Map a rendered character boundary through the same projection as comments. */
export function pdfCommentEndpoint(
  source: string,
  line: StructuredTextLine,
  offset: number,
  nearLine: number,
): number | null {
  const match = matchPdfCommentRange(source, line.text, nearLine);
  if (match.status !== "matched") return null;
  const projection = projectVisibleText(
    source.slice(match.range.from, match.range.to),
  );
  if (!projection) return null;
  const visible = normalizePdfCommentText(projection.text);
  const rendered = normalizePdfCommentText(line.text);
  if (visible.value !== rendered.value) return null;
  if (offset <= 0) return match.range.from;
  if (offset >= line.text.length) return match.range.to;
  const next = rendered.offsets.findIndex((value) => value >= offset);
  if (next < 0) return match.range.to;
  const index = visible.offsets[next];
  // Generated math spans are atomic; don't invent positions inside them.
  if (index > 0 && projection.starts[index] === projection.starts[index - 1])
    return null;
  return match.range.from + projection.starts[index];
}

export function pdfOffsetAtPoint(line: StructuredTextLine, x: number) {
  if (!line.chars?.length) return null;
  let offset = 0;
  for (const char of line.chars) {
    const xs = [char.quad[0], char.quad[2], char.quad[4], char.quad[6]];
    if (x < (Math.min(...xs) + Math.max(...xs)) / 2) return offset;
    offset += char.c.length;
  }
  return offset;
}
