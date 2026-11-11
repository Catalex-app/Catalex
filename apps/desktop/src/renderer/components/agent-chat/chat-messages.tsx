import { useLibraryPromptsExpanded } from "@/hooks/use-library-prompts-expanded";
import { RoundElapsedTime } from "./round-elapsed-time";
import { Separator } from "@/components/ui/separator";
import { chatModelSectionLabels } from "@/lib/chat-model-sections";
import { providerStatusLabel } from "@/lib/agent-provider-status";
import { useSettingsStore } from "@/stores/settings-store";
import { formatRoundDuration } from "@/lib/agent-round-timing";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import {
  type FC,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  AlertCircleIcon,
  CheckIcon,
  CopyIcon,
  GitForkIcon,
  LoaderCircleIcon,
  ClockIcon,
} from "lucide-react";
import { TooltipIconButton } from "@/components/assistant-ui/tooltip-icon-button";
import {
  useAgentChatStore,
  type AgentStreamMessage,
  type ContentBlock,
} from "@/stores/agent-chat-store";
import { MarkdownRenderer } from "./markdown-renderer";
import { ChatImagePreview } from "./chat-image-preview";
import { ThinkingWidget, ToolWidget } from "./tool-widgets";

const readingPositions = new Map<
  string,
  { start: number; anchor: number; offset: number }
>();

// ─── Streaming Indicator (isolated to prevent re-render storms) ───

const StreamingIndicator: FC = memo(() => {
  const timing = useAgentChatStore(
    (state) =>
      state.tabs.find((tab) => tab.id === state.activeTabId)?.roundTiming,
  );
  const paused = useAgentChatStore(
    (state) =>
      state.tabs.find((tab) => tab.id === state.activeTabId)?.pauseState ===
      "paused",
  );
  const waiting = Boolean(timing?.waitingFor.length);
  const providerLabel = useAgentChatStore((state) => {
    const tab = state.tabs.find((item) => item.id === state.activeTabId);
    return providerStatusLabel(tab?.providerStatus);
  });

  return (
    <div
      data-testid="round-timer"
      className="flex items-center gap-1.5 px-1 py-1.5 text-muted-foreground"
    >
      {paused || waiting ? (
        <ClockIcon className="size-3.5 shrink-0" aria-hidden="true" />
      ) : (
        <LoaderCircleIcon
          className="size-3.5 shrink-0 animate-spin text-primary"
          aria-hidden="true"
        />
      )}
      <span className="text-sm">
        {paused
          ? "Paused"
          : waiting
            ? "Waiting for you"
            : (providerLabel ?? "Working...")}
        {timing && !paused && <RoundElapsedTime timing={timing} />}
      </span>
    </div>
  );
});

// ─── Chat Messages (main component) ───

export const ChatMessages: FC<{
  revealHistory?: boolean;
  reservePromptSpace?: boolean;
}> = ({ revealHistory, reservePromptSpace = false }) => {
  const activeTabId = useAgentChatStore((s) => s.activeTabId);
  const projectRoot = useAgentChatStore((s) => s.chatProjectRoot);
  const activeTab = useAgentChatStore((s) =>
    s.tabs.find((tab) => tab.id === s.activeTabId),
  );
  const promptsPinned = useSettingsStore((s) => s.keepMiniPromptsOpen);
  const promptsFolded = !useLibraryPromptsExpanded(activeTab, promptsPinned);
  return (
    <ChatMessagesForTab
      key={`${projectRoot}:${activeTabId}`}
      revealHistory={revealHistory}
      reservePromptSpace={reservePromptSpace && promptsFolded}
    />
  );
};

