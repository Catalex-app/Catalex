export type SearchScope = "all" | "text" | "comments";

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

/** Map matches back to rendered text nodes without changing the rendered DOM. */
export function findRenderedTextRanges(
  root: Element,
  query: PreviewSearchQuery,
  exclude = "script, style, .katex-mathml, [data-comment-popup]",
) {
  const document = root.ownerDocument;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Array<{ node: Text; start: number; end: number }> = [];
  let text = "",
    previousBlock: Element | null = null;
  for (
    let node = walker.nextNode() as Text | null;
    node;
    node = walker.nextNode() as Text | null
  ) {
    if (node.parentElement?.closest(exclude)) continue;
    const block =
      node.parentElement?.closest(
        "p, h1, h2, h3, h4, h5, h6, li, pre, td, th, blockquote",
      ) ?? null;
    if (previousBlock && block !== previousBlock) text += "\n";
    previousBlock = block;
    nodes.push({
      node,
      start: text.length,
      end: text.length + node.length,
    });
    text += node.data;
  }
  let offset = 0;
  const found: Range[] = [];
  for (const match of findPreviewMatches(text, query)) {
    while (offset < nodes.length && nodes[offset].end <= match.start) offset++;
    const first = nodes[offset];
    if (!first || first.start > match.start) continue;
    let end = offset;
    while (end < nodes.length - 1 && nodes[end].end < match.end) end++;
    const last = nodes[end];
    if (!last || last.end < match.end) continue;
    const range = document.createRange();
    range.setStart(first.node, match.start - first.start);
    range.setEnd(last.node, match.end - last.start);
    found.push(range);
  }
  return found;
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
