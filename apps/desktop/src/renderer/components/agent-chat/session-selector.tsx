import { toast } from "sonner";
import { Hint } from "@/components/ui/tooltip";
import { useSessionHistoryRefresh } from "@/hooks/use-session-history-refresh";
import { updateArchivedChatTab } from "@/lib/project-chat-lifecycle";
import { PopupHeader } from "@/components/ui/popup-surface";
import { SessionStatusIndicator, useSessionStatus } from "./session-status";
import { useState, useCallback, useMemo } from "react";
import { invoke } from "@/lib/desktop/core";
import {
  MessagesSquareIcon,
  CheckIcon,
  XIcon,
  Loader2Icon,
  ChevronDownIcon,
  ArchiveIcon,
  Undo2Icon,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  useAgentChatStore,
  type ChatProvider,
  type ClaudeModelId,
  type CodexModelId,
} from "@/stores/agent-chat-store";
import { useDocumentStore } from "@/stores/document-store";
import { createLogger } from "@/lib/debug/logger";

const log = createLogger("session-selector");
const SESSION_ACTION_WIDTH = 32;
const SESSION_CONFIRM_WIDTH = 132;
const SESSION_CONFIRM_SHIFT = SESSION_CONFIRM_WIDTH - SESSION_ACTION_WIDTH;
const CURRENT_SESSION_CLASS_NAME =
  "bg-foreground/3 ring-1 ring-border ring-inset focus:bg-foreground/3 dark:bg-foreground/10 dark:focus:bg-foreground/10";
const SESSION_HOVER_CLASS_NAME = "focus:bg-foreground/4 dark:focus:bg-muted/50";

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

function providerLabel(provider: ChatProvider): {
  label: string;
  className: string;
} {
  if (provider === "pi")
    return { label: "Pi", className: "text-emerald-700 dark:text-emerald-300" };
  if (provider === "codex") {
    return {
      label: "Codex",
      className: "text-blue-700 dark:text-blue-300",
    };
  }
  return {
    label: "Claude",
    className: "text-amber-700 dark:text-amber-300",
  };
}

