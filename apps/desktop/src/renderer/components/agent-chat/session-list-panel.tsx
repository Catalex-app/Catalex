import { toast } from "sonner";
import { Hint } from "@/components/ui/tooltip";
import { useSessionHistoryRefresh } from "@/hooks/use-session-history-refresh";
import { useCollapsedSidebarBody } from "@/hooks/use-collapsed-sidebar-body";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
} from "@/components/ui/context-menu";
import { openPanelWindow } from "@/lib/panel-windows";
import { browserHarness } from "@/lib/desktop/bridge";
import {
  loadChatInBackground,
  updateArchivedChatTab,
} from "@/lib/project-chat-lifecycle";
import { SidebarSectionHeader } from "@/components/workspace/sidebar-layout";
import { SessionStatusIndicator, useSessionStatus } from "./session-status";
import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@/lib/desktop/core";
import {
  AppWindowIcon,
  ArchiveIcon,
  CheckIcon,
  ChevronDownIcon,
  HistoryIcon,
  Loader2Icon,
  MessagesSquareIcon,
  PlusIcon,
  RefreshCwIcon,
  Undo2Icon,
  XIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  useAgentChatStore,
  type ChatProvider,
  type ClaudeModelId,
  type CodexModelId,
} from "@/stores/agent-chat-store";
import { useDocumentStore } from "@/stores/document-store";
import { createLogger } from "@/lib/debug/logger";
import { cn } from "@/lib/utils";

const log = createLogger("session-list-panel");
const SESSION_ACTION_WIDTH = 32;
const SESSION_CONFIRM_WIDTH = 132;
const SESSION_CONFIRM_SHIFT = SESSION_CONFIRM_WIDTH - SESSION_ACTION_WIDTH;
const SESSION_SECTION_TRANSITION_MS = 180;

interface SharedSessionInfo {
  shared_session_id: string;
  title: string;
  last_modified: number;
  archived: boolean;
  last_provider: string;
  last_claude_model?: string | null;
  last_codex_model?: string | null;
  last_pi_model?: string | null;
}

interface ArchiveChoiceState {
  sharedSessionId: string;
  nextArchived: boolean;
}

