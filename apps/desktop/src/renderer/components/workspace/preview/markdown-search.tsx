import { useCallback, useEffect, useState } from "react";
import {
  findRenderedTextRanges,
  PREVIEW_SEARCH_LIMIT,
} from "@/lib/preview-search";
import type { usePreviewSearch } from "./preview-search-panel";

export function useMarkdownSearch(
  search: ReturnType<typeof usePreviewSearch>,
  document: Document | null,
  contentIdentity: unknown,
  beforeScroll: (scrollTop: number) => void,
) {
  const [ranges, setRanges] = useState<Range[]>([]);
  const [index, setIndex] = useState(0);
  useEffect(() => {
    setRanges([]);
    setIndex(0);
    const root = document?.getElementById("write");
    if (
      !root ||
      !search.open ||
      search.scope === "comments" ||
      !search.valid ||
      !search.query.text
    )
      return;
    const timer = setTimeout(() => {
      setRanges(findRenderedTextRanges(root, search.query));
    }, 120);
    return () => clearTimeout(timer);
  }, [
    search.open,
    search.scope,
    search.query,
    search.valid,
    document,
    contentIdentity,
  ]);
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
  const { ownsFocus } = search;
  const scrollToMatch = useCallback(
    (range: Range | undefined) => {
      const scrolling = document?.scrollingElement;
      if (!range || !scrolling || !ownsFocus()) return;
      beforeScroll(scrolling.scrollTop);
      scrolling.scrollTop +=
        range.getBoundingClientRect().top -
        document.documentElement.clientHeight * 0.35;
    },
    [document, ownsFocus, beforeScroll],
  );
  useEffect(() => {
    scrollToMatch(ranges[index]);
  }, [ranges, index, scrollToMatch]);
  return {
    count: ranges.length,
    current: ranges.length ? index + 1 : 0,
    status:
      ranges.length === PREVIEW_SEARCH_LIMIT
        ? `First ${PREVIEW_SEARCH_LIMIT} results`
        : undefined,
    move: (delta: number) => {
      if (!ranges.length) return;
      if (delta === 0 || ranges.length === 1) {
        scrollToMatch(ranges[index]);
        return;
      }
      setIndex(
        (previous) => (previous + delta + ranges.length) % ranges.length,
      );
    },
  };
}
