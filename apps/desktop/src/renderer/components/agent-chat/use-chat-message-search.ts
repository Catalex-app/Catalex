import { useEffect, useMemo, useState, type RefObject } from "react";
import type { VirtuosoHandle } from "react-virtuoso";
import { findRenderedTextRanges } from "@/lib/preview-search";
import { invoke } from "@/lib/desktop/core";
import {
  collectChatMatches,
  type SavedChatMatches,
} from "../../../chat-message-search";
import type { AgentStreamMessage } from "@/stores/agent-chat-store";
import type { usePreviewSearch } from "../workspace/preview/preview-search-panel";

export function useChatMessageSearch({
  search,
  messages,
  projectRoot,
  tabId,
  history,
  displayedStart,
  displayedCount,
  rows,
  loadMatch,
  listRef,
  scrollerRef,
  beforeScroll,
}: {
  search: ReturnType<typeof usePreviewSearch> | undefined;
  messages: AgentStreamMessage[];
  projectRoot: string | null;
  tabId: string;
  history?: { start: number; total: number; writable?: boolean };
  displayedStart: number;
  displayedCount: number;
  rows: { messageIndex: number }[];
  loadMatch: (index: number, signal: AbortSignal) => Promise<void>;
  listRef: RefObject<VirtuosoHandle | null>;
  scrollerRef: RefObject<HTMLElement | null>;
  beforeScroll: () => void;
}) {
  const query =
    search?.open && search.valid && search.query.text ? search.query : null;
  const hasSavedHistory = !!history && !!projectRoot;
  const [saved, setSaved] = useState<{
    query: typeof query;
    result?: SavedChatMatches;
  } | null>(null);
  useEffect(() => {
    if (!query || !hasSavedHistory) return;
    let active = true;
    const timer = setTimeout(() => {
      void invoke<SavedChatMatches>("desktop:chat:search", {
        projectRoot,
        tabId,
        query,
      }).then(
        (result) => {
          if (active) setSaved({ query, result });
        },
        () => {
          if (active) setSaved({ query });
        },
      );
    }, 180);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [query, hasSavedHistory, projectRoot, tabId]);

  const savedResult = saved?.query === query ? saved.result : undefined;
  const searchingSaved = hasSavedHistory && saved?.query !== query;
  const localStart = history?.start ?? 0;
  const searchLocally = !hasSavedHistory || !!history?.writable;
  const matches = useMemo(() => {
    if (!query || searchingSaved) return [];
    const found =
      savedResult?.matches.filter(
        (match) => !searchLocally || match.messageIndex < localStart,
      ) ?? [];
    if (!searchLocally) return found;
    const local = collectChatMatches(query);
    messages.every((message, index) => local.add(message, localStart + index));
    return [...found, ...local.matches];
  }, [query, savedResult, localStart, searchLocally, searchingSaved, messages]);
  const count = matches.reduce((total, match) => total + match.count, 0);
  const [selection, setSelection] = useState<{
    query: typeof query;
    index: number;
  }>({ query: null, index: 0 });
  const index =
    selection.query === query && selection.index < count ? selection.index : 0;
  let occurrence = index;
  let messageIndex: number | undefined;
  for (const match of matches) {
    if (occurrence < match.count) {
      messageIndex = match.messageIndex;
      break;
    }
    occurrence -= match.count;
  }
  const row = rows.findIndex((item) => item.messageIndex === messageIndex);
  const [jumpError, setJumpError] = useState<{
    query: typeof query;
    index: number;
  } | null>(null);

  useEffect(() => {
    if (messageIndex === undefined || !search?.ownsFocus()) return;
    if (row >= 0) {
      beforeScroll();
      listRef.current?.scrollToIndex({ index: row, align: "center" });
      return;
    }
    if (
      messageIndex >= displayedStart &&
      messageIndex < displayedStart + displayedCount
    )
      return;
    const controller = new AbortController();
    void loadMatch(messageIndex, controller.signal).catch(() => {
      if (!controller.signal.aborted) setJumpError({ query, index });
    });
    return () => controller.abort();
  }, [
    query,
    index,
    messageIndex,
    row,
    displayedStart,
    displayedCount,
    search?.ownsFocus,
    beforeScroll,
    listRef,
    loadMatch,
  ]);

  useEffect(() => {
    const viewport = scrollerRef.current;
    if (!query || !viewport) return;
    let frame = 0;
    let pendingScroll = search?.ownsFocus() ?? false;
    const highlight = () => {
      const ranges: Range[] = [];
      let current: Range | undefined;
      for (const item of viewport.querySelectorAll<HTMLElement>(
        "[data-message-index]",
      )) {
        const itemRanges = Array.from(
          item.querySelectorAll("[data-chat-search-text], .chat-markdown"),
          (body) =>
            findRenderedTextRanges(
              body,
              query,
              "button, .katex-mathml, [aria-hidden=true]",
            ),
        ).flat();
        ranges.push(...itemRanges);
        if (Number(item.dataset.messageIndex) === messageIndex)
          current = itemRanges[occurrence ?? 0];
      }
      CSS.highlights.set("catalex-chat-search", new Highlight(...ranges));
      CSS.highlights.set(
        "catalex-chat-search-active",
        new Highlight(...(current ? [current] : [])),
      );
      if (pendingScroll && current) {
        pendingScroll = false;
        if (search?.ownsFocus())
          viewport.scrollTop +=
            current.getBoundingClientRect().top -
            viewport.getBoundingClientRect().top -
            viewport.clientHeight * 0.35;
      }
    };
    const observer = new MutationObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(highlight);
    });
    observer.observe(viewport, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    frame = requestAnimationFrame(highlight);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      CSS.highlights.delete("catalex-chat-search");
      CSS.highlights.delete("catalex-chat-search-active");
    };
  }, [
    query,
    messageIndex,
    occurrence,
    matches,
    scrollerRef,
    search?.ownsFocus,
  ]);

  return {
    count,
    current: count ? index + 1 : 0,
    status:
      query && searchingSaved
        ? "Searching…"
        : query && hasSavedHistory && !savedResult
          ? "Could not search saved messages"
          : query &&
              jumpError?.query === query &&
              jumpError.index === index &&
              row < 0
            ? "Could not load match"
            : savedResult?.truncated
              ? `First ${count} matches`
              : undefined,
    move: (delta: number) => {
      if (count)
        setSelection({ query, index: (index + delta + count) % count });
    },
  };
}
