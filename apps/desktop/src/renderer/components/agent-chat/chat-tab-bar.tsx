import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuConfirmItem,
} from "@/components/ui/context-menu";
import { openPanelWindow } from "@/lib/panel-windows";
import { browserHarness } from "@/lib/desktop/bridge";
import { useLibraryPromptsExpanded } from "@/hooks/use-library-prompts-expanded";
import { useSettingsStore } from "@/stores/settings-store";
import { PromptSuggestions } from "./prompt-suggestions";
import { isChatArchiveEligible } from "@/lib/chat-archive-eligibility";
import { useAgentReviewQueueStore } from "@/stores/agent-review-queue-store";
import { RoundElapsedTime } from "./round-elapsed-time";
import {
  Hint,
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";
import { toast } from "sonner";
import {
  AgentDraftNotice,
  useInterruptedReviewHold,
} from "./agent-question-prompt";
import {
  SessionStatusIndicator,
  useSessionStatus,
  sessionStatusLabel,
} from "./session-status";
import { ButtonGroup } from "@/components/ui/button-group";
import {
  useCallback,
  useRef,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
} from "react";
import {
  ArchiveIcon,
  AppWindowIcon,
  AlertCircleIcon,
  CheckCircle2Icon,
  CircleIcon,
  LoaderCircleIcon,
  PlusIcon,
  MessagesSquareIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  useAgentChatStore,
  isNewChatTab,
  type TabState,
} from "@/stores/agent-chat-store";
import { SessionSelector } from "./session-selector";

import { collapsedStatus } from "./collapsed-status";

export function ChatTabBar({
  compact = false,
  chrome = "panel",
  showSessionSelector = true,
  showNewChatButton = true,
  insetDivider = false,
}: {
  compact?: boolean;
  chrome?: "panel" | "header" | "handoff";
  showSessionSelector?: boolean;
  showNewChatButton?: boolean;
  insetDivider?: boolean;
}) {
  const isDrawerPanel = chrome === "panel" && insetDivider;
  const allTabs = useAgentChatStore((s) => s.tabs);
  const tabs = useMemo(() => allTabs.filter((tab) => !tab.archived), [allTabs]);
  const activeTabId = useAgentChatStore((s) => s.activeTabId);
  const newChat =
    tabs.find((tab) => tab.id === activeTabId && isNewChatTab(tab)) ??
    tabs.find(isNewChatTab);
  const conversationTabs = tabs.filter((tab) => !isNewChatTab(tab));
  const getStatus = useSessionStatus();
  const setActiveTab = useAgentChatStore((s) => s.setActiveTab);
  const requestNewChat = useAgentChatStore((s) => s.requestNewChat);
  const archiveTab = useAgentChatStore((s) => s.archiveTab);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [showLeftFade, setShowLeftFade] = useState(false);
  const [showRightFade, setShowRightFade] = useState(false);
  const activeTab = useMemo(
    () => tabs.find((tab) => tab.id === activeTabId),
    [tabs, activeTabId],
  );
  const activeStatus = getStatus(activeTab);
  const holdsReview = useInterruptedReviewHold();
  const statusMeta = useMemo(() => collapsedStatus(activeTab), [activeTab]);
  const statusText =
    activeStatus && activeStatus !== "working"
      ? sessionStatusLabel[activeStatus]
      : statusMeta.text;
  const updateEdgeFade = useCallback(() => {
    const container = scrollRef.current;
    if (!container) return;
    const maxScrollLeft = Math.max(
      0,
      container.scrollWidth - container.clientWidth,
    );
    const nextShowLeftFade = container.scrollLeft > 1;
    const nextShowRightFade = maxScrollLeft - container.scrollLeft > 1;
    setShowLeftFade(nextShowLeftFade);
    setShowRightFade(nextShowRightFade);
  }, []);

  const handleTabStripWheel = useCallback(
    (e: React.WheelEvent<HTMLDivElement>) => {
      const container = scrollRef.current;
      if (!container) return;
      if (container.scrollWidth <= container.clientWidth) return;

      const delta =
        Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
      if (delta === 0) return;

      e.preventDefault();
      container.scrollLeft += delta;
      updateEdgeFade();
    },
    [updateEdgeFade],
  );

  const isNewChatActive = newChat?.id === activeTabId;
  const setMiniPromptsExpanded = useAgentChatStore(
    (s) => s.setMiniPromptsExpanded,
  );
  const keepMiniPromptsOpen = useSettingsStore((s) => s.keepMiniPromptsOpen);
  const showPromptSuggestions = useLibraryPromptsExpanded(
    activeTab,
    keepMiniPromptsOpen,
  );
  const miniBarRef = useRef<HTMLDivElement>(null);
  const miniPresentation = JSON.stringify([
    compact,
    activeTabId,
    isNewChatActive,
    showPromptSuggestions,
    keepMiniPromptsOpen,
  ]);
  const previousMiniPresentation = useRef(miniPresentation);
  useLayoutEffect(() => {
    const changed = previousMiniPresentation.current !== miniPresentation;
    previousMiniPresentation.current = miniPresentation;
    const bar = miniBarRef.current;
    if (
      !changed ||
      !bar ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    )
      return;
    // One subtle fade for every presentation change; leave live status updates alone.
    const animation = bar.animate([{ opacity: 0.65 }, { opacity: 1 }], {
      duration: 200,
      easing: "ease-out",
    });
    return () => animation.cancel();
  }, [miniPresentation]);
  const conversationCount = conversationTabs.length;
  const scrollActiveTabIntoView = useCallback(
    (behavior: ScrollBehavior = "smooth") => {
      if (compact) return;
      const container = scrollRef.current;
      if (isNewChatActive && container) {
        container.scrollTo({ left: container.scrollWidth, behavior });
        return;
      }
      const el = container?.querySelector(`[data-tab-id="${activeTabId}"]`);
      el?.scrollIntoView({
        behavior,
        block: "nearest",
        inline: "nearest",
      });
    },
    [activeTabId, compact, isNewChatActive],
  );

  // Scroll active tab into view when it changes
  useEffect(() => {
    scrollActiveTabIntoView("smooth");
  }, [activeTabId, conversationCount, scrollActiveTabIntoView]);

  useEffect(() => {
    updateEdgeFade();
  }, [tabs, activeTabId, updateEdgeFade]);

  // When switching from collapsed -> open, the full tab strip mounts with the
  // same active tab id, so re-run the scroll after layout settles.
  useEffect(() => {
    if (compact) return;
    const rafId = window.requestAnimationFrame(() => {
      scrollActiveTabIntoView("auto");
      updateEdgeFade();
    });
    return () => window.cancelAnimationFrame(rafId);
  }, [compact, scrollActiveTabIntoView, updateEdgeFade]);

  // Keep the active tab visible while the open drawer finishes resizing.
  useEffect(() => {
    if (
      compact ||
      typeof ResizeObserver === "undefined" ||
      !scrollRef.current
    ) {
      return;
    }
    const observer = new ResizeObserver(() => {
      scrollActiveTabIntoView("auto");
      updateEdgeFade();
    });
    observer.observe(scrollRef.current);
    return () => observer.disconnect();
  }, [compact, scrollActiveTabIntoView, updateEdgeFade]);

  // Keyboard shortcuts: Ctrl+Tab / Ctrl+Shift+Tab to switch tabs, Ctrl+T new, Ctrl+W close
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const isMac = navigator.platform.startsWith("Mac");
      const state = useAgentChatStore.getState();
      const { activeTabId: currentActive } = state;
      const currentTabs = state.tabs.filter((tab) => !tab.archived);
      if (currentTabs.length === 0) return;

      // Ctrl+Tab / Ctrl+Shift+Tab — tab switching (all platforms)
      if (e.ctrlKey && e.key === "Tab") {
        e.preventDefault();
        const idx = currentTabs.findIndex((t) => t.id === currentActive);
        if (e.shiftKey) {
          const prev = (idx - 1 + currentTabs.length) % currentTabs.length;
          state.setActiveTab(currentTabs[prev].id);
        } else {
          const next = (idx + 1) % currentTabs.length;
          state.setActiveTab(currentTabs[next].id);
        }
        return;
      }

      // Cmd+T / Ctrl+T — new tab
      const modKey = isMac ? e.metaKey : e.ctrlKey;
      if (modKey && e.key === "t" && !e.shiftKey) {
        e.preventDefault();
        state.requestNewChat();
        return;
      }

      // Cmd+W / Ctrl+W — close tab
      if (modKey && e.key === "w" && !e.shiftKey) {
        e.preventDefault();
        void state
          .archiveTab(currentActive)
          .catch((error) => toast.error(String(error)));
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const handleCreate = useCallback(() => {
    requestNewChat();
  }, [requestNewChat]);

  const handleClose = useCallback(
    (tabId: string) => {
      void archiveTab(tabId).catch((error) => toast.error(String(error)));
    },
    [archiveTab],
  );

  if (compact) {
    return (
      <div
        ref={miniBarRef}
        data-mini-chat-bar
        className="@container/mini-bar flex items-center gap-1 px-3 pt-1 pb-0.5"
      >
        <div className="flex shrink-0 items-center gap-1">
          <SessionSelector
            triggerMode="title"
            titleLabel={activeTab?.title}
            className="max-w-[min(190px,32cqw)]"
          />
          {showNewChatButton && !isNewChatActive && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={handleCreate}
                  className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  aria-label="New chat"
                >
                  <PlusIcon className="size-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={6}>
                New chat
              </TooltipContent>
            </Tooltip>
          )}
        </div>
        <div className="flex h-[30px] min-w-0 flex-1 items-center gap-2">
          {!isNewChatActive && (
            <Hint content={activeStatus ? null : statusText}>
              <span
                data-mini-status-icon
                role="img"
                aria-label={statusText}
                className="flex size-3.5 shrink-0 items-center justify-center"
              >
                {activeStatus ? (
                  <SessionStatusIndicator status={activeStatus} />
                ) : statusMeta.state === "streaming" ? (
                  <LoaderCircleIcon
                    className="size-3.5 shrink-0 animate-spin text-primary"
                    aria-hidden="true"
                  />
                ) : statusMeta.state === "finished" ? (
                  <CheckCircle2Icon
                    className="size-3.5 shrink-0 text-emerald-500"
                    aria-hidden="true"
                  />
                ) : statusMeta.state === "error" ? (
                  <AlertCircleIcon
                    className="size-3.5 shrink-0 text-destructive"
                    aria-hidden="true"
                  />
                ) : (
                  <CircleIcon
                    className="size-3 shrink-0 text-muted-foreground/60"
                    aria-hidden="true"
                  />
                )}
              </span>
            </Hint>
          )}
          <div className="relative h-full min-w-0 flex-1">
            {!isNewChatActive && (
              <Hint content={statusText}>
                <div
                  aria-hidden={showPromptSuggestions}
                  inert={showPromptSuggestions}
                  className={cn(
                    "absolute inset-0 flex min-w-0 items-center gap-1.5 truncate pr-8 text-xs leading-none transition-[opacity,visibility] duration-150 ease-out motion-reduce:transition-none",
                    showPromptSuggestions
                      ? "invisible opacity-0"
                      : "visible opacity-100",
                    activeTab?.isStreaming
                      ? "text-foreground"
                      : "text-muted-foreground",
                  )}
                >
                  {activeStatus === "review" ||
                  activeStatus === "queued" ||
                  holdsReview ? (
                    <AgentDraftNotice compact />
                  ) : (
                    <span
                      data-testid="collapsed-chat-status"
                      className="truncate"
                    >
                      {statusText}
                    </span>
                  )}
                  {activeTab?.roundTiming &&
                    activeTab.pauseState !== "paused" && (
                      <span
                        data-testid="collapsed-round-timer"
                        className="shrink-0"
                      >
                        <RoundElapsedTime timing={activeTab.roundTiming} />
                      </span>
                    )}
                </div>
              </Hint>
            )}
            <PromptSuggestions
              compact
              compactExpanded={showPromptSuggestions}
              onCompactExpandedChange={(expanded) =>
                setMiniPromptsExpanded(activeTabId, expanded)
              }
            />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "flex items-center",
        chrome === "panel"
          ? cn(
              "border-b pt-0 pb-1.5",
              insetDivider
                ? "relative border-transparent px-3 before:pointer-events-none before:absolute before:inset-x-3 before:bottom-0 before:h-px before:bg-border"
                : "border-border px-2",
            )
          : chrome === "handoff"
            ? "h-full min-w-0 flex-1 gap-1.5"
            : "h-full min-w-0 gap-2",
      )}
    >
      {showSessionSelector ? (
        <div className="mr-1 shrink-0">
          <SessionSelector />
        </div>
      ) : null}
      <ButtonGroup
        variant="plain"
        data-chat-tab-dividers={isDrawerPanel || undefined}
        className={cn(
          "flex min-w-0 flex-1 items-center gap-1",
          isDrawerPanel && "gap-0",
          chrome === "panel" && !isDrawerPanel && "pr-1",
        )}
      >
        <div className="relative min-w-0 flex-1">
          <div
            ref={scrollRef}
            onScroll={updateEdgeFade}
            onWheel={handleTabStripWheel}
            className={cn(
              "scrollbar-none min-w-0 overflow-x-auto",
              !isDrawerPanel && "scroll-px-1",
              isDrawerPanel
                ? "py-1"
                : chrome === "panel"
                  ? "p-1"
                  : "-my-1 py-1",
            )}
          >
            <div
              data-chat-tab-strip=""
              className={cn(
                "flex w-max items-center gap-1",
                isDrawerPanel && "gap-0",
                chrome !== "panel" && "px-1",
              )}
            >
              {conversationTabs.map((tab) => (
                <TabButton
                  key={tab.id}
                  tab={tab}
                  isActive={tab.id === activeTabId}
                  isStreaming={tab.isStreaming}
                  chrome={chrome}
                  onClick={() => setActiveTab(tab.id)}
                  onClose={() => handleClose(tab.id)}
                />
              ))}
            </div>
          </div>
          {showLeftFade ? (
            <div className="pointer-events-none absolute inset-y-0 left-0 w-6 bg-gradient-to-r from-background via-background/75 to-transparent" />
          ) : null}
          {showRightFade ? (
            <div className="pointer-events-none absolute inset-y-0 right-0 w-6 bg-gradient-to-l from-background via-background/75 to-transparent" />
          ) : null}
        </div>
        {newChat ? (
          <div data-new-chat-tab="true" className="relative shrink-0">
            <TabButton
              tab={newChat}
              isActive={newChat.id === activeTabId}
              isStreaming={false}
              chrome={chrome}
              onClick={() => setActiveTab(newChat.id)}
              onClose={() => {}}
            />
          </div>
        ) : showNewChatButton && chrome !== "handoff" ? (
          <button
            type="button"
            onClick={handleCreate}
            className={cn(
              "rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
              "flex size-7 shrink-0 items-center justify-center",
            )}
            aria-label="New tab"
          >
            <PlusIcon className="size-3.5" />
          </button>
        ) : null}
      </ButtonGroup>
    </div>
  );
}

