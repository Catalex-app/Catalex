import { canCloseSearchOnEscape } from "@/lib/search-escape";
import { useEffect, useRef, useState, type RefObject } from "react";
import { SearchPanel } from "../editor/search-panel";
import {
  previewSearchPattern,
  type PreviewSearchQuery,
} from "@/lib/preview-search";

export function usePreviewSearch(
  scope: RefObject<HTMLElement | null>,
  identity: unknown,
  frameDocument?: Document | null,
  active = true,
) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState<PreviewSearchQuery>({
    text: "",
    caseSensitive: false,
    wholeWord: false,
    regex: false,
  });
  const history = useRef<string[]>([]);
  const historyIndex = useRef(-1);
  useEffect(() => {
    setOpen(false);
    setQuery((previous) => ({ ...previous, text: "" }));
  }, [identity, active]);
  useEffect(() => {
    if (!active) return;
    const handler = (event: KeyboardEvent) => {
      const inFrame = event.currentTarget === frameDocument;
      const pane =
        scope.current?.closest("[data-preview-pane]") ?? scope.current;
      if (!inFrame && !pane?.contains(event.target as Node)) return;
      if (open && canCloseSearchOnEscape(event)) {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        scope.current?.focus({ preventScroll: true });
        return;
      }
      if (
        event.isComposing ||
        !(event.metaKey || event.ctrlKey) ||
        event.key.toLowerCase() !== "f"
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(true);
      requestAnimationFrame(() => {
        const input = scope.current?.querySelector<HTMLInputElement>(
          '[data-testid="preview-search-panel"] input',
        );
        input?.focus();
        input?.select();
      });
    };
    const pane = scope.current?.closest("[data-preview-pane]") ?? scope.current;
    const focusPane = (event: Event) => {
      if (pane?.contains(document.activeElement)) return;
      const target = event.target as Element;
      if (
        !target.closest(
          "button, input, select, textarea, a, [contenteditable], [role=button]",
        )
      )
        scope.current?.focus({ preventScroll: true });
    };
    pane?.addEventListener("mousedown", focusPane);
    pane?.addEventListener("keydown", handler as EventListener, true);
    frameDocument?.addEventListener("keydown", handler, true);
    return () => {
      pane?.removeEventListener("mousedown", focusPane);
      pane?.removeEventListener("keydown", handler as EventListener, true);
      frameDocument?.removeEventListener("keydown", handler, true);
    };
  }, [scope, frameDocument, active, open]);
  let valid = true;
  try {
    previewSearchPattern(query);
  } catch {
    valid = false;
  }
  return {
    open,
    query,
    valid,
    close: () => {
      setOpen(false);
      scope.current?.focus({ preventScroll: true });
    },
    setText: (text: string) => {
      historyIndex.current = -1;
      setQuery((previous) => ({ ...previous, text }));
    },
    toggle: (key: "caseSensitive" | "wholeWord" | "regex") =>
      setQuery((previous) => ({ ...previous, [key]: !previous[key] })),
    remember: () => {
      if (query.text && history.current[0] !== query.text)
        history.current = [
          query.text,
          ...history.current.filter((text) => text !== query.text),
        ].slice(0, 50);
    },
    history: (direction: "up" | "down") => {
      if (!history.current.length) return;
      historyIndex.current = Math.max(
        0,
        Math.min(
          history.current.length - 1,
          historyIndex.current + (direction === "up" ? 1 : -1),
        ),
      );
      setQuery((previous) => ({
        ...previous,
        text: history.current[historyIndex.current],
      }));
    },
  };
}
export function PreviewSearchPanel({
  search,
  count,
  current,
  move,
  status,
  pdf = false,
}: {
  search: ReturnType<typeof usePreviewSearch>;
  count: number;
  current: number;
  move: (delta: number) => void;
  status?: string;
  pdf?: boolean;
}) {
  if (!search.open) return null;
  const nothing = () => {};
  return (
    <div
      className="pointer-events-none absolute top-2 right-2 left-2 z-40 flex justify-end"
      data-preview-search-scope
    >
      <SearchPanel
        preview
        pdf={pdf}
        statusText={status}
        findText={search.query.text}
        replaceText=""
        isReplaceOpen={false}
        isCaseSensitive={search.query.caseSensitive}
        isWholeWord={search.query.wholeWord}
        isRegex={search.query.regex}
        preserveCase={false}
        findInSelection={false}
        canEnableFindInSelection={false}
        isQueryValid={search.valid}
        canReplace={false}
        onFindTextChange={search.setText}
        onReplaceTextChange={nothing}
        onToggleReplace={nothing}
        onToggleCaseSensitive={() => search.toggle("caseSensitive")}
        onToggleWholeWord={() => search.toggle("wholeWord")}
        onToggleRegex={() => search.toggle("regex")}
        onTogglePreserveCase={nothing}
        onToggleFindInSelection={nothing}
        onClose={search.close}
        onFindNext={() => {
          search.remember();
          move(1);
        }}
        onFindPrevious={() => {
          search.remember();
          move(-1);
        }}
        onReplaceNext={nothing}
        onReplaceAll={nothing}
        onHistoryNavigate={(_, direction) => search.history(direction)}
        matchCount={count}
        currentMatch={current}
      />
    </div>
  );
}