// Keep pending page requests and scroll observers scoped to the displayed chat.
const ChatMessagesForTab: FC<{
  revealHistory?: boolean;
  reservePromptSpace: boolean;
}> = ({ revealHistory, reservePromptSpace }) => {
  const [historyReady, setHistoryReady] = useState(false);
  const revealFrame = useRef<number | null>(null);
  const historyMeasured = useRef(false);
  const revealRenderedHistory = useCallback((items: unknown[]) => {
    if (!items.length || historyMeasured.current) return;
    historyMeasured.current = true;
    // Let the virtual list finish its initial measurement and scroll positioning
    // before fading actual messages, rather than an empty container.
    const revealWhenPositioned = () => {
      const list = scrollerRef.current?.querySelector<HTMLElement>(
        '[data-testid="virtuoso-item-list"]',
      );
      if (list && getComputedStyle(list).visibility !== "hidden") {
        setHistoryReady(true);
        return;
      }
      revealFrame.current = requestAnimationFrame(revealWhenPositioned);
    };
    revealFrame.current = requestAnimationFrame(revealWhenPositioned);
  }, []);
  useEffect(
    () => () => {
      if (revealFrame.current !== null)
        cancelAnimationFrame(revealFrame.current);
    },
    [],
  );
  const activeTabId = useAgentChatStore((s) => s.activeTabId);
  const messages = useAgentChatStore((s) => s.messages) ?? [];
  const isStreaming = useAgentChatStore((s) => s.isStreaming);
  const isPaused = useAgentChatStore(
    (s) =>
      s.tabs.find((tab) => tab.id === s.activeTabId)?.pauseState === "paused",
  );
  const isWaiting = useAgentChatStore((s) => {
    const timing = s.tabs.find((tab) => tab.id === s.activeTabId)?.roundTiming;
    return Boolean(timing && !timing.finished && timing.waitingFor.length);
  });
  const forkSessionAtMessage = useAgentChatStore((s) => s.forkSessionAtMessage);
  const projectRoot = useAgentChatStore((s) => s.chatProjectRoot);
  const positionKey = `${projectRoot}:${activeTabId}`;
  const history = useAgentChatStore(
    (s) => s.tabs.find((tab) => tab.id === s.activeTabId)?.history,
  );
  const listRef = useRef<VirtuosoHandle>(null);
  const scrollerRef = useRef<HTMLElement | null>(null);
  const atBottom = useRef(true);
  const userScrolled = useRef(false);
  const scrollDirection = useRef<"up" | "down" | null>(null);
  const previousScrollTop = useRef(0);
  useEffect(() => {
    userScrolled.current = readingPositions.has(positionKey);
    atBottom.current = !readingPositions.has(positionKey);
  }, [positionKey]);
  const loading = useRef(false);
  const pendingAnchor = useRef<{ index: number; offset: number } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const loadWindow = async (start: number, limit = 600) => {
    if (loading.current) return;
    loading.current = true;
    const viewport = scrollerRef.current;
    if (viewport && userScrolled.current) {
      const top = viewport.getBoundingClientRect().top;
      const anchor = [
        ...viewport.querySelectorAll<HTMLElement>("[data-message-index]"),
      ].find(
        (item) =>
          item.getBoundingClientRect().bottom > top &&
          item.getBoundingClientRect().top < top + viewport.clientHeight,
      );
      pendingAnchor.current = anchor
        ? {
            index: Number(anchor.dataset.messageIndex),
            offset: anchor.getBoundingClientRect().top - top,
          }
        : {
            index:
              scrollDirection.current === "down"
                ? (history?.start ?? 0) + messages.length - 1
                : (history?.start ?? 0),
            offset: 0,
          };
    }
    try {
      await useAgentChatStore.getState().loadHistory(activeTabId, start, limit);
      setLoadError(null);
    } catch (error) {
      setLoadError(String(error));
    } finally {
      loading.current = false;
    }
  };
  useEffect(() => {
    if (history && messages.length === 0 && history.total > 0)
      void loadWindow(
        readingPositions.get(positionKey)?.start ??
          Math.max(0, history.total - 600),
      );
  }, [activeTabId, history, messages.length]);

  const rememberPosition = () => {
    if (!userScrolled.current) return;
    if (atBottom.current) {
      readingPositions.delete(positionKey);
      return;
    }
    const viewport = scrollerRef.current;
    if (!viewport) return;
    const top = viewport.getBoundingClientRect().top;
    const item = [
      ...viewport.querySelectorAll<HTMLElement>("[data-message-index]"),
    ].find(
      (row) =>
        row.getBoundingClientRect().bottom > top &&
        row.getBoundingClientRect().top < top + viewport.clientHeight,
    );
    if (item)
      readingPositions.set(positionKey, {
        start: history?.start ?? 0,
        anchor: Number(item.dataset.messageIndex),
        offset: item.getBoundingClientRect().top - top,
      });
  };

  // Build a map of tool_use_id → tool_result for inline display
  const toolResultMap = useMemo(() => {
    const map = new Map<string, ContentBlock>();
    for (const msg of messages) {
      if (msg.type === "user" && Array.isArray(msg.message?.content)) {
        for (const block of msg.message.content) {
          if (block.type === "tool_result" && block.tool_use_id) {
            map.set(block.tool_use_id, block);
          }
        }
      }
    }
    return map;
  }, [messages]);

  // Filter displayable messages
  const displayMessages = useMemo(() => {
    const sectionLabels = chatModelSectionLabels(messages, history?.start ?? 0);
    // Collect all assistant text for dedup against result
    const assistantTexts = new Set<string>();
    for (const msg of messages) {
      if (msg.type === "assistant" && Array.isArray(msg.message?.content)) {
        for (const block of msg.message.content) {
          if (block.type === "text" && block.text) {
            assistantTexts.add(block.text.trim());
          }
        }
      }
    }

    return messages
      .map((message, messageIndex) => ({
        message,
        messageIndex: messageIndex + (history?.start ?? 0),
        sectionLabel: sectionLabels[messageIndex],
      }))
      .filter(({ message: msg }) => {
        if (msg.type === "system" && msg.subtype === "init") return false;
        if (
          msg.type !== "user" &&
          msg.type !== "assistant" &&
          msg.type !== "result"
        )
          return false;
        if (msg.type === "user" && msg.message?.content) {
          if (Array.isArray(msg.message.content)) {
            const hasOnlyToolResults = msg.message.content.every(
              (b: any) => b.type === "tool_result",
            );
            if (hasOnlyToolResults) return false;
          }
        }
        if (msg.type === "result" && msg.result) {
          if (assistantTexts.has(msg.result.trim())) return false;
        }
        return true;
      });
  }, [messages, history?.start]);

  const initialPosition = useMemo(
    () => ({
      index: readingPositions.has(positionKey)
        ? Math.max(
            0,
            displayMessages.findIndex(
              (row) =>
                row.messageIndex === readingPositions.get(positionKey)?.anchor,
            ),
          )
        : displayMessages.length - 1,
      align: readingPositions.has(positionKey)
        ? ("start" as const)
        : ("end" as const),
      offset: -(readingPositions.get(positionKey)?.offset ?? 0),
    }),
    [activeTabId, displayMessages.length === 0],
  );
  useLayoutEffect(() => {
    const anchor = pendingAnchor.current;
    if (!anchor) return;
    const index = displayMessages.findIndex(
      (row) => row.messageIndex === anchor.index,
    );
    if (index < 0) return;
    pendingAnchor.current = null;
    listRef.current?.scrollToIndex({
      index,
      align: "start",
      offset: -anchor.offset,
      behavior: "auto",
    });
  }, [messages]);

  const observerRef = useRef<ResizeObserver | null>(null);
  const attachScroller = useCallback(
    (element: HTMLElement | Window | null) => {
      observerRef.current?.disconnect();
      scrollerRef.current = element instanceof HTMLElement ? element : null;
      const viewport = scrollerRef.current;
      if (!viewport) return;
      const keepBottom = () => {
        if (!userScrolled.current && !readingPositions.has(positionKey))
          viewport.scrollTop = viewport.scrollHeight;
      };
      const observer = new ResizeObserver(keepBottom);
      observerRef.current = observer;
      observer.observe(viewport);
      const items = viewport.querySelector(
        '[data-testid="virtuoso-item-list"]',
      );
      if (items) observer.observe(items);
      keepBottom();
    },
    [positionKey],
  );

  if (loadError)
    return (
      <div className="p-4 text-destructive text-sm">
        Could not load chat history: {loadError}
        <button
          type="button"
          className="ml-2 underline"
          onClick={() =>
            void loadWindow(Math.max(0, (history?.total ?? 0) - 600))
          }
        >
          Retry
        </button>
      </div>
    );
  if (displayMessages.length === 0 && !isStreaming)
    return (
      <div className="app-scrollbar flex h-full flex-col items-center overflow-y-auto p-4">
        {history?.total ? (
          <span className="text-muted-foreground text-sm">Loading chat…</span>
        ) : null}
      </div>
    );
  return (
    <Virtuoso
      key={activeTabId}
      ref={listRef}
      scrollerRef={attachScroller}
      // Override Virtuoso's percentage height: Half's intrinsic drawer height
      // does not provide a definite percentage basis for this flex child.
      style={{ position: "absolute", inset: 0, height: "auto" }}
      className={`app-scrollbar absolute inset-0 overflow-y-auto ${
        revealHistory === undefined
          ? ""
          : revealHistory && historyReady
            ? "animate-[drawer-opacity-reveal_200ms_ease-out_both] motion-reduce:animate-none"
            : "opacity-0"
      }`}
      itemsRendered={
        revealHistory === undefined ? undefined : revealRenderedHistory
      }
      data={displayMessages}
      computeItemKey={(_, row) =>
        row.message.uuid ?? `${row.message.type}-${row.messageIndex}`
      }
      initialTopMostItemIndex={initialPosition}
      onWheel={(event) => {
        userScrolled.current = true;
        scrollDirection.current = event.deltaY < 0 ? "up" : "down";
        if (event.deltaY < 0) atBottom.current = false;
      }}
      onScroll={(event) => {
        const viewport = event.currentTarget;
        requestAnimationFrame(rememberPosition);
        if (userScrolled.current && scrollDirection.current === null)
          scrollDirection.current =
            viewport.scrollTop < previousScrollTop.current ? "up" : "down";
        previousScrollTop.current = viewport.scrollTop;
        if (
          scrollDirection.current === "down" &&
          viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <
            50 &&
          (!history || history.start + messages.length === history.total)
        ) {
          userScrolled.current = false;
          atBottom.current = true;
          readingPositions.delete(positionKey);
        }
        if (!userScrolled.current || !history) return;
        if (
          scrollDirection.current !== "down" &&
          viewport.scrollTop < 50 &&
          history.start > 0
        )
          void loadWindow(Math.max(0, history.start - 200));
        else if (
          scrollDirection.current !== "up" &&
          viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <
            50 &&
          history.start + messages.length < history.total
        )
          void loadWindow(
            Math.max(0, Math.min(history.total - 600, history.start + 200)),
          );
      }}
      onKeyDown={(event) => {
        if (
          [
            "ArrowUp",
            "PageUp",
            "Home",
            "ArrowDown",
            "PageDown",
            "End",
          ].includes(event.key)
        ) {
          userScrolled.current = true;
          scrollDirection.current = ["ArrowUp", "PageUp", "Home"].includes(
            event.key,
          )
            ? "up"
            : "down";
        }
      }}
      onTouchMove={() => {
        scrollDirection.current = null;
        userScrolled.current = true;
      }}
      onPointerDown={() => {
        scrollDirection.current = null;
        userScrolled.current = true;
      }}
      rangeChanged={() => {
        requestAnimationFrame(rememberPosition);
      }}
      alignToBottom
      increaseViewportBy={300}
      atBottomThreshold={50}
      atBottomStateChange={(value) => {
        atBottom.current =
          value &&
          (!history || history.start + messages.length === history.total);
      }}
      followOutput={() => (!userScrolled.current ? "auto" : false)}
      components={{
        Footer: () => (
          <>
            {(isStreaming || isPaused || isWaiting) && (
              <div className="px-4">
                <StreamingIndicator />
              </div>
            )}
            {reservePromptSpace && (
              <div
                data-prompt-scroll-clearance
                aria-hidden="true"
                className="h-9"
              />
            )}
          </>
        ),
      }}
      itemContent={(logicalIndex, { message, messageIndex, sectionLabel }) => {
        const index = logicalIndex;
        const nextMessage = displayMessages[index + 1]?.message;
        const hasAnswerContent =
          message.type === "result"
            ? Boolean(
                message.result &&
                  !message.is_error &&
                  message.subtype !== "error",
              )
            : message.type === "assistant"
              ? (message.message?.content ?? []).some(
                  (block) =>
                    (block.type === "text" && Boolean(block.text)) ||
                    (block.type === "image" && Boolean(block.imageDataUrl)),
                )
              : false;
        const endsAssistantResponse =
          hasAnswerContent &&
          (nextMessage?.type === "user" || nextMessage === undefined) &&
          (!isStreaming || nextMessage !== undefined);

        return (
          <div className="px-4" data-message-index={messageIndex}>
            {sectionLabel && (
              <div
                data-chat-model-divider=""
                role="separator"
                aria-label={sectionLabel}
                className="mt-2 mb-4 flex items-center gap-3 text-muted-foreground text-xs"
              >
                <Separator className="min-w-4 flex-1 data-[orientation=horizontal]:w-auto" />
                <span className="min-w-0 truncate" title={sectionLabel}>
                  {sectionLabel}
                </span>
                <Separator className="min-w-4 flex-1 data-[orientation=horizontal]:w-auto" />
              </div>
            )}
            <MessageBubble
              key={message.uuid ?? `${message.type}-${messageIndex}`}
              message={message}
              stateKey={`${positionKey}:${messageIndex}`}
              toolResultMap={toolResultMap}
              onFork={
                endsAssistantResponse
                  ? () => {
                      void forkSessionAtMessage(messageIndex).catch((error) =>
                        setLoadError(String(error)),
                      );
                    }
                  : undefined
              }
            />
          </div>
        );
      }}
    />
  );
};

