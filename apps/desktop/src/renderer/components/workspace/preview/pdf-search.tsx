import { useEffect, useMemo, useState } from "react";
import { getMupdfClient } from "@/lib/mupdf/mupdf-client";
import type { Rect } from "@/lib/mupdf/types";
import { PREVIEW_SEARCH_LIMIT } from "@/lib/preview-search";
import type { usePreviewSearch } from "./preview-search-panel";
export interface PdfSearchHit {
  rects: Rect[];
  active: boolean;
}
export function usePdfSearch(
  search: ReturnType<typeof usePreviewSearch>,
  docId: number,
  pages: number,
  navigate: (page: number, y: number) => void,
) {
  const [matches, setMatches] = useState<
    Array<{ page: number; rects: Rect[] }>
  >([]);
  const [index, setIndex] = useState(0);
  const [status, setStatus] = useState<string>();
  useEffect(() => {
    let cancelled = false;
    setMatches([]);
    setIndex(0);
    setStatus(undefined);
    if (
      !search.open ||
      search.scope === "comments" ||
      !search.valid ||
      !search.query.text ||
      !docId
    )
      return;
    const timer = setTimeout(async () => {
      const results: Array<{ page: number; rects: Rect[] }> = [];
      try {
        for (let page = 0; page < pages; page++) {
          if (cancelled) return;
          const found = await getMupdfClient().searchPage(
            docId,
            page,
            search.query,
          );
          if (cancelled) return;
          for (const rects of found) {
            results.push({ page, rects });
            if (results.length === PREVIEW_SEARCH_LIMIT) break;
          }
          if (results.length === PREVIEW_SEARCH_LIMIT) break;
        }
        setMatches(results);
        setStatus(
          results.length === PREVIEW_SEARCH_LIMIT
            ? `First ${PREVIEW_SEARCH_LIMIT} results`
            : undefined,
        );
      } catch (error) {
        if (!cancelled) setStatus(`Search failed: ${String(error)}`);
      }
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [search.open, search.scope, search.query, search.valid, docId, pages]);
  const active = matches[index];
  useEffect(() => {
    if (active) navigate(active.page + 1, active.rects[0].y);
  }, [active, navigate]);
  const highlights = useMemo(() => {
    const map = new Map<number, PdfSearchHit[]>();
    if (!search.open) return map;
    matches.forEach((match, i) => {
      const hits = map.get(match.page) ?? [];
      hits.push({ rects: match.rects, active: i === index });
      map.set(match.page, hits);
    });
    return map;
  }, [matches, index, search.open]);
  return {
    highlights,
    count: matches.length,
    current: matches.length ? index + 1 : 0,
    status,
    move: (delta: number) => {
      if (!active) return;
      if (delta === 0 || matches.length === 1) {
        navigate(active.page + 1, active.rects[0].y);
        return;
      }
      setIndex(
        (previous) => (previous + delta + matches.length) % matches.length,
      );
    },
  };
}