function TabButton({
  tab,
  isActive,
  isStreaming,
  chrome,
  onClick,
  onClose,
}: {
  tab: TabState;
  isActive: boolean;
  isStreaming: boolean;
  chrome: "panel" | "header" | "handoff";
  onClick: () => void;
  onClose: () => void;
}) {
  const getStatus = useSessionStatus();
  const status = getStatus(tab);
  const reviewPhase = useAgentReviewQueueStore(
    (state) =>
      state.entries.find((entry) => entry.session.tabId === tab.id)?.phase,
  );
  const canClose =
    isChatArchiveEligible(
      { ...tab, isStreaming },
      {
        isNewChat: isNewChatTab(tab),
        reviewPhases: reviewPhase ? [reviewPhase] : [],
      },
    ) &&
    (!status || tab.pauseState === "paused");
  const tabIcon = status ? (
    <SessionStatusIndicator status={status} />
  ) : (
    <MessagesSquareIcon
      className={cn(
        "size-3.5 shrink-0",
        tab.provider === "pi"
          ? "text-emerald-500"
          : tab.provider === "codex"
            ? "text-blue-500"
            : "text-amber-500",
      )}
      aria-hidden="true"
    />
  );

  if (chrome === "handoff") {
    return (
      <div
        className={cn(
          "group flex h-8 max-w-[220px] items-center gap-1 rounded-md border px-2 transition-colors",
          isActive
            ? "border-border bg-muted/50 text-foreground"
            : "border-transparent bg-transparent text-muted-foreground hover:border-border/60 hover:text-foreground",
        )}
      >
        <Hint content={tab.title}>
          <button
            type="button"
            data-tab-id={tab.id}
            onClick={onClick}
            className="flex min-w-0 flex-1 items-center gap-1 truncate text-sm"
            aria-label={tab.title}
          >
            {tabIcon}
            <span className="min-w-0 truncate">{tab.title}</span>
          </button>
        </Hint>
        {canClose ? (
          <Hint content={`Archive ${tab.title}`}>
            <button
              type="button"
              className={cn(
                "rounded px-1 text-xs leading-none",
                isActive
                  ? "text-muted-foreground hover:bg-muted hover:text-foreground"
                  : "text-muted-foreground/80 hover:bg-muted hover:text-foreground",
              )}
              onClick={onClose}
              aria-label={`Archive ${tab.title}`}
            >
              ×
            </button>
          </Hint>
        ) : null}
      </div>
    );
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild disabled={isNewChatTab(tab)}>
        <div
          data-chat-tab={tab.id}
          data-button-group-item=""
          data-active={isActive}
          className={cn(
            "group relative w-max max-w-[180px] shrink-0 overflow-hidden rounded-md text-xs transition-colors",
            isActive
              ? cn(
                  "text-foreground",
                  chrome === "panel"
                    ? "bg-muted/50"
                    : "bg-background shadow-sm",
                )
              : cn(
                  "menu-open:text-foreground text-muted-foreground hover:text-foreground",
                  chrome === "panel"
                    ? "bg-transparent"
                    : "menu-open:bg-background/70 hover:bg-background/70",
                ),
          )}
        >
          <button
            type="button"
            data-tab-id={tab.id}
            onClick={onClick}
            className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left transition-transform duration-200 motion-reduce:transition-none"
          >
            <SessionStatusIndicator status={status} />
            <span className="min-w-0 flex-1 truncate">{tab.title}</span>
          </button>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent aria-label="Chat session actions">
        <ContextMenuItem
          disabled={
            !(window.catalex || (import.meta.env.DEV && browserHarness()))
          }
          onSelect={() => openPanelWindow("chat", "duet", { chatId: tab.id })}
        >
          <AppWindowIcon className="mr-2 size-4" />
          Open in pop-out
        </ContextMenuItem>
        <ContextMenuConfirmItem
          label="Archive chat"
          icon={ArchiveIcon}
          tone="neutral"
          disabled={!canClose}
          onConfirm={onClose}
        />
      </ContextMenuContent>
    </ContextMenu>
  );
}