// ─── Message Bubble ───

const MessageBubble: FC<{
  stateKey: string;
  message: AgentStreamMessage;
  toolResultMap: Map<string, ContentBlock>;
  onFork?: () => void;
}> = memo(({ message, toolResultMap, onFork, stateKey }) => {
  if (message.type === "user") {
    return <UserMessage message={message} />;
  }
  if (message.type === "assistant") {
    return (
      <AssistantMessage
        message={message}
        stateKey={stateKey}
        toolResultMap={toolResultMap}
        onFork={onFork}
      />
    );
  }
  if (message.type === "result") {
    return <ResultMessage message={message} onFork={onFork} />;
  }
  return null;
});

// ─── User Message ───

const sentTimeFormat = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

const sentTimeWithoutYearFormat = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

function formatMessageDateTime(date: Date) {
  return (
    date.getFullYear() === new Date().getFullYear()
      ? sentTimeWithoutYearFormat
      : sentTimeFormat
  ).format(date);
}

const UserMessageActions: FC<{ sentAt?: number; rawText: string }> = ({
  sentAt,
  rawText,
}) => {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
    "idle",
  );
  useEffect(() => {
    if (copyState === "idle") return;
    const timer = window.setTimeout(() => setCopyState("idle"), 2000);
    return () => clearTimeout(timer);
  }, [copyState]);
  const date = sentAt == null ? null : new Date(sentAt);
  const hasDate = date !== null && Number.isFinite(date.getTime());
  if (!hasDate && !rawText) return null;
  const copyLabel =
    copyState === "copied"
      ? "Copied"
      : copyState === "failed"
        ? "Copy failed — try again"
        : "Copy user message";
  return (
    <div
      className="flex min-h-7 items-center justify-end gap-1 px-1 text-muted-foreground text-xs opacity-0 transition-opacity duration-150 ease-in-out group-focus-within/user-message:opacity-100 group-hover/user-message:opacity-100 motion-reduce:transition-none"
      data-testid="user-message-actions"
    >
      {hasDate && (
        <time dateTime={date.toISOString()} title="Message sent (local time)">
          {formatMessageDateTime(date)}
        </time>
      )}
      {rawText && (
        <TooltipIconButton
          type="button"
          tooltip={copyLabel}
          aria-label={copyLabel}
          side="top"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(rawText);
              setCopyState("copied");
            } catch {
              setCopyState("failed");
            }
          }}
          className="size-7 rounded-lg text-muted-foreground/70 hover:bg-muted hover:text-foreground"
        >
          {copyState === "copied" ? (
            <CheckIcon className="size-3.5" aria-hidden="true" />
          ) : (
            <CopyIcon className="size-3.5" aria-hidden="true" />
          )}
        </TooltipIconButton>
      )}
    </div>
  );
};

