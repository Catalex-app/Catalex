import {
  getAppMenuItems,
  runMenuAction,
  useAppAction,
} from "@/hooks/use-app-actions";
import { useActionTarget } from "@/hooks/use-action-target";
import { useSettingsStore } from "@/stores/settings-store";
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
  type SearchScope,
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
  {
    frameDocument,
    active = true,
    available = true,
    infoBarProjectKey,
    panelTestId = "preview-search-panel",
  }: {
    frameDocument?: Document | null;
    active?: boolean;
    available?: boolean;
    infoBarProjectKey?: string;
    panelTestId?: string;
  } = {},
) {
  const [open, setOpen] = useState(false);
  const commentsPanelOpen = useSettingsStore(
    (s) =>
      infoBarProjectKey !== undefined &&
      s.displayComments &&
      s.showPdfComments &&
      s.editorCommentsPanelOpenByProject[infoBarProjectKey] === true,
  );
  const [query, setQuery] = useState(EMPTY_QUERY);
  const [searchScope, setSearchScope] = useState<SearchScope>("all");
  const lastIdentity = useRef(identity);
  const byFile = useRef(
    new Map<string, { query: PreviewSearchQuery; searchScope: SearchScope }>(),
  );
  const history = useRef<string[]>([]);
  const historyIndex = useRef(-1);
  useEffect(() => {
    if (lastIdentity.current === identity) return;
    if (lastIdentity.current)
      byFile.current.set(lastIdentity.current, { query, searchScope });
    lastIdentity.current = identity;
    const saved = identity ? byFile.current.get(identity) : undefined;
    setOpen(false);
    setQuery(saved?.query ?? EMPTY_QUERY);
    setSearchScope(saved?.searchScope ?? "all");
    historyIndex.current = -1;
  }, [identity, query, searchScope]);
  useEffect(() => {
    if (!active || !available || commentsPanelOpen) setOpen(false);
  }, [active, available, commentsPanelOpen]);
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
      `[data-testid="${panelTestId}"] input`,
    );
    if (!input && infoBarProjectKey !== undefined)
      useSettingsStore.getState().setEditorInfoBar(infoBarProjectKey, null);
    setOpen(true);
    input?.focus({ preventScroll: true });
    input?.select();
  }, [scope, infoBarProjectKey, panelTestId]);
  useAppAction(
    {
      id: "find",
      label: "Find…",
      visible: active && available,
      run: showSearch,
      shortcut: "Mod+KeyF",
      menu: { group: "Edit", section: 1, order: 0 },
    },
    active && available && menuActive ? "active" : "inactive",
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
      if (available) {
        showSearch();
      } else {
        const find = getAppMenuItems().find((item) => item.id === "find");
        if (find) void runMenuAction({ command: find.id, key: find.key });
      }
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
  }, [scope, frameDocument, active, available, showSearch]);
  let valid = true;
  try {
    previewSearchPattern(query);
  } catch {
    valid = false;
  }
  const close = useCallback(() => {
    setOpen(false);
    const content =
      scope.current?.querySelector<HTMLElement>("[data-panel-content-focus]") ??
      scope.current;
    content?.focus({ preventScroll: true });
  }, [scope]);
  return {
    open:
      active &&
      available &&
      open &&
      !commentsPanelOpen &&
      lastIdentity.current === identity,
    show: showSearch,
    ownsFocus,
    query,
    scope: searchScope,
    setScope: setSearchScope,
    valid,
    close,
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
  testId,
  textOnly = false,
}: {
  search: ReturnType<typeof usePreviewSearch>;
  count: number;
  current: number;
  move: (delta: number) => void;
  status?: string;
  pdf?: boolean;
  testId?: string;
  textOnly?: boolean;
}) {
  if (!search.open) return null;
  const nothing = () => {};
  return (
    <SearchPanel
      preview
      testId={testId}
      pdf={pdf}
      statusText={status}
      findText={search.query.text}
      replaceText=""
      isReplaceOpen={false}
      isCaseSensitive={search.query.caseSensitive}
      isWholeWord={search.query.wholeWord}
      isRegex={search.query.regex}
      scope={textOnly ? "text" : search.scope}
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
      onScopeChange={textOnly ? undefined : search.setScope}
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
      onFindCurrent={() => move(0)}
      onReplaceNext={nothing}
      onReplaceAll={nothing}
      onHistoryNavigate={(_, direction) => search.history(direction)}
      matchCount={count}
      currentMatch={current}
    />
  );
}
