import type { Rect, StructuredTextData } from "./mupdf/types";

export interface PreviewSearchQuery {
  text: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
}
export const PREVIEW_SEARCH_LIMIT = 10000;
export function previewSearchPattern(query: PreviewSearchQuery): RegExp | null {
  if (!query.text) return null;
  const source = query.regex
    ? query.text
    : query.text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  return new RegExp(
    query.wholeWord
      ? `(?<![\\p{L}\\p{N}_])(?:${source})(?![\\p{L}\\p{N}_])`
      : source,
    query.caseSensitive ? "gu" : "giu",
  );
}
export function findPreviewMatches(text: string, query: PreviewSearchQuery) {
  const pattern = previewSearchPattern(query);
  if (!pattern) return [];
  const matches: Array<{ start: number; end: number }> = [];
  for (const match of text.matchAll(pattern)) {
    if (!match[0].length) continue;
    matches.push({ start: match.index, end: match.index + match[0].length });
    if (matches.length >= PREVIEW_SEARCH_LIMIT) break;
  }
  return matches;
}

export function searchPdfText(
  data: StructuredTextData,
  query: PreviewSearchQuery,
): Rect[][] {
  let text = "";
  const segments: Array<{
    start: number;
    end: number;
    rect: Rect;
    line: number;
  }> = [];
  let lineIndex = 0;
  for (const block of data.blocks)
    for (const line of block.lines) {
      if (line.chars?.length) {
        for (const char of line.chars) {
          const xs = [char.quad[0], char.quad[2], char.quad[4], char.quad[6]];
          const ys = [char.quad[1], char.quad[3], char.quad[5], char.quad[7]];
          segments.push({
            start: text.length,
            end: text.length + char.c.length,
            line: lineIndex,
            rect: {
              x: Math.min(...xs),
              y: Math.min(...ys),
              w: Math.max(...xs) - Math.min(...xs),
              h: Math.max(...ys) - Math.min(...ys),
            },
          });
          text += char.c;
        }
      } else {
        segments.push({
          start: text.length,
          end: text.length + line.text.length,
          rect: line.bbox,
          line: lineIndex,
        });
        text += line.text;
      }
      text += "\n";
      lineIndex++;
    }
  let offset = 0;
  return findPreviewMatches(text, query)
    .map((match) => {
      while (offset < segments.length && segments[offset].end <= match.start)
        offset++;
      const rows = new Map<number, Rect>();
      for (
        let i = offset;
        i < segments.length && segments[i].start < match.end;
        i++
      ) {
        const { line, rect } = segments[i];
        const old = rows.get(line);
        if (!old) rows.set(line, { ...rect });
        else {
          const right = Math.max(old.x + old.w, rect.x + rect.w);
          const bottom = Math.max(old.y + old.h, rect.y + rect.h);
          old.x = Math.min(old.x, rect.x);
          old.y = Math.min(old.y, rect.y);
          old.w = right - old.x;
          old.h = bottom - old.y;
        }
      }
      return [...rows.values()];
    })
    .filter((rects) => rects.length);
}

/** Accept common spellings of a visible comment ID without rewriting text queries. */
export function findCommentIdMatches(label: string, query: PreviewSearchQuery) {
  const id =
    !query.regex && /^([ah])(?:\s*-\s*|\s*)(\d+)$/i.exec(query.text.trim());
  if (id) {
    return label.toUpperCase() === `${id[1].toUpperCase()}-${id[2]}`
      ? [{ start: 0, end: label.length }]
      : [];
  }
  return findPreviewMatches(label, { ...query, caseSensitive: false });
}