const UserMessage: FC<{ message: AgentStreamMessage }> = ({ message }) => {
  const rawContent = message.message?.content;
  const textContent = Array.isArray(rawContent)
    ? rawContent
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n")
    : typeof rawContent === "string"
      ? rawContent
      : "";
  const imageBlocks = Array.isArray(rawContent)
    ? rawContent.filter(
        (b): b is ContentBlock & { imageDataUrl: string } =>
          b.type === "image" && Boolean(b.imageDataUrl),
      )
    : [];

  if (!textContent && imageBlocks.length === 0) return null;

  // Parse leading @file:line:col or ~@file:line context reference
  const contextMatch = textContent.match(/^(~?@[^\n]+)\n([\s\S]*)$/);
  const contextLabel = contextMatch?.[1] ?? null;
  const bodyText = contextMatch ? contextMatch[2] : textContent;

  // Parse error block patterns for styled rendering:
  // Lint single: "[Lint error in FILE:LINE]\n[Error: MSG]\n\nPrompt"
  // Lint multi:  "[Lint errors in FILE]\n- FILE:LINE — MSG\n...\n\nPrompt"
  // Compile:     "[Compilation errors]\n- error1\n- error2\n...\n\nPrompt"
  const lintSingleMatch = bodyText.match(
    /^\[Lint error in ([^\]]+)\]\n\[Error: ([^\]]+)\]\n\n([\s\S]*)$/,
  );
  const lintMultiMatch = bodyText.match(
    /^\[Lint errors in ([^\]]+)\]\n((?:- .+\n?)+)\n([\s\S]*)$/,
  );
  const compileErrorMatch = bodyText.match(
    /^\[Compilation errors\]\n((?:- .+\n?)+)\n([\s\S]*)$/,
  );

  // Shared error block renderer
  const renderErrorBlock = (
    title: string,
    errors: { message: string; location?: string }[],
    prompt: string,
  ) => (
    <div className="flex w-full flex-col items-end py-1.5">
      <div className="group/user-message flex max-w-[85%] flex-col items-end">
        <div className="rounded-xl bg-muted px-3 py-2 text-foreground text-sm">
          <div className="mb-2 rounded-lg border border-red-500/20 bg-red-500/10 px-2.5 py-2">
            <div className="mb-1.5 font-medium text-red-400 text-xs">
              {title}
            </div>
            <div className="space-y-1">
              {errors.map((e, i) => (
                <div key={i} className="flex items-start gap-1.5">
                  <AlertCircleIcon className="mt-0.5 size-3 shrink-0 text-red-400/70" />
                  <span className="flex-1 text-foreground/80 text-xs">
                    {e.message}
                  </span>
                  {e.location && (
                    <span className="shrink-0 font-mono text-muted-foreground text-xs">
                      {e.location}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
          <span className="text-muted-foreground">{prompt}</span>
        </div>
        <UserMessageActions sentAt={message.sentAt} rawText={textContent} />
      </div>
    </div>
  );

  if (lintSingleMatch) {
    const [, location, errorMsg, prompt] = lintSingleMatch;
    return renderErrorBlock(
      `Lint Error`,
      [{ message: errorMsg, location }],
      prompt,
    );
  }

  if (lintMultiMatch) {
    const [, fileName, errorLines, prompt] = lintMultiMatch;
    const errors = errorLines
      .trim()
      .split("\n")
      .map((line) => {
        const m = line.match(/^- (.+?):(\d+) — (.+)$/);
        return m
          ? { message: m[3], location: `${m[1]}:${m[2]}` }
          : { message: line.replace(/^- /, "") };
      });
    return renderErrorBlock(`Lint Errors — ${fileName}`, errors, prompt);
  }

  if (compileErrorMatch) {
    const [, errorLines, prompt] = compileErrorMatch;
    const errors = errorLines
      .trim()
      .split("\n")
      .map((line) => ({
        message: line.replace(/^- /, ""),
      }));
    return renderErrorBlock(
      `Compilation ${errors.length === 1 ? "Error" : "Errors"}`,
      errors,
      prompt,
    );
  }

  return (
    <div className="flex w-full flex-col items-end py-1.5">
      <div className="group/user-message flex max-w-[85%] flex-col items-end">
        <div className="rounded-xl bg-muted px-3 py-1.5 text-foreground text-sm">
          {imageBlocks.length > 0 && (
            <div className="mb-2 flex flex-wrap justify-end gap-2">
              {imageBlocks.map((block, index) => (
                <ChatImagePreview
                  key={`${block.imageDataUrl}-${index}`}
                  src={block.imageDataUrl}
                  alt={block.alt ?? "Attached image"}
                  sourcePath={block.imageFilePath}
                  thumbnailClassName="max-h-48"
                />
              ))}
            </div>
          )}
          {contextLabel && (
            <span className="mb-1 inline-flex items-center rounded-md bg-background/60 px-1.5 py-0.5 font-mono text-muted-foreground text-xs">
              {contextLabel}
            </span>
          )}
          {contextLabel && bodyText && <br />}
          <MarkdownRenderer
            content={bodyText}
            className="chat-markdown [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
          />
        </div>
        <UserMessageActions sentAt={message.sentAt} rawText={textContent} />
      </div>
    </div>
  );
};

// ─── Assistant Message ───

const AssistantMessage: FC<{
  stateKey: string;
  message: AgentStreamMessage;
  toolResultMap: Map<string, ContentBlock>;
  onFork?: () => void;
}> = ({ message, toolResultMap, onFork, stateKey }) => {
  const content = message.message?.content;
  if (!Array.isArray(content) || content.length === 0) return null;

  const hasRenderableContent = content.some(
    (block) =>
      (block.type === "text" && block.text) ||
      (block.type === "image" && block.imageDataUrl) ||
      (block.type === "thinking" && block.thinking) ||
      (block.type === "tool_use" && block.id),
  );

  if (!hasRenderableContent) return null;

  return (
    <div className="w-full py-1.5">
      <div className="px-1 text-foreground text-sm leading-relaxed">
        {content.map((block, idx) => {
          if (block.type === "thinking" && block.thinking) {
            return (
              <ThinkingWidget
                key={idx}
                stateKey={`${stateKey}:${idx}`}
                thinking={block.thinking}
                signature={block.signature}
              />
            );
          }
          if (block.type === "text" && block.text) {
            return (
              <MarkdownRenderer
                key={idx}
                content={block.text}
                className="chat-markdown"
              />
            );
          }
          if (block.type === "image" && block.imageDataUrl) {
            return (
              <ChatImagePreview
                key={idx}
                src={block.imageDataUrl}
                alt={block.alt ?? "Generated image"}
                sourcePath={block.imageFilePath}
                thumbnailClassName="my-2 max-h-80"
              />
            );
          }
          if (block.type === "tool_use" && block.id) {
            const result = toolResultMap.get(block.id);
            return (
              <ToolWidget
                key={idx}
                stateKey={`${stateKey}:${idx}`}
                toolUse={block}
                toolResult={result}
              />
            );
          }
          return null;
        })}
      </div>
      <ResponseActions
        onFork={onFork}
        durationMs={message.roundDurationMs}
        completedAt={message.roundCompletedAt}
        rawText={content
          .filter((block) => block.type === "text")
          .map((block) => block.text ?? "")
          .join("\n\n")}
      />
    </div>
  );
};

// ─── Result Message ───

const ResultMessage: FC<{
  message: AgentStreamMessage;
  onFork?: () => void;
}> = ({ message, onFork }) => {
  const isError = message.is_error || message.subtype === "error";
  const resultText = message.errors?.length
    ? message.errors.join("\n")
    : message.result;

  if (!resultText) return null;

  return (
    <div className="w-full py-1.5">
      <div className="px-1 text-foreground text-sm leading-relaxed">
        {isError ? (
          <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-destructive text-sm">
            {resultText}
          </div>
        ) : (
          <MarkdownRenderer content={resultText} className="chat-markdown" />
        )}
      </div>
      {message.cost_usd != null && (
        <div className="mt-1 px-1 text-right text-muted-foreground text-xs">
          Cost: ${message.cost_usd.toFixed(4)}
        </div>
      )}
      <ResponseActions
        onFork={onFork}
        rawText={resultText}
        durationMs={message.roundDurationMs}
        completedAt={message.roundCompletedAt}
      />
    </div>
  );
};

const ResponseActions: FC<{
  onFork?: () => void;
  rawText: string;
  durationMs?: number;
  completedAt?: number;
}> = ({ onFork, rawText, durationMs, completedAt }) => {
  const showCompletionTime = useSettingsStore(
    (state) => state.showAnswerCompletionTime,
  );
  const toggleAnswerTimeDisplay = useSettingsStore(
    (state) => state.toggleAnswerTimeDisplay,
  );
  const completionDate = completedAt == null ? null : new Date(completedAt);
  const hasCompletionTime =
    completionDate !== null && Number.isFinite(completionDate.getTime());
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
    "idle",
  );
  useEffect(() => {
    if (copyState === "idle") return;
    const timer = window.setTimeout(() => setCopyState("idle"), 2000);
    return () => window.clearTimeout(timer);
  }, [copyState]);
  if (!onFork) return null;
  const copyLabel =
    copyState === "copied"
      ? "Copied"
      : copyState === "failed"
        ? "Copy failed — try again"
        : "Copy raw response";

  return (
    <div className="flex items-center px-0.5 pt-0.5">
      {rawText && (
        <TooltipIconButton
          type="button"
          tooltip={copyLabel}
          aria-label={copyLabel}
          side="top"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(rawText);
              setCopyState("copied");
            } catch {
              setCopyState("failed");
            }
          }}
          className="size-7 rounded-lg text-muted-foreground/70 hover:bg-muted hover:text-foreground"
        >
          {copyState === "copied" ? (
            <CheckIcon className="size-3.5" aria-hidden="true" />
          ) : (
            <CopyIcon className="size-3.5" aria-hidden="true" />
          )}
        </TooltipIconButton>
      )}
      <TooltipIconButton
        type="button"
        tooltip="Fork from this response"
        side="top"
        aria-label="Fork from this response"
        data-testid="fork-response-action"
        onClick={onFork}
        className="size-7 rounded-lg text-muted-foreground/70 hover:bg-muted hover:text-foreground"
      >
        <GitForkIcon className="size-3.5" aria-hidden="true" />
      </TooltipIconButton>
      {durationMs != null && (
        <button
          type="button"
          className="ml-1 min-h-7 rounded px-1 text-muted-foreground text-xs hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none"
          title={
            hasCompletionTime
              ? showCompletionTime
                ? "Show active working time"
                : "Show stop date and time (local time)"
              : "Active working time; stop date was not recorded"
          }
          data-testid="round-duration"
          disabled={!hasCompletionTime}
          aria-pressed={showCompletionTime}
          onClick={toggleAnswerTimeDisplay}
        >
          {showCompletionTime && hasCompletionTime ? (
            <time dateTime={completionDate.toISOString()}>
              {formatMessageDateTime(completionDate)}
            </time>
          ) : (
            `Worked for: ${formatRoundDuration(durationMs)}`
          )}
        </button>
      )}
    </div>
  );
};
