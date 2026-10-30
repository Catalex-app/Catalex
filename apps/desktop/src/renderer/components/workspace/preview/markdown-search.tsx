import { useEffect, useState } from "react";
import { findPreviewMatches, PREVIEW_SEARCH_LIMIT } from "@/lib/preview-search";
import type { usePreviewSearch } from "./preview-search-panel";

export function useMarkdownSearch(
  search: ReturnType<typeof usePreviewSearch>,
  document: Document | null,
  contentIdentity: unknown,
) {
  const [ranges, setRanges] = useState<Range[]>([]);
  const [index, setIndex] = useState(0);
  useEffect(() => {
    setRanges([]);
    setIndex(0);
    const root = document?.getElementById("write");
    if (!root || !search.open || !search.valid || !search.query.text) return;
    const timer = setTimeout(() => {
      const walker = document!.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const nodes: Array<{ node: Text; start: number; end: number }> = [];
      let text = "",
        previousBlock: Element | null = null;
      for (
        let node = walker.nextNode() as Text | null;
        node;
        node = walker.nextNode() as Text | null
      ) {
        if (
          node.parentElement?.closest(
            "script, style, .katex-mathml, [data-comment-popup]",
          )
        )
          continue;
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
      for (const match of findPreviewMatches(text, search.query)) {
        while (offset < nodes.length && nodes[offset].end <= match.start)
          offset++;
        const first = nodes[offset];
        if (!first || first.start > match.start) continue;
        let end = offset;
        while (end < nodes.length - 1 && nodes[end].end < match.end) end++;
        const last = nodes[end];
        if (!last || last.end < match.end) continue;
        const range = document!.createRange();
        range.setStart(first.node, match.start - first.start);
        range.setEnd(last.node, match.end - last.start);
        found.push(range);
      }
      setRanges(found);
    }, 120);
    return () => clearTimeout(timer);
  }, [search.open, search.query, search.valid, document, contentIdentity]);
  useEffect(() => {
    const win = document?.defaultView as (Window & typeof globalThis) | null;
    if (!document || !win?.CSS?.highlights) return;
    const style = document.createElement("style");
    style.textContent =
      "::highlight(catalex-search) { background-color: rgba(250, 204, 21, .4); color: inherit; } ::highlight(catalex-search-active) { background-color: rgba(249, 115, 22, .55); color: inherit; }";
    document.head.append(style);
    if (search.open) {
      win.CSS.highlights.set("catalex-search", new win.Highlight(...ranges));
      win.CSS.highlights.set(
        "catalex-search-active",
        new win.Highlight(...(ranges[index] ? [ranges[index]] : [])),
      );
    }
    return () => {
      style.remove();
      win.CSS.highlights.delete("catalex-search");
      win.CSS.highlights.delete("catalex-search-active");
    };
  }, [document, ranges, index, search.open]);
  useEffect(() => {
    const range = ranges[index];
    const scrolling = document?.scrollingElement;
    if (!range || !scrolling) return;
    scrolling.scrollTop +=
      range.getBoundingClientRect().top -
      (document?.documentElement.clientHeight ?? 0) * 0.35;
  }, [ranges, index, document]);
  return {
    count: ranges.length,
    current: ranges.length ? index + 1 : 0,
    status:
      ranges.length === PREVIEW_SEARCH_LIMIT
        ? `First ${PREVIEW_SEARCH_LIMIT} results`
        : undefined,
    move: (delta: number) =>
      setIndex((previous) =>
        ranges.length ? (previous + delta + ranges.length) % ranges.length : 0,
      ),
  };
}