function formatRelativeTime(unixSeconds: number): string {
  const now = Date.now() / 1000;
  const delta = now - unixSeconds;

  if (delta < 60) return "just now";
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
  if (delta < 604800) return `${Math.floor(delta / 86400)}d ago`;

  const date = new Date(unixSeconds * 1000);
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function normalizeChatProvider(raw: string | undefined): ChatProvider {
  return raw === "pi" ? "pi" : raw === "codex" ? "codex" : "claude";
}

function normalizeClaudeModel(
  raw: string | undefined | null,
): ClaudeModelId | null {
  if (!raw) return null;
  const normalized = raw.toLowerCase();
  if (normalized.includes("opusplan")) return "opus";
  if (normalized.includes("haiku")) return "haiku";
  if (normalized.includes("sonnet")) return "sonnet";
  if (normalized.includes("opus")) return "opus";
  return null;
}

function normalizeCodexModel(
  raw: string | undefined | null,
): CodexModelId | null {
  if (!raw) return null;
  if (raw === "default") return "gpt-5.4";
  if (raw === "gpt-5.2-codex") return "gpt-5.2";
  return raw.trim() || null;
}

function providerBubbleColor(provider: ChatProvider): string {
  return provider === "pi"
    ? "text-emerald-500"
    : provider === "codex"
      ? "text-blue-500"
      : "text-amber-500";
}

export function SessionListPanel({
  className,
  collapsible = false,
  collapsed = false,
  onToggleCollapse,
  active = true,
}: {
  className?: string;
  collapsible?: boolean;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  active?: boolean;
}) {
  const bodyRef = useCollapsedSidebarBody(collapsed);
  const [sessions, setSessions] = useState<SharedSessionInfo[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isResolvingSession, setIsResolvingSession] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [archiveChoice, setArchiveChoice] = useState<ArchiveChoiceState | null>(
    null,
  );

  const selectedPiModel = useAgentChatStore((s) => s.selectedPiModel);
  const selectedProvider = useAgentChatStore((s) => s.selectedProvider);
  const selectedClaudeModel = useAgentChatStore((s) => s.selectedClaudeModel);
  const selectedCodexModel = useAgentChatStore((s) => s.selectedCodexModel);
  const activeTabId = useAgentChatStore((s) => s.activeTabId);
  const tabs = useAgentChatStore((s) => s.tabs);
  const getStatus = useSessionStatus();
  const createTab = useAgentChatStore((s) => s.createTab);
  const requestNewChat = useAgentChatStore((s) => s.requestNewChat);
  const setActiveTab = useAgentChatStore((s) => s.setActiveTab);
  const setPendingResumeChoice = useAgentChatStore(
    (s) => s.setPendingResumeChoice,
  );
  const resumeSession = useAgentChatStore((s) => s.resumeSession);
  const projectRoot = useDocumentStore((s) => s.projectRoot);
  const activeSharedSessionId =
    tabs.find((tab) => tab.id === activeTabId)?.sharedSessionId ?? null;

  const loadSessions = useCallback(async () => {
    if (!projectRoot) return;
    setIsLoading(true);
    try {
      const result = await invoke<SharedSessionInfo[]>("list_shared_sessions", {
        projectPath: projectRoot,
      });
      setSessions(result);
    } catch (err) {
      log.error("Failed to load shared sessions", { error: String(err) });
      setSessions([]);
    } finally {
      setIsLoading(false);
    }
  }, [projectRoot]);

  useSessionHistoryRefresh(projectRoot, loadSessions, active);

  // Refresh when a new live conversation is first persisted, not on each token.
  const liveSessionIds = tabs
    .map((tab) => `${tab.sharedSessionId}:${!!tab.archived}`)
    .join(",");
  useEffect(() => {
    if (!active) return;
    void loadSessions();
  }, [active, loadSessions, liveSessionIds]);

  const activeSessions = useMemo(
    () => sessions.filter((session) => !session.archived),
    [sessions],
  );
  const archivedSessions = useMemo(
    () => sessions.filter((session) => session.archived),
    [sessions],
  );

  const resumeSessionInNewTab = useCallback(
    async (
      sharedSessionId: string,
      options: Parameters<typeof resumeSession>[1] = {},
      background = false,
    ) => {
      if (background)
        return projectRoot
          ? loadChatInBackground(projectRoot, sharedSessionId)
          : undefined;
      const existingTab = useAgentChatStore
        .getState()
        .tabs.find((tab) => tab.sharedSessionId === sharedSessionId);
      if (existingTab) {
        setActiveTab(existingTab.id);
        return existingTab.id;
      }
      const newTabId = createTab();
      await resumeSession(sharedSessionId, options);
      setActiveTab(newTabId, true);
      return newTabId;
    },
    [createTab, resumeSession, setActiveTab, projectRoot],
  );

  const handleSelectSession = useCallback(
    async (session: SharedSessionInfo, popOut = false) => {
      if (isResolvingSession) return;
      if (!popOut && session.shared_session_id === activeSharedSessionId)
        return;
      if (popOut && session.archived) return;

      const existingTab = tabs.find(
        (tab) => tab.sharedSessionId === session.shared_session_id,
      );
      if (existingTab) {
        if (popOut) openPanelWindow("chat", "duet", { chatId: existingTab.id });
        else setActiveTab(existingTab.id);
        return;
      }

      setIsResolvingSession(true);
      try {
        const sessionProvider = normalizeChatProvider(session.last_provider);
        const sessionClaudeModel = normalizeClaudeModel(
          session.last_claude_model,
        );
        const sessionCodexModel = normalizeCodexModel(session.last_codex_model);

        const sessionPiModel = session.last_pi_model ?? null;
        const providerMismatch = selectedProvider !== sessionProvider;
        const modelMismatch =
          selectedProvider === "pi"
            ? sessionPiModel !== null && selectedPiModel !== sessionPiModel
            : selectedProvider === "claude"
              ? sessionClaudeModel !== null &&
                selectedClaudeModel !== sessionClaudeModel
              : sessionCodexModel !== null &&
                selectedCodexModel !== sessionCodexModel;

        if (providerMismatch || modelMismatch) {
          const tabId = await resumeSessionInNewTab(
            session.shared_session_id,
            {
              sessionProvider,
              sessionClaudeModel,
              sessionCodexModel,
              sessionPiModel,
              useSessionLlm: false,
            },
            popOut,
          );
          if (tabId) {
            setPendingResumeChoice(tabId, {
              sharedSessionId: session.shared_session_id,
              sessionProvider,
              sessionClaudeModel,
              sessionCodexModel,
              sessionPiModel,
            });
            if (popOut) openPanelWindow("chat", "duet", { chatId: tabId });
          }
          return;
        }

        const tabId = await resumeSessionInNewTab(
          session.shared_session_id,
          {
            sessionProvider,
            sessionClaudeModel,
            sessionCodexModel,
            sessionPiModel,
            useSessionLlm: false,
          },
          popOut,
        );
        if (popOut && tabId) openPanelWindow("chat", "duet", { chatId: tabId });
      } catch (error) {
        toast.error(
          `Could not open chat: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        setIsResolvingSession(false);
      }
    },
    [
      activeSharedSessionId,
      isResolvingSession,
      resumeSessionInNewTab,
      selectedClaudeModel,
      selectedCodexModel,
      selectedProvider,
      selectedPiModel,
      setPendingResumeChoice,
      setActiveTab,
      tabs,
    ],
  );

  const handleNewChat = useCallback(() => {
    if (isResolvingSession) return;
    requestNewChat();
  }, [isResolvingSession, requestNewChat]);

  const handleArchiveToggle = useCallback(
    async (session: SharedSessionInfo, archived: boolean) => {
      if (!projectRoot) return;
      try {
        const chat = useAgentChatStore.getState();
        const existing = chat.tabs.find(
          (tab) => tab.sharedSessionId === session.shared_session_id,
        );
        if (archived && existing) {
          await chat.archiveTab(existing.id);
          if (
            !useAgentChatStore
              .getState()
              .tabs.find((tab) => tab.id === existing.id)?.archived
          )
            return;
          setSessions((items) =>
            items.map((item) =>
              item.shared_session_id === session.shared_session_id
                ? { ...item, archived: true }
                : item,
            ),
          );
          return;
        }
        const updated = await invoke<SharedSessionInfo>(
          "set_shared_session_archived",
          {
            projectPath: projectRoot,
            sharedSessionId: session.shared_session_id,
            archived,
          },
        );
        await updateArchivedChatTab(
          projectRoot,
          updated.shared_session_id,
          updated.archived,
        );
        setSessions((prev) => {
          const next = prev.map((item) =>
            item.shared_session_id === updated.shared_session_id
              ? updated
              : item,
          );
          next.sort((a, b) => b.last_modified - a.last_modified);
          return next;
        });
      } catch (err) {
        log.error("Failed to update archive state", { error: String(err) });
        toast.error(`Could not update archive: ${String(err)}`);
      }
    },
    [projectRoot],
  );

  const confirmArchiveToggle = useCallback(async () => {
    if (!archiveChoice) return;
    const session = sessions.find(
      (item) => item.shared_session_id === archiveChoice.sharedSessionId,
    );
    setArchiveChoice(null);
    if (!session) return;
    await handleArchiveToggle(session, archiveChoice.nextArchived);
  }, [archiveChoice, handleArchiveToggle, sessions]);

  return (
    <div className={cn("flex min-h-0 flex-col", className)}>
      <SidebarSectionHeader
        section="sessions"
        wideActions
        title="Sessions"
        icon={<HistoryIcon className="size-3.5" />}
        collapsed={collapsed}
        onToggle={collapsible ? onToggleCollapse : undefined}
        actions={
          <>
            <Hint content="Refresh">
              <Button
                variant="ghost"
                size="icon"
                className="size-5"
                aria-label="Refresh"
                onClick={() => void loadSessions()}
              >
                <RefreshCwIcon
                  className={cn("size-3", isLoading && "animate-spin")}
                />
              </Button>
            </Hint>
            <Hint content="New chat">
              <Button
                variant="ghost"
                size="icon"
                className="size-5"
                aria-label="New chat"
                onClick={handleNewChat}
                disabled={isResolvingSession}
              >
                <PlusIcon className="size-3" />
              </Button>
            </Hint>
          </>
        }
      />

      <div
        aria-hidden={collapsed}
        ref={bodyRef}
        className={cn(
          "grid min-h-0 overflow-hidden transition-[grid-template-rows] ease-out",
          collapsed ? "pointer-events-none grid-rows-[0fr]" : "grid-rows-[1fr]",
          !collapsed && "flex-1",
        )}
        style={{ transitionDuration: `${SESSION_SECTION_TRANSITION_MS}ms` }}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="app-scrollbar h-full min-h-0 overflow-y-auto">
            {isLoading && sessions.length === 0 ? (
              <div className="flex items-center justify-center py-6">
                <Loader2Icon className="size-4 animate-spin text-muted-foreground" />
              </div>
            ) : sessions.length === 0 ? (
              <div className="rounded-lg border border-border/70 border-dashed px-3 py-6 text-center text-muted-foreground text-sm">
                No previous sessions
              </div>
            ) : (
              <div>
                {activeSessions.map((session) => {
                  const provider = normalizeChatProvider(session.last_provider);
                  const liveTab = tabs.find(
                    (tab) => tab.sharedSessionId === session.shared_session_id,
                  );
                  const status = getStatus(liveTab);
                  const isCurrentSession =
                    session.shared_session_id === activeSharedSessionId;
                  const isArchiveConfirmOpen =
                    archiveChoice?.sharedSessionId ===
                      session.shared_session_id && archiveChoice.nextArchived;
                  return (
                    <ContextMenu key={session.shared_session_id}>
                      <ContextMenuTrigger
                        asChild
                        disabled={
                          !(
                            window.catalex ||
                            (import.meta.env.DEV && browserHarness())
                          )
                        }
                      >
                        <div
                          className={cn(
                            "group relative overflow-hidden rounded-lg transition-colors",
                            isCurrentSession
                              ? "bg-sidebar-accent text-sidebar-accent-foreground"
                              : "bg-transparent text-muted-foreground hover:bg-sidebar-accent/50 hover:text-foreground",
                          )}
                        >
                          <button
                            type="button"
                            className="flex w-full min-w-0 items-center gap-2 py-2 pr-10 pl-2 text-left transition-transform duration-200"
                            style={{
                              transform: isArchiveConfirmOpen
                                ? `translateX(-${SESSION_CONFIRM_SHIFT}px)`
                                : undefined,
                            }}
                            onClick={() => void handleSelectSession(session)}
                            disabled={isResolvingSession}
                          >
                            {status ? (
                              <SessionStatusIndicator
                                status={status}
                                workingClassName={providerBubbleColor(
                                  liveTab?.provider ?? provider,
                                )}
                              />
                            ) : (
                              <MessagesSquareIcon
                                className={cn(
                                  "size-3.5 shrink-0",
                                  providerBubbleColor(provider),
                                )}
                                aria-hidden="true"
                              />
                            )}
                            <span
                              className={cn(
                                "min-w-0 flex-1 truncate text-sm",
                                isCurrentSession
                                  ? "text-sidebar-accent-foreground"
                                  : "text-foreground",
                              )}
                            >
                              {session.title}
                            </span>
                            <span className="shrink-0 text-muted-foreground text-xs">
                              {formatRelativeTime(session.last_modified)}
                            </span>
                          </button>
                          <Hint content="Archive chat">
                            <button
                              type="button"
                              className="absolute top-1/2 right-2 z-10 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition-opacity duration-150 hover:bg-muted hover:text-foreground data-[hidden=true]:pointer-events-none data-[hidden=true]:opacity-0"
                              data-hidden={isArchiveConfirmOpen}
                              onMouseDown={(e) => e.stopPropagation()}
                              onClick={(e) => {
                                e.stopPropagation();
                                setArchiveChoice({
                                  sharedSessionId: session.shared_session_id,
                                  nextArchived: true,
                                });
                              }}
                              aria-label="Archive chat"
                            >
                              <ArchiveIcon className="size-3.5" />
                            </button>
                          </Hint>
                          <div
                            className={cn(
                              "absolute inset-y-0 right-0 z-10 w-[132px] overflow-hidden",
                              isArchiveConfirmOpen
                                ? "pointer-events-auto"
                                : "pointer-events-none",
                            )}
                            style={{
                              transform: isArchiveConfirmOpen
                                ? "translateX(0)"
                                : `translateX(${SESSION_CONFIRM_SHIFT}px)`,
                              transition: "transform 200ms",
                            }}
                          >
                            <div
                              className={cn(
                                "absolute inset-y-0 right-0 flex w-[132px] items-center justify-end gap-2.5 px-2",
                                isArchiveConfirmOpen
                                  ? "border-l bg-muted/30"
                                  : "border-l-0 bg-transparent",
                              )}
                            >
                              <span
                                className={cn(
                                  "font-medium text-muted-foreground text-xs transition-opacity duration-150",
                                  isArchiveConfirmOpen
                                    ? "opacity-100"
                                    : "opacity-0",
                                )}
                              >
                                Archive?
                              </span>
                              <div
                                className={cn(
                                  "flex items-center gap-1 transition-opacity duration-150",
                                  isArchiveConfirmOpen
                                    ? "opacity-100"
                                    : "opacity-0",
                                )}
                              >
                                <Hint content="Confirm archive">
                                  <Button
                                    size="sm"
                                    className="h-6 w-6 p-0"
                                    aria-label="Confirm archive"
                                    onMouseDown={(e) => e.stopPropagation()}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      void confirmArchiveToggle();
                                    }}
                                  >
                                    <CheckIcon className="size-3.5 text-white dark:text-black" />
                                  </Button>
                                </Hint>
                                <Hint content="Cancel archive">
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    className="h-6 w-6 p-0"
                                    aria-label="Cancel archive"
                                    onMouseDown={(e) => e.stopPropagation()}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setArchiveChoice(null);
                                    }}
                                  >
                                    <XIcon className="size-3.5" />
                                  </Button>
                                </Hint>
                              </div>
                            </div>
                          </div>
                        </div>
                      </ContextMenuTrigger>
                      <ContextMenuContent aria-label="Chat session actions">
                        <ContextMenuItem
                          disabled={isResolvingSession}
                          onSelect={() =>
                            void handleSelectSession(session, true)
                          }
                        >
                          <AppWindowIcon className="mr-2 size-4" />
                          Open in pop-out
                        </ContextMenuItem>
                      </ContextMenuContent>
                    </ContextMenu>
                  );
                })}

                {archivedSessions.length > 0 ? (
                  <div className="pt-2">
                    <button
                      type="button"
                      className="flex w-full items-center justify-between px-2 py-1 text-left font-medium text-muted-foreground text-xs transition-colors hover:text-foreground"
                      onClick={() => setShowArchived((prev) => !prev)}
                    >
                      <span>Archived ({archivedSessions.length})</span>
                      <ChevronDownIcon
                        className={cn(
                          "size-3.5 transition-transform",
                          showArchived ? "" : "-rotate-90",
                        )}
                      />
                    </button>
                    {showArchived ? (
                      <div className="mt-1">
                        {archivedSessions.map((session) => {
                          const provider = normalizeChatProvider(
                            session.last_provider,
                          );
                          const liveTab = tabs.find(
                            (tab) =>
                              tab.sharedSessionId === session.shared_session_id,
                          );
                          const status = getStatus(liveTab);
                          const isRestoreConfirmOpen =
                            archiveChoice?.sharedSessionId ===
                              session.shared_session_id &&
                            !archiveChoice.nextArchived;
                          return (
                            <div
                              key={session.shared_session_id}
                              className="group relative overflow-hidden rounded-lg opacity-85 transition-colors hover:bg-sidebar-accent/50 hover:text-foreground"
                            >
                              <button
                                type="button"
                                className="flex w-full min-w-0 items-center gap-2 py-2 pr-10 pl-2 text-left transition-transform duration-200"
                                style={{
                                  transform: isRestoreConfirmOpen
                                    ? `translateX(-${SESSION_CONFIRM_SHIFT}px)`
                                    : undefined,
                                }}
                                onClick={() =>
                                  void handleSelectSession(session)
                                }
                                disabled={isResolvingSession}
                              >
                                {status ? (
                                  <SessionStatusIndicator
                                    status={status}
                                    workingClassName={providerBubbleColor(
                                      liveTab?.provider ?? provider,
                                    )}
                                  />
                                ) : (
                                  <MessagesSquareIcon
                                    className={cn(
                                      "size-3.5 shrink-0",
                                      providerBubbleColor(provider),
                                    )}
                                    aria-hidden="true"
                                  />
                                )}
                                <span className="min-w-0 flex-1 truncate text-foreground text-sm">
                                  {session.title}
                                </span>
                                <span className="shrink-0 text-muted-foreground text-xs">
                                  {formatRelativeTime(session.last_modified)}
                                </span>
                              </button>
                              <Hint content="Restore chat">
                                <button
                                  type="button"
                                  className="absolute top-1/2 right-2 z-10 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition-opacity duration-150 hover:bg-muted hover:text-foreground data-[hidden=true]:pointer-events-none data-[hidden=true]:opacity-0"
                                  data-hidden={isRestoreConfirmOpen}
                                  onMouseDown={(e) => e.stopPropagation()}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setArchiveChoice({
                                      sharedSessionId:
                                        session.shared_session_id,
                                      nextArchived: false,
                                    });
                                  }}
                                  aria-label="Restore chat"
                                >
                                  <Undo2Icon className="size-3.5" />
                                </button>
                              </Hint>
                              <div
                                className={cn(
                                  "absolute inset-y-0 right-0 z-10 w-[132px] overflow-hidden",
                                  isRestoreConfirmOpen
                                    ? "pointer-events-auto"
                                    : "pointer-events-none",
                                )}
                                style={{
                                  transform: isRestoreConfirmOpen
                                    ? "translateX(0)"
                                    : `translateX(${SESSION_CONFIRM_SHIFT}px)`,
                                  transition: "transform 200ms",
                                }}
                              >
                                <div
                                  className={cn(
                                    "absolute inset-y-0 right-0 flex w-[132px] items-center justify-end gap-2.5 px-2",
                                    isRestoreConfirmOpen
                                      ? "border-l bg-muted/30"
                                      : "border-l-0 bg-transparent",
                                  )}
                                >
                                  <span
                                    className={cn(
                                      "font-medium text-muted-foreground text-xs transition-opacity duration-150",
                                      isRestoreConfirmOpen
                                        ? "opacity-100"
                                        : "opacity-0",
                                    )}
                                  >
                                    Restore?
                                  </span>
                                  <div
                                    className={cn(
                                      "flex items-center gap-1 transition-opacity duration-150",
                                      isRestoreConfirmOpen
                                        ? "opacity-100"
                                        : "opacity-0",
                                    )}
                                  >
                                    <Hint content="Confirm restore">
                                      <Button
                                        size="sm"
                                        className="h-6 w-6 p-0"
                                        aria-label="Confirm restore"
                                        onMouseDown={(e) => e.stopPropagation()}
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          void confirmArchiveToggle();
                                        }}
                                      >
                                        <CheckIcon className="size-3.5 text-white dark:text-black" />
                                      </Button>
                                    </Hint>
                                    <Hint content="Cancel restore">
                                      <Button
                                        size="sm"
                                        variant="outline"
                                        className="h-6 w-6 p-0"
                                        aria-label="Cancel restore"
                                        onMouseDown={(e) => e.stopPropagation()}
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          setArchiveChoice(null);
                                        }}
                                      >
                                        <XIcon className="size-3.5" />
                                      </Button>
                                    </Hint>
                                  </div>
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