export function SessionSelector({
  triggerMode = "icon",
  titleLabel,
}: {
  triggerMode?: "icon" | "title";
  titleLabel?: string;
}) {
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
    log.debug(`loading shared sessions for projectRoot: ${projectRoot}`);
    try {
      const result = await invoke<SharedSessionInfo[]>("list_shared_sessions", {
        projectPath: projectRoot,
      });
      log.debug("loaded shared sessions", { count: result.length });
      setSessions(result);
    } catch (err) {
      log.error("Failed to load shared sessions", { error: String(err) });
      setSessions([]);
    } finally {
      setIsLoading(false);
    }
  }, [projectRoot]);

  useSessionHistoryRefresh(projectRoot, loadSessions);

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (open) {
        setShowArchived(false);
        setArchiveChoice(null);
        loadSessions();
      }
    },
    [loadSessions],
  );

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
    ) => {
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
    [createTab, resumeSession, setActiveTab],
  );

  const handleSelectSession = useCallback(
    async (session: SharedSessionInfo) => {
      if (isResolvingSession) return;
      if (session.shared_session_id === activeSharedSessionId) return;

      const existingTab = tabs.find(
        (tab) => tab.sharedSessionId === session.shared_session_id,
      );
      if (existingTab) {
        setActiveTab(existingTab.id);
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
          const tabId = await resumeSessionInNewTab(session.shared_session_id, {
            sessionProvider,
            sessionClaudeModel,
            sessionCodexModel,
            sessionPiModel,
            useSessionLlm: false,
          });
          if (tabId) {
            setPendingResumeChoice(tabId, {
              sharedSessionId: session.shared_session_id,
              sessionProvider,
              sessionClaudeModel,
              sessionCodexModel,
              sessionPiModel,
            });
          }
          return;
        }

        await resumeSessionInNewTab(session.shared_session_id, {
          sessionProvider,
          sessionClaudeModel,
          sessionCodexModel,
          sessionPiModel,
          useSessionLlm: false,
        });
      } finally {
        setIsResolvingSession(false);
      }
    },
    [
      isResolvingSession,
      activeSharedSessionId,
      selectedProvider,
      selectedPiModel,
      selectedClaudeModel,
      selectedCodexModel,
      tabs,
      resumeSessionInNewTab,
      setPendingResumeChoice,
      setActiveTab,
    ],
  );

  const handleArchiveToggle = useCallback(
    async (session: SharedSessionInfo) => {
      if (!projectRoot) return;
      const nextArchived = !session.archived;
      try {
        const chat = useAgentChatStore.getState();
        const existing = chat.tabs.find(
          (tab) => tab.sharedSessionId === session.shared_session_id,
        );
        if (nextArchived && existing) {
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
            archived: nextArchived,
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
    await handleArchiveToggle(session);
  }, [archiveChoice, handleArchiveToggle, sessions]);

  return (
    <>
      <DropdownMenu onOpenChange={handleOpenChange}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={
              triggerMode === "title"
                ? "flex max-w-[190px] items-center gap-1 rounded-md border border-border/70 bg-background px-2.5 py-1.5 font-medium text-foreground text-xs shadow-sm transition-colors hover:bg-background/90"
                : "flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            }
            aria-label="Session history"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
          >
            {triggerMode === "title" ? (
              <>
                <span className="truncate">{titleLabel ?? "New Chat"}</span>
                <ChevronDownIcon className="size-3 shrink-0 text-muted-foreground" />
              </>
            ) : (
              <MessagesSquareIcon className="size-3.5" />
            )}
          </button>
        </DropdownMenuTrigger>

        <DropdownMenuContent
          align="start"
          collisionPadding={8}
          side="top"
          onCloseAutoFocus={(event) => {
            // A reopened pending question owns focus; don't return it to history.
            if (document.activeElement?.matches("[data-question-option]")) {
              event.preventDefault();
            }
          }}
          className="app-scrollbar max-h-80 w-72 overflow-y-auto"
        >
          <PopupHeader>
            <MessagesSquareIcon className="size-3.5 text-muted-foreground" />
            <span>Sessions</span>
          </PopupHeader>
          <DropdownMenuSeparator />

          {isLoading ? (
            <div className="flex items-center justify-center py-4">
              <Loader2Icon className="size-4 animate-spin text-muted-foreground" />
            </div>
          ) : sessions.length === 0 ? (
            <div className="px-2 py-4 text-center text-muted-foreground text-xs">
              No previous chats
            </div>
          ) : (
            <>
              {activeSessions.map((session) => {
                const provider = normalizeChatProvider(session.last_provider);
                const providerMeta = providerLabel(provider);
                const isArchiveConfirmOpen =
                  archiveChoice?.sharedSessionId ===
                    session.shared_session_id && archiveChoice.nextArchived;
                const status = getStatus(
                  tabs.find(
                    (tab) => tab.sharedSessionId === session.shared_session_id,
                  ),
                );
                const isCurrentSession =
                  session.shared_session_id === activeSharedSessionId;
                return (
                  <DropdownMenuItem
                    key={session.shared_session_id}
                    onSelect={() => handleSelectSession(session)}
                    disabled={isResolvingSession}
                    aria-current={isCurrentSession ? "true" : undefined}
                    className={cn(
                      "relative mx-1 overflow-hidden rounded-md pr-10",
                      isCurrentSession
                        ? CURRENT_SESSION_CLASS_NAME
                        : SESSION_HOVER_CLASS_NAME,
                    )}
                  >
                    <div
                      className="flex min-w-0 flex-1 items-center gap-2 transition-transform duration-200"
                      style={{
                        transform: isArchiveConfirmOpen
                          ? `translateX(-${SESSION_CONFIRM_SHIFT}px)`
                          : undefined,
                      }}
                    >
                      <div className="flex min-w-0 flex-1 flex-col">
                        <span className="block truncate text-sm">
                          {session.title}
                        </span>
                        <div className="mt-1 flex items-center gap-1.5 text-muted-foreground text-xs">
                          <span className={providerMeta.className}>
                            {providerMeta.label}
                          </span>
                          <span aria-hidden="true">·</span>
                          <span>
                            {formatRelativeTime(session.last_modified)}
                          </span>
                        </div>
                      </div>
                      <span className="flex size-3.5 shrink-0 items-center justify-center">
                        <SessionStatusIndicator
                          status={status}
                          workingClassName="text-foreground"
                        />
                      </span>
                    </div>
                    <div
                      className="absolute inset-y-0 right-0 w-[132px] overflow-hidden"
                      style={{
                        transform: isArchiveConfirmOpen
                          ? "translateX(0)"
                          : `translateX(${SESSION_CONFIRM_SHIFT}px)`,
                        transition: "transform 200ms",
                      }}
                    >
                      <div
                        className={`absolute inset-y-0 right-0 flex w-[132px] items-center justify-end gap-2.5 px-2 ${isArchiveConfirmOpen ? "border-l bg-muted/30" : "border-l-0 bg-transparent"}`}
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={(e) => e.stopPropagation()}
                      >
                        <span
                          className={`font-medium text-muted-foreground text-xs transition-opacity duration-150 ${isArchiveConfirmOpen ? "opacity-100" : "opacity-0"}`}
                        >
                          Archive?
                        </span>
                        <div
                          className={`flex items-center gap-1 transition-opacity duration-150 ${isArchiveConfirmOpen ? "opacity-100" : "opacity-0"}`}
                        >
                          <Hint content="Confirm archive">
                            <Button
                              size="sm"
                              className="h-6 w-6 p-0"
                              aria-label="Confirm archive"
                              onClick={() => void confirmArchiveToggle()}
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
                              onClick={() => setArchiveChoice(null)}
                            >
                              <XIcon className="size-3.5" />
                            </Button>
                          </Hint>
                        </div>
                      </div>
                      <div
                        className={`absolute top-1/2 left-0 flex w-8 -translate-y-1/2 items-center justify-center transition-opacity duration-150 ${isArchiveConfirmOpen ? "pointer-events-none opacity-0" : "opacity-100"}`}
                      >
                        <Hint content="Archive chat">
                          <button
                            type="button"
                            className="flex size-6 items-center justify-center self-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                            aria-label="Archive chat"
                            onMouseDown={(e) => e.stopPropagation()}
                            onClick={(e) => {
                              e.stopPropagation();
                              setArchiveChoice({
                                sharedSessionId: session.shared_session_id,
                                nextArchived: true,
                              });
                            }}
                          >
                            <ArchiveIcon className="size-3.5" />
                          </button>
                        </Hint>
                      </div>
                    </div>
                  </DropdownMenuItem>
                );
              })}
              {archivedSessions.length > 0 ? (
                <>
                  <DropdownMenuSeparator />
                  <button
                    type="button"
                    className="flex w-full items-center justify-between px-2 py-1.5 text-left font-medium text-muted-foreground text-xs transition-colors hover:text-foreground"
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation();
                      setShowArchived((prev) => !prev);
                    }}
                  >
                    <span>Archived ({archivedSessions.length})</span>
                    <ChevronDownIcon
                      className={`size-3.5 transition-transform ${showArchived ? "" : "-rotate-90"}`}
                    />
                  </button>
                  {showArchived
                    ? archivedSessions.map((session) => {
                        const provider = normalizeChatProvider(
                          session.last_provider,
                        );
                        const providerMeta = providerLabel(provider);
                        const isRestoreConfirmOpen =
                          archiveChoice?.sharedSessionId ===
                            session.shared_session_id &&
                          !archiveChoice.nextArchived;
                        const status = getStatus(
                          tabs.find(
                            (tab) =>
                              tab.sharedSessionId === session.shared_session_id,
                          ),
                        );
                        const isCurrentSession =
                          session.shared_session_id === activeSharedSessionId;
                        return (
                          <DropdownMenuItem
                            key={session.shared_session_id}
                            onSelect={() => handleSelectSession(session)}
                            disabled={isResolvingSession}
                            aria-current={isCurrentSession ? "true" : undefined}
                            className={cn(
                              "relative mx-1 overflow-hidden rounded-md pr-10 opacity-90",
                              isCurrentSession
                                ? CURRENT_SESSION_CLASS_NAME
                                : SESSION_HOVER_CLASS_NAME,
                            )}
                          >
                            <div
                              className="flex min-w-0 flex-1 items-center gap-2 transition-transform duration-200"
                              style={{
                                transform: isRestoreConfirmOpen
                                  ? `translateX(-${SESSION_CONFIRM_SHIFT}px)`
                                  : undefined,
                              }}
                            >
                              <div className="flex min-w-0 flex-1 flex-col">
                                <span className="block truncate text-sm">
                                  {session.title}
                                </span>
                                <div className="mt-1 flex items-center gap-1.5 text-muted-foreground text-xs">
                                  <span className={providerMeta.className}>
                                    {providerMeta.label}
                                  </span>
                                  <span aria-hidden="true">·</span>
                                  <span>
                                    {formatRelativeTime(session.last_modified)}
                                  </span>
                                </div>
                              </div>
                              <span className="flex size-3.5 shrink-0 items-center justify-center">
                                <SessionStatusIndicator
                                  status={status}
                                  workingClassName="text-foreground"
                                />
                              </span>
                            </div>
                            <div
                              className="absolute inset-y-0 right-0 w-[132px] overflow-hidden"
                              style={{
                                transform: isRestoreConfirmOpen
                                  ? "translateX(0)"
                                  : `translateX(${SESSION_CONFIRM_SHIFT}px)`,
                                transition: "transform 200ms",
                              }}
                            >
                              <div
                                className={`absolute inset-y-0 right-0 flex w-[132px] items-center justify-end gap-2.5 px-2 ${isRestoreConfirmOpen ? "border-l bg-muted/30" : "border-l-0 bg-transparent"}`}
                                onMouseDown={(e) => e.stopPropagation()}
                                onClick={(e) => e.stopPropagation()}
                              >
                                <span
                                  className={`font-medium text-muted-foreground text-xs transition-opacity duration-150 ${isRestoreConfirmOpen ? "opacity-100" : "opacity-0"}`}
                                >
                                  Restore?
                                </span>
                                <div
                                  className={`flex items-center gap-1 transition-opacity duration-150 ${isRestoreConfirmOpen ? "opacity-100" : "opacity-0"}`}
                                >
                                  <Hint content="Confirm restore">
                                    <Button
                                      size="sm"
                                      className="h-6 w-6 p-0"
                                      aria-label="Confirm restore"
                                      onClick={() =>
                                        void confirmArchiveToggle()
                                      }
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
                                      onClick={() => setArchiveChoice(null)}
                                    >
                                      <XIcon className="size-3.5" />
                                    </Button>
                                  </Hint>
                                </div>
                              </div>
                              <div
                                className={`absolute top-1/2 left-0 flex w-8 -translate-y-1/2 items-center justify-center transition-opacity duration-150 ${isRestoreConfirmOpen ? "pointer-events-none opacity-0" : "opacity-100"}`}
                              >
                                <Hint content="Restore chat">
                                  <button
                                    type="button"
                                    className="flex size-6 items-center justify-center self-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                                    aria-label="Restore chat"
                                    onMouseDown={(e) => e.stopPropagation()}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setArchiveChoice({
                                        sharedSessionId:
                                          session.shared_session_id,
                                        nextArchived: false,
                                      });
                                    }}
                                  >
                                    <Undo2Icon className="size-3.5" />
                                  </button>
                                </Hint>
                              </div>
                            </div>
                          </DropdownMenuItem>
                        );
                      })
                    : null}
                </>
              ) : null}
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}
