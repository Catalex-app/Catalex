import { useAppAction } from "@/hooks/use-app-actions";
import { useActionTarget } from "@/hooks/use-action-target";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { SearchPanel } from "../editor/search-panel";
import {
  previewSearchPattern,
  type PreviewSearchQuery,
} from "@/lib/preview-search";

const EMPTY_QUERY: PreviewSearchQuery = {
  text: "",
  caseSensitive: false,
  wholeWord: false,
  regex: false,
};

export function usePreviewSearch(
  scope: RefObject<HTMLElement | null>,
  identity: string | null | undefined,
  frameDocument?: Document | null,
  active = true,
) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState(EMPTY_QUERY);
  const [includeComments, setIncludeComments] = useState(true);
  const lastIdentity = useRef(identity);
  const byFile = useRef(
    new Map<string, { query: PreviewSearchQuery; includeComments: boolean }>(),
  );
  const history = useRef<string[]>([]);
  const historyIndex = useRef(-1);
  useEffect(() => {
    if (lastIdentity.current === identity) return;
    if (lastIdentity.current)
      byFile.current.set(lastIdentity.current, { query, includeComments });
    lastIdentity.current = identity;
    const saved = identity ? byFile.current.get(identity) : undefined;
    setOpen(false);
    setQuery(saved?.query ?? EMPTY_QUERY);
    setIncludeComments(saved?.includeComments ?? true);
    historyIndex.current = -1;
  }, [identity, query, includeComments]);
  useEffect(() => {
    if (!active) setOpen(false);
  }, [active]);
  const menuActive = useActionTarget(
    () => scope.current?.closest("[data-preview-pane]") ?? scope.current,
    identity,
    frameDocument ?? undefined,
    true,
  );
  const ownsFocus = useCallback(
    () => scope.current?.contains(scope.current.ownerDocument.activeElement),
    [scope],
  );
  const showSearch = useCallback(() => {
    const input = scope.current?.querySelector<HTMLInputElement>(
      '[data-testid="preview-search-panel"] input',
    );
    setOpen(true);
    input?.focus({ preventScroll: true });
    input?.select();
  }, [scope]);
  useAppAction(
    {
      id: "find",
      label: "Find…",
      enabled: active,
      run: showSearch,
      shortcut: "Mod+KeyF",
      menu: { group: "Edit", section: 1, order: 0 },
    },
    active && menuActive ? "active" : "inactive",
  );
  useEffect(() => {
    if (!active) return;
    const handler = (event: KeyboardEvent) => {
      const inFrame = event.currentTarget === frameDocument;
      const pane =
        scope.current?.closest("[data-preview-pane]") ?? scope.current;
      if (!inFrame && !pane?.contains(event.target as Node)) return;
      if (
        event.isComposing ||
        !(event.metaKey || event.ctrlKey) ||
        event.key.toLowerCase() !== "f"
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      showSearch();
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
  }, [scope, frameDocument, active, showSearch]);
  let valid = true;
  try {
    previewSearchPattern(query);
  } catch {
    valid = false;
  }
  return {
    open: active && open && lastIdentity.current === identity,
    ownsFocus,
    query,
    includeComments,
    toggleComments: () => setIncludeComments((value) => !value),
    valid,
    close: () => {
      setOpen(false);
      const content =
        scope.current?.querySelector<HTMLElement>(
          "[data-panel-content-focus]",
        ) ?? scope.current;
      content?.focus({ preventScroll: true });
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
      includeComments={search.includeComments}
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
      onToggleComments={search.toggleComments}
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
  );
}
