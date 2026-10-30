import {
  HARNESSES,
  harnessCommand,
  normalizeProvider,
  restoreProviderState,
  disposeHarnesses,
} from "@/lib/agent-harness";
import { isChatArchiveEligible } from "@/lib/chat-archive-eligibility";
import { findPiModel, resolvePiThinkingLevel } from "@/lib/pi-models";
import { piConfigFromSettings, usePiSetupStore } from "./pi-setup-store";
import { retireAgentDraft } from "@/lib/retire-agent-draft";
import {
  type AgentRoundTiming,
  freezeRound,
  stampRoundDuration,
} from "@/lib/agent-round-timing";
import {
  handoffMessageCount,
  buildCrossProviderTranscript,
} from "../../chat-transcript";
import {
  chatContextItems,
  type ChatContextBadge,
  type ChatPromptContext,
} from "@/lib/chat-context";
import { formatChatPrompt } from "@/lib/chat-prompt";
import { SHARED_SESSION_SAVED_EVENT } from "@/lib/workspace-events";
import { mergeClaudeModels } from "@/lib/custom-models";
import { useClaudeSetupStore } from "@/stores/claude-setup-store";
import {
  normalizeClaudeModelId,
  findClaudeModel,
  claudeModelEfforts,
} from "@/lib/claude-models";
import { create } from "zustand";
import {
  readAgentContextUsage,
  type AgentContextUsage,
} from "@/lib/agent-context-usage";
import { invoke } from "@/lib/desktop/core";
import { useDocumentStore } from "./document-store";
import type { AgentQuestion, SavedAgentQuestion } from "./agent-question-store";
import {
  type ChatProvider,
  type ClaudeEffortLevel,
  type ClaudeModelId,
  type CompilerBackend,
  type ConcreteCompilerEngine,
  type AgentExecutionMode,
  type CodexModelId,
  type CodexReasoningEffort,
  useSettingsStore,
} from "./settings-store";
import { createLogger } from "@/lib/debug/logger";
import {
  detectTexEngineFromContent,
  resolveCompileTarget,
} from "@/lib/latex-compiler";
import { getAssetUrl } from "@/lib/project-files";
import {
  type AgentWorkspaceSession,
  prepareAgentWorkspace,
  reconcileAgentWorkspace,
} from "@/lib/agent-workspace";

const log = createLogger("agent-chat");

/** Convert a character offset to 1-based line:col */
export function offsetToLineCol(
  content: string,
  offset: number,
): { line: number; col: number } {
  const before = content.slice(0, offset);
  const lines = before.split("\n");
  return { line: lines.length, col: lines[lines.length - 1].length + 1 };
}

// ─── Types ───

export interface ContentBlock {
  type: "text" | "tool_use" | "tool_result" | "thinking" | "image";
  // text block
  text?: string;
  // image block
  imageDataUrl?: string;
  imageFilePath?: string;
  alt?: string;
  // tool_use block
  id?: string;
  name?: string;
  input?: any;
  // tool_result block
  tool_use_id?: string;
  content?: any;
  is_error?: boolean;
  // thinking block
  thinking?: string;
  signature?: string;
}

export interface AgentActivity {
  kind:
    | "text_delta"
    | "text_replace"
    | "thinking_delta"
    | "thinking_replace"
    | "tool_started"
    | "tool_completed";
  id: string;
  text?: string;
  name?: string;
  input?: unknown;
  content?: unknown;
  isError?: boolean;
}

export interface AgentStreamMessage {
  /** Unix milliseconds captured when the user submits this message. */
  sentAt?: number;
  type: "system" | "assistant" | "user" | "result";
  provider?: ChatProvider;
  uuid?: string;
  subtype?: string;
  session_id?: string;
  model?: string;
  cwd?: string;
  tools?: string[];
  message?: {
    content?: ContentBlock[];
    usage?: { input_tokens: number; output_tokens: number };
  };
  usage?: { input_tokens: number; output_tokens: number };
  cost_usd?: number;
  /** App-measured active time for the completed prompt, excluding pauses. */
  roundDurationMs?: number;
  /** Unix milliseconds when this round completed. */
  roundCompletedAt?: number;
  duration_ms?: number;
  duration_api_ms?: number;
  result?: string;
  is_error?: boolean;
  errors?: string[];
  error?: string;
  num_turns?: number;
}

export type {
  ChatProvider,
  ClaudeEffortLevel,
  ClaudeModelId,
  AgentExecutionMode,
  CodexModelId,
  CodexReasoningEffort,
} from "./settings-store";
export type ProviderSessionIds = Partial<Record<ChatProvider, string>>;
export type ProviderSyncCursors = Partial<Record<ChatProvider, number>>;

function getDefaultProvider(): ChatProvider {
  const { defaultAgent, enabledProviders } = useSettingsStore.getState();
  return enabledProviders[defaultAgent]
    ? defaultAgent
    : enabledProviders.claude
      ? "claude"
      : enabledProviders.codex
        ? "codex"
        : enabledProviders.pi
          ? "pi"
          : defaultAgent;
}

function getAgentDefaults() {
  const settings = useSettingsStore.getState();
  const executionMode = settings.defaultAgentExecutionMode;

  return {
    selectedProvider: getDefaultProvider(),
    selectedClaudeModel: settings.defaultClaudeModel,
    selectedClaudeExecutionMode: executionMode,
    selectedPiModel: settings.defaultPiModel,
    selectedPiReasoningEffort: settings.defaultPiReasoningEffort,
    selectedPiExecutionMode: executionMode,
    selectedCodexModel: settings.defaultCodexModel,
    selectedCodexReasoningEffort: settings.defaultCodexReasoningEffort,
    selectedCodexExecutionMode: executionMode,
    effortLevel: settings.defaultClaudeEffortLevel,
  };
}

export interface ResumeSessionOptions {
  sessionProvider?: ChatProvider;
  sessionClaudeModel?: ClaudeModelId | null;
  sessionCodexModel?: CodexModelId | null;
  sessionPiModel?: string | null;
  useSessionLlm?: boolean;
}

export interface PendingResumeChoice {
  sharedSessionId: string;
  sessionProvider: ChatProvider;
  sessionClaudeModel: ClaudeModelId | null;
  sessionCodexModel: CodexModelId | null;
  sessionPiModel?: string | null;
}

export interface SharedSessionPayload {
  shared_session_id: string;
  title: string;
  last_modified: number;
  last_provider: string;
  last_claude_model?: string | null;
  last_codex_model?: string | null;
  last_pi_model?: string | null;
  provider_session_ids?: Record<string, string>;
  provider_sync_cursors?: Record<string, number> | null;
  messages: AgentStreamMessage[];
  pending_question?: SavedAgentQuestion | null;
}

interface SaveSharedSessionResult {
  shared_session_id: string;
  last_modified: number;
}

// ─── Tab Types ───

export interface TabDraft {
  input: string;
  pinnedContexts: ChatContextBadge[];
}

export interface QueuedChatPrompt {
  provider?: ChatProvider;
  id: string;
  prompt: string;
  context: ChatContextBadge[];
}

const dispatchingPromptQueues = new Set<string>();
let queuedPromptCounter = 0;

function getCurrentSelectionDraftContext():
  | TabDraft["pinnedContexts"][number]
  | null {
  const docState = useDocumentStore.getState();
  if (docState.pdfSelectionContext) return docState.pdfSelectionContext;
  const selectionRange = docState.selectionRange;
  if (!selectionRange) return null;

  const activeFile = docState.files.find(
    (file) => file.id === docState.activeFileId,
  );
  if (!activeFile?.content) return null;

  const start = Math.max(
    0,
    Math.min(selectionRange.start, activeFile.content.length),
  );
  const end = Math.max(
    start,
    Math.min(selectionRange.end, activeFile.content.length),
  );
  if (start === end) return null;

  const startLC = offsetToLineCol(activeFile.content, start);
  const endLC = offsetToLineCol(activeFile.content, end);
  return {
    label: `@${activeFile.relativePath}:${startLC.line}:${startLC.col}-${endLC.line}:${endLC.col}`,
    filePath: activeFile.relativePath,
    selectedText: activeFile.content.slice(start, end),
  };
}

function getPinnedSelectionContext(
  contexts: TabDraft["pinnedContexts"],
): TabDraft["pinnedContexts"][number] | null {
  return (
    contexts.find(
      (context) =>
        /^(?:PDF p\.\d+ · )?@.+:\d+:\d+-\d+:\d+(?: · PDF p\.\d+)?$/.test(
          context.label,
        ) || /^PDF (?:p\.\d+ · “.*”|· p\. \d+)$/.test(context.label),
    ) ?? null
  );
}

export interface TabState {
  compacting?: boolean;
  contextUsage?: Partial<Record<ChatProvider, AgentContextUsage>>;
  providerStatus?: string | null;
  roundTiming?: AgentRoundTiming | null;
  pendingReviewDecisions?: AgentStreamMessage[];
  /** A read-only window onto persisted messages; hydrate before agent mutations. */
  history?: {
    total: number;
    start: number;
    writable?: boolean;
    prefixCount?: number;
    latestReview?: AgentStreamMessage | null;
    transcript?: string;
  };
  /** Unix seconds of actual conversation activity; restoration never advances it. */
  lastActivityAt?: number;
  archived?: boolean;
  selectedClaudeExecutionMode?: AgentExecutionMode;
  selectedCodexExecutionMode?: AgentExecutionMode;
  selectedPiExecutionMode?: AgentExecutionMode;
  id: string;
  runtimeSessionKey: string;
  title: string;
  provider: ChatProvider;
  sessionId: string | null;
  sharedSessionId: string | null;
  providerSessionIds: ProviderSessionIds;
  providerSyncCursors: ProviderSyncCursors;
  pendingCrossProviderTranscript: string | null;
  messages: AgentStreamMessage[];
  pendingQuestion?: SavedAgentQuestion | null;
  isStreaming: boolean;
  error: string | null;
  totalInputTokens: number;
  totalOutputTokens: number;
  draft: TabDraft;
  queuedPrompts?: QueuedChatPrompt[];
  promptQueuePaused?: boolean;
  dispatchingQueuedPromptId?: string | null;
  pendingResumeChoice: PendingResumeChoice | null;
  pendingFileBaseline: Record<string, string> | null;
  pendingClaudeExecutionMode: AgentExecutionMode | null;
  agentWorkspace?: AgentWorkspaceSession | null;
  cancelledByUser?: boolean;
  isSettling?: boolean;
  pauseState?: "pausing" | "paused" | null;
  turnPhase?: "preparing" | "starting" | "running" | null;
  /** Original input retained for recovery; never consumes the current composer draft. */
  retryRequest?: {
    prompt: string;
    context: ChatPromptContext;
    provider: ChatProvider;
  } | null;
  /** Retain the original request if paused before it reached the provider. */
  pausedRequest?: {
    prompt: string;
    context?: ChatPromptContext;
  } | null;
  agentVerificationContext?: {
    rootId: string;
    targetPath: string;
    backend: CompilerBackend;
    engine: ConcreteCompilerEngine;
    autoEngine?: boolean;
  } | null;
}

/** Fields that are projected from the active tab to top-level state */
function permissionDefaults() {
  const defaults = getAgentDefaults();
  return {
    selectedClaudeExecutionMode: defaults.selectedClaudeExecutionMode,
    selectedCodexExecutionMode: defaults.selectedCodexExecutionMode,
    selectedPiExecutionMode: defaults.selectedPiExecutionMode,
  };
}

function tabPermissions(tab: TabState, state: AgentChatState) {
  return {
    selectedClaudeExecutionMode:
      tab.selectedClaudeExecutionMode ?? state.selectedClaudeExecutionMode,
    selectedCodexExecutionMode:
      tab.selectedCodexExecutionMode ?? state.selectedCodexExecutionMode,
    selectedPiExecutionMode:
      tab.selectedPiExecutionMode ?? state.selectedPiExecutionMode,
  };
}

function makeDefaultTab(
  id: string,
  provider: ChatProvider = getDefaultProvider(),
): TabState {
  return {
    id,
    runtimeSessionKey: nextRuntimeSessionKey(),
    pauseState: null,
    turnPhase: null,
    pausedRequest: null,
    title: "New Chat",
    ...permissionDefaults(),
    provider,
    sessionId: null,
    sharedSessionId: null,
    providerSessionIds: {},
    providerSyncCursors: {},
    pendingCrossProviderTranscript: null,
    messages: [],
    isStreaming: false,
    error: null,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    draft: { input: "", pinnedContexts: [] },
    pendingResumeChoice: null,
    pendingFileBaseline: null,
    pendingClaudeExecutionMode: null,
    agentWorkspace: null,
    cancelledByUser: false,
    agentVerificationContext: null,
  };
}

let tabCounter = 0;
let runtimeSessionCounter = 0;
function nextTabId(): string {
  return `tab-${Date.now()}-${++tabCounter}`;
}

function nextRuntimeSessionKey(): string {
  return `runtime-session-${Date.now()}-${++runtimeSessionCounter}`;
}

let documentWorkspaceViewRequest = 0;
let documentWorkspaceViewTail: Promise<void> = Promise.resolve();

function showDocumentWorkspaceForTab(tab: TabState): Promise<void> {
  const request = ++documentWorkspaceViewRequest;
  const view = documentWorkspaceViewTail
    .catch(() => {})
    .then(async () => {
      if (request !== documentWorkspaceViewRequest) return;
      await updateDocumentWorkspaceForTab(tab);
    });
  documentWorkspaceViewTail = view;
  void view.catch((error) =>
    useAgentChatStore
      .getState()
      ._setError(tab.id, `Could not open draft: ${String(error)}`),
  );
  return view;
}

async function updateDocumentWorkspaceForTab(tab: TabState): Promise<void> {
  const documentStore = useDocumentStore.getState();
  const { useAgentReviewQueueStore } = await import(
    "./agent-review-queue-store"
  );
  const queue = useAgentReviewQueueStore.getState();
  // The editor belongs to the project review queue, independently of chat focus.
  const head = queue.entries.find(
    (entry) => entry.session.projectRoot === documentStore.projectRoot,
  );
  if (head?.phase === "review") {
    if (documentStore.agentWorkspaceSessionId !== head.session.sessionId)
      await queue.show(head.session.sessionId);
    return;
  }
  if (head?.phase === "applying" || head?.phase === "revising") return;
  if (
    tab.agentWorkspace &&
    tab.agentWorkspace.status !== "active" &&
    !queue.entries.some(
      (entry) => entry.session.sessionId === tab.agentWorkspace?.sessionId,
    )
  ) {
    await queue.enqueue(tab.agentWorkspace);
  }
}

/**
 * Update a specific tab in `tabs[]` and, if that tab is the active tab,
 * also project the changed fields to top-level state for consumer compatibility.
 */
function applyTabUpdate(
  state: AgentChatState,
  tabId: string,
  updates: Partial<TabState>,
): Partial<AgentChatState> {
  const old = state.tabs.find((tab) => tab.id === tabId);
  if (
    "isStreaming" in updates ||
    updates.isSettling ||
    updates.pauseState ||
    updates.cancelledByUser ||
    updates.error ||
    (updates.provider !== undefined && updates.provider !== old?.provider)
  )
    updates = { ...updates, providerStatus: null };
  if (updates.error) updates = { ...updates, promptQueuePaused: true };
  if (
    updates.isStreaming === false &&
    old?.roundTiming &&
    !old.roundTiming.finished &&
    !("roundTiming" in updates)
  ) {
    const stoppedAt = Date.now();
    const timing = freezeRound(old.roundTiming, stoppedAt);
    updates = {
      ...updates,
      roundTiming: { ...timing, finished: true },
      messages: stampRoundDuration(
        updates.messages ?? old.messages,
        timing.startIndex - (old.history?.start ?? 0),
        timing.elapsedMs,
        stoppedAt,
      ),
    };
  }
  if (updates.messages && old?.history?.writable && !("history" in updates))
    updates = {
      ...updates,
      history: {
        ...old.history,
        total: old.history.start + updates.messages.length,
      },
    };
  let newTabs = state.tabs.map((t) =>
    t.id === tabId ? { ...t, ...updates } : t,
  );
  const previous = state.tabs.find((tab) => tab.id === tabId);
  const updated = newTabs.find((tab) => tab.id === tabId);
  if (previous && updated && isNewChatTab(previous) && !isNewChatTab(updated)) {
    // A submitted draft becomes the latest conversation in the scrolling strip.
    newTabs = [...newTabs.filter((tab) => tab.id !== tabId), updated];
  }
  const result: Partial<AgentChatState> = { tabs: newTabs };
  if (tabId === state.activeTabId) {
    if (updates.selectedClaudeExecutionMode !== undefined)
      result.selectedClaudeExecutionMode = updates.selectedClaudeExecutionMode;
    if (updates.selectedPiExecutionMode !== undefined)
      result.selectedPiExecutionMode = updates.selectedPiExecutionMode;
    if (updates.selectedCodexExecutionMode !== undefined)
      result.selectedCodexExecutionMode = updates.selectedCodexExecutionMode;
    if ("provider" in updates) {
      result.selectedProvider = updates.provider!;
    }
    if ("sessionId" in updates) {
      result.sessionId = updates.sessionId!;
    }
    if ("messages" in updates) {
      result.messages = updates.messages!;
    }
    if ("isStreaming" in updates) {
      result.isStreaming = updates.isStreaming!;
    }
    if ("error" in updates) {
      result.error = updates.error!;
    }
    if ("totalInputTokens" in updates) {
      result.totalInputTokens = updates.totalInputTokens!;
    }
    if ("totalOutputTokens" in updates) {
      result.totalOutputTokens = updates.totalOutputTokens!;
    }
  }
  return result;
}

function normalizeChatProvider(raw: string | undefined): ChatProvider {
  return normalizeProvider(raw);
}

function normalizeClaudeModel(
  raw: string | undefined | null,
): ClaudeModelId | null {
  return normalizeClaudeModelId(raw);
}

function normalizeCodexModel(
  raw: string | undefined | null,
): CodexModelId | null {
  if (!raw) return null;
  if (raw === "default") return "gpt-5.4";
  if (raw === "gpt-5.2-codex") return "gpt-5.2";
  return raw.trim() || null;
}

const IMAGE_FILE_URL_PATTERN =
  /file:\/\/(?:localhost)?(\/[^\s<>"')]+?\.(?:png|jpe?g|gif|webp|bmp|svg))/gi;

function fileUrlToPath(fileUrl: string): string | null {
  try {
    const url = new URL(fileUrl);
    if (url.protocol !== "file:") return null;
    return decodeURIComponent(url.pathname);
  } catch {
    const match = fileUrl.match(/^file:\/\/(.+)$/);
    return match ? decodeURIComponent(match[1]) : null;
  }
}

function extractImageFileUrls(text: string): string[] {
  IMAGE_FILE_URL_PATTERN.lastIndex = 0;
  const imageUrls = Array.from(text.matchAll(IMAGE_FILE_URL_PATTERN))
    .map((match) => match[0])
    .filter((url, index, urls) => urls.indexOf(url) === index);
  IMAGE_FILE_URL_PATTERN.lastIndex = 0;
  return imageUrls;
}

function rehydrateGeneratedImageMessages(
  messages: AgentStreamMessage[],
): AgentStreamMessage[] {
  return messages.map((message) => {
    if (message.type !== "assistant" || !message.message?.content) {
      return message;
    }

    const content = message.message.content.map((block) => ({ ...block }));
    const text = content
      .filter((block) => block.type === "text" && block.text)
      .map((block) => block.text)
      .join("\n");
    const filePaths = extractImageFileUrls(text)
      .map(fileUrlToPath)
      .filter((path): path is string => Boolean(path));

    if (filePaths.length === 0) {
      return message;
    }

    const imageBlocks = content.filter((block) => block.type === "image");
    for (const [index, filePath] of filePaths.entries()) {
      const existing = imageBlocks[index];
      if (existing) {
        existing.imageFilePath = filePath;
        existing.imageDataUrl = getAssetUrl(filePath);
        existing.alt =
          existing.alt ??
          (filePaths.length === 1
            ? "Generated image"
            : `Generated image ${index + 1}`);
        continue;
      }

      content.push({
        type: "image",
        imageDataUrl: getAssetUrl(filePath),
        imageFilePath: filePath,
        alt:
          filePaths.length === 1
            ? "Generated image"
            : `Generated image ${index + 1}`,
      });
    }

    return {
      ...message,
      message: {
        ...message.message,
        content,
      },
    };
  });
}

/** Restore history without opening a provider runtime or changing the active chat. */
export function tabFromSharedSession(session: SharedSessionPayload): TabState {
  const provider = normalizeChatProvider(session.last_provider);
  const tab = makeDefaultTab(nextTabId(), provider);
  const messages = rehydrateGeneratedImageMessages(
    session.messages.filter(
      (message) =>
        ["user", "assistant", "result"].includes(message.type) ||
        message.subtype === "draft_review_decisions",
    ),
  );
  const count = handoffMessageCount(messages);
  return {
    ...tab,
    title: session.title?.trim() || "New Chat",
    sharedSessionId: session.shared_session_id,
    lastActivityAt: session.last_modified,
    ...restoreProviderState(
      session.provider_session_ids,
      session.provider_sync_cursors,
      provider,
      count,
    ),
    sessionId: session.provider_session_ids?.[provider] ?? null,
    messages,
    pendingQuestion: session.pending_question ?? null,
  };
}

/** A composer draft has not become a conversation until a turn starts. */
export function isNewChatTab(tab: TabState): boolean {
  return (
    !tab.archived &&
    tab.messages.length === 0 &&
    !tab.history?.total &&
    !tab.sharedSessionId &&
    !tab.sessionId &&
    !Object.values(tab.providerSessionIds).some(Boolean) &&
    !tab.isStreaming &&
    !tab.isSettling &&
    !tab.turnPhase &&
    !tab.pauseState &&
    !tab.pausedRequest &&
    !tab.queuedPrompts?.length &&
    !tab.pendingQuestion &&
    !tab.pendingResumeChoice &&
    !tab.pendingFileBaseline &&
    !tab.agentWorkspace &&
    !tab.error &&
    !tab.pendingCrossProviderTranscript &&
    !tab.cancelledByUser &&
    !tab.totalInputTokens &&
    !tab.totalOutputTokens
  );
}

function hasNewChatDraft(tab: TabState): boolean {
  return tab.draft.input.length > 0 || tab.draft.pinnedContexts.length > 0;
}

function discardEmptyNewChats(tabs: TabState[], keepId?: string): TabState[] {
  return tabs.filter(
    (tab) => tab.id === keepId || !isNewChatTab(tab) || hasNewChatDraft(tab),
  );
}

// ─── State Interface ───

const DEFAULT_TAB_ID = nextTabId();

interface AgentChatState {
  chatProjectRoot: string | null;
  isLeavingProject: boolean;
  restoreProjectTabs: (
    projectRoot: string | null,
    tabs?: TabState[],
    activeTabId?: string,
  ) => void;
  // ── Projected fields (from active tab — read by consumers) ──
  selectedProvider: ChatProvider;
  messages: AgentStreamMessage[];
  sessionId: string | null;
  isStreaming: boolean;
  error: string | null;
  totalInputTokens: number;
  totalOutputTokens: number;

  // ── Tab state ──
  tabs: TabState[];
  activeTabId: string;

  /** Deferred prompt to send once the workspace is ready (set by project wizard) */
  pendingInitialPrompt: string | null;
  setPendingInitialPrompt: (prompt: string | null) => void;
  consumePendingInitialPrompt: () => string | null;

  /** Monotonic signal used by other surfaces to request the drawer collapse. */
  drawerCollapseRequestNonce: number;
  requestDrawerCollapse: () => void;
  drawerOpenRequested: boolean;
  requestDrawerOpen: () => void;
  consumeDrawerOpenRequest: () => boolean;

  /** Session-only queue visibility, shared across chats but independent per mode. */
  promptQueueFolded: Record<"mini" | "half" | "full", boolean>;
  togglePromptQueueFolded: (mode: "mini" | "half" | "full") => void;

  /** Pending attachments from external sources (e.g. PDF capture) */
  pendingAttachments: ChatContextBadge[];
  addPendingAttachment: (attachment: ChatContextBadge) => void;
  consumePendingAttachments: () => ChatContextBadge[];

  /** Provider/model selection */
  selectedClaudeModel: ClaudeModelId;
  setSelectedClaudeModel: (model: ClaudeModelId) => void;
  selectedClaudeExecutionMode: AgentExecutionMode;
  setSelectedClaudeExecutionMode: (mode: AgentExecutionMode) => void;
  selectedPiModel: string;
  setSelectedPiModel: (model: string) => void;
  selectedPiReasoningEffort: string;
  setSelectedPiReasoningEffort: (level: string) => void;
  selectedPiExecutionMode: AgentExecutionMode;
  setSelectedPiExecutionMode: (mode: AgentExecutionMode) => void;
  selectedCodexModel: CodexModelId;
  setSelectedCodexModel: (model: CodexModelId) => void;
  selectedCodexReasoningEffort: CodexReasoningEffort;
  selectedCodexFastMode: boolean;
  setSelectedCodexFastMode: (enabled: boolean) => void;
  setSelectedCodexReasoningEffort: (level: CodexReasoningEffort) => void;
  selectedCodexExecutionMode: AgentExecutionMode;
  setSelectedCodexExecutionMode: (mode: AgentExecutionMode) => void;
  setProvider: (provider: ChatProvider) => void;
  applyAgentDefaults: () => void;
  setPendingResumeChoice: (
    tabId: string,
    choice: PendingResumeChoice | null,
  ) => void;
  resolvePendingResumeChoice: (useSessionLlm: boolean) => Promise<void>;

  /** Effort level for Opus 4.6 adaptive reasoning */
  effortLevel: ClaudeEffortLevel;
  setEffortLevel: (level: ClaudeEffortLevel) => void;

  // Actions
  sendPrompt: (
    userPrompt: string,
    contextOverride?: ChatPromptContext,
    retryPausedRequest?: boolean,
    onAccepted?: () => void,
    targetTabId?: string,
  ) => Promise<void>;
  enqueuePrompt: (
    tabId: string,
    prompt: string,
    context?: ChatPromptContext,
  ) => boolean;
  removeQueuedPrompt: (tabId: string, id: string) => void;
  moveQueuedPrompt: (tabId: string, id: string, targetId: string) => void;
  editQueuedPrompt: (tabId: string, id: string) => TabDraft | null;
  resumePromptQueue: (tabId: string) => Promise<void>;
  _runNextQueuedPrompt: (tabId: string) => Promise<void>;
  cancelExecution: () => Promise<void>;
  pauseExecution: (tabId?: string) => Promise<void>;
  continueExecution: () => Promise<void>;
  _cancelExecutionForTab: (tabId: string) => Promise<void>;
  clearMessages: () => void;
  newSession: () => void;
  resumeSession: (
    sessionId: string,
    options?: ResumeSessionOptions,
  ) => Promise<void>;

  // Tab actions
  createTab: () => string;
  requestNewChat: () => string;
  composerFocusRequestNonce: number;
  loadHistory: (tabId: string, start?: number, limit?: number) => Promise<void>;
  forkSessionAtMessage: (messageIndex: number) => Promise<string | null>;
  closeTab: (tabId: string) => void;
  archiveTab: (tabId: string) => Promise<void>;
  updateSessionArchive: (
    sharedSessionId: string,
    archived: boolean,
    restoredTab?: TabState,
  ) => void;
  setActiveTab: (tabId: string, finishSessionLoad?: boolean) => void;
  saveDraft: (tabId: string, draft: TabDraft) => void;

  /** True when any tab is streaming */
  anyStreaming: () => boolean;

  // Internal actions (called by event hook, routed by tabId)
  _recordReviewDecision: (
    tabId: string,
    message: AgentStreamMessage,
  ) => Promise<void>;
  _appendMessage: (tabId: string, msg: AgentStreamMessage) => void;
  _recordContextUsage: (
    tabId: string,
    provider: ChatProvider,
    message: unknown,
  ) => void;
  _answerQuestion: (question: AgentQuestion, answer: string) => Promise<void>;
  _rememberQuestion: (question: AgentQuestion) => void;
  _answerRestoredQuestion: (
    tabId: string,
    requestId: string,
    answer: string,
  ) => Promise<void>;
  _applyActivity: (tabId: string, activity: AgentActivity) => void;
  _setProviderStatus: (
    tabId: string,
    provider: ChatProvider,
    status: string | null,
  ) => void;
  _setSessionId: (tabId: string, id: string) => void;
  _markProviderSynced: (tabId: string, provider: ChatProvider) => void;
  _setStreaming: (
    tabId: string,
    streaming: boolean,
    interrupted?: boolean,
  ) => void;
  _finishRoundTiming: (tabId: string) => void;
  _setRoundWaiting: (
    tabId: string,
    requestId: string,
    waiting: boolean,
  ) => void;
  _setError: (tabId: string, error: string | null) => void;
  _finishCompaction: (tabId: string, success: boolean) => void;
  _recoverError: (tabId: string, expectedError: string) => void;
  _setPendingFileBaseline: (
    tabId: string,
    baseline: Record<string, string> | null,
  ) => void;
  _retireLegacyWorkspace: (tabId: string) => void;
  _setAgentWorkspace: (
    tabId: string,
    workspace: AgentWorkspaceSession | null,
  ) => void;
  _detachProjectAgentWorkspaces: (projectRoot: string) => void;
  _syncSharedSession: (tabId: string) => Promise<void>;
}

// Keep a pending-question snapshot from landing after its submitted-answer save.
const sharedSessionWrites = new Map<string, Promise<void>>();

async function syncTabToSharedSession(
  tabId: string,
  get: () => AgentChatState,
  set: any,
  requireSaved = false,
): Promise<void> {
  const projectPath = useDocumentStore.getState().projectRoot;
  if (!projectPath) return;

  try {
    if (
      !get().tabs.find((tab) => tab.id === tabId)?.history &&
      get().tabs.find((tab) => tab.id === tabId)?.pendingReviewDecisions?.length
    )
      await get().loadHistory(tabId);
  } catch (error) {
    if (requireSaved) throw error;
    log.error("Failed to load shared session for saving", {
      tabId,
      error: String(error),
    });
    return;
  }
  const state = get();
  const tab = state.tabs.find((t) => t.id === tabId);
  if (!tab) return;

  if (
    !tab.sharedSessionId &&
    !getUnansweredQuestion(tab) &&
    tab.messages.length === 0 &&
    !Object.values(tab.providerSessionIds).some(Boolean)
  ) {
    return;
  }

  const saveKey = `${projectPath}:${tab.runtimeSessionKey}`;
  const previous = sharedSessionWrites.get(saveKey);
  let release!: () => void;
  const writing = new Promise<void>((resolve) => {
    release = resolve;
  });
  sharedSessionWrites.set(saveKey, writing);
  if (previous) await previous;
  try {
    const current = get().tabs.find(
      (current) =>
        current.id === tabId &&
        current.runtimeSessionKey === tab.runtimeSessionKey,
    );
    const persistPaged = async () => {
      if (!get().tabs.find((item) => item.id === tabId)?.sharedSessionId)
        set((state: AgentChatState) =>
          applyTabUpdate(state, tabId, {
            sharedSessionId: crypto.randomUUID(),
          }),
        );
      const { withChatCheckpoint } = await import(
        "@/lib/project-chat-lifecycle"
      );
      return withChatCheckpoint(async () => {
        const latest = get().tabs.find((item) => item.id === tabId);
        if (!latest || latest.runtimeSessionKey !== tab.runtimeSessionKey)
          throw new Error("The conversation changed.");
        return invoke<SaveSharedSessionResult>("desktop:chat:sync-shared", {
          projectRoot: projectPath,
          tabId,
          runtimeSessionKey: tab.runtimeSessionKey,
          sharedSessionId: latest.sharedSessionId,
          pendingQuestion: getUnansweredQuestion(latest),
        });
      });
    };
    const result = tab.history
      ? await persistPaged()
      : await invoke<SaveSharedSessionResult>("save_shared_session", {
          projectPath,
          sharedSessionId: current?.sharedSessionId ?? tab.sharedSessionId,
          title: tab.title,
          lastProvider: tab.provider,
          lastClaudeModel: state.selectedClaudeModel,
          lastCodexModel: state.selectedCodexModel,
          lastPiModel: state.selectedPiModel,
          providerSessionIds: tab.providerSessionIds,
          providerSyncCursors: tab.providerSyncCursors,
          messages: tab.messages,
          ...(tab.lastActivityAt == null
            ? {}
            : { lastActivityAt: tab.lastActivityAt }),
          pendingQuestion: getUnansweredQuestion(tab),
        });
    if (!result?.shared_session_id) {
      if (requireSaved)
        throw new Error("Could not save this chat before archiving.");
      return;
    }
    if (
      useDocumentStore.getState().projectRoot !== projectPath ||
      get().tabs.find((current) => current.id === tabId)?.runtimeSessionKey !==
        tab.runtimeSessionKey
    )
      return;
    if (
      !tab.sharedSessionId ||
      tab.sharedSessionId !== result.shared_session_id
    ) {
      set((s: AgentChatState) =>
        applyTabUpdate(s, tabId, {
          sharedSessionId: result.shared_session_id,
        }),
      );
    }
    window.dispatchEvent(
      new CustomEvent(SHARED_SESSION_SAVED_EVENT, {
        detail: { projectRoot: projectPath },
      }),
    );
  } catch (err) {
    log.error("Failed to sync shared session", {
      tabId,
      error: String(err),
    });
    if (requireSaved) throw err;
  } finally {
    release();
    if (sharedSessionWrites.get(saveKey) === writing)
      sharedSessionWrites.delete(saveKey);
  }
}

function isVisibleUserMessage(message: AgentStreamMessage): boolean {
  return (
    message.type === "user" &&
    (message.message?.content ?? []).some(
      (block) => block.type === "text" && Boolean(block.text?.trim()),
    )
  );
}

export function getUnansweredQuestion(
  tab: TabState,
): SavedAgentQuestion | null {
  const question = tab.pendingQuestion;
  return question &&
    !tab.messages.some(
      (message) => message.uuid === `question-answer-${question.requestId}`,
    )
    ? question
    : null;
}

function applyActivityToMessages(
  messages: AgentStreamMessage[],
  activity: AgentActivity,
  provider: ChatProvider,
): AgentStreamMessage[] {
  const next = messages.map((message) => ({
    ...message,
    message: message.message
      ? {
          ...message.message,
          content: message.message.content?.map((block) => ({ ...block })),
        }
      : undefined,
  }));
  let turnStart = -1;
  let replyStart = -1;
  for (let index = next.length - 1; index >= 0; index -= 1) {
    if (isVisibleUserMessage(next[index])) {
      if (replyStart < 0) replyStart = index;
      if (next[index].subtype !== "question_answer") {
        turnStart = index;
        break;
      }
    }
  }

  if (activity.kind === "tool_completed") {
    for (
      let messageIndex = next.length - 1;
      messageIndex > turnStart;
      messageIndex -= 1
    ) {
      const content = next[messageIndex].message?.content;
      const existing = content?.find(
        (block) =>
          block.type === "tool_result" && block.tool_use_id === activity.id,
      );
      if (existing) {
        existing.content = activity.content;
        existing.is_error = activity.isError;
        return next;
      }
    }

    next.push({
      type: "user",
      provider,
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: activity.id,
            content: activity.content,
            is_error: activity.isError,
          },
        ],
      },
    });
    return next;
  }

  // Answers split visible replies, not provider turns. Late updates still belong
  // to their original block; new output must appear after the user's answer.
  let assistantIndex = -1;
  for (let index = next.length - 1; index > turnStart; index -= 1) {
    const message = next[index];
    if (
      message.type === "assistant" &&
      message.message?.content?.some((block) => block.id === activity.id)
    ) {
      assistantIndex = index;
      break;
    }
  }
  if (assistantIndex < 0) {
    for (let index = next.length - 1; index > replyStart; index -= 1) {
      if (next[index].type === "assistant") {
        assistantIndex = index;
        break;
      }
    }
  }
  if (assistantIndex < 0) {
    next.push({ type: "assistant", provider, message: { content: [] } });
    assistantIndex = next.length - 1;
  }

  const content = next[assistantIndex].message?.content ?? [];
  next[assistantIndex].message = {
    ...next[assistantIndex].message,
    content,
  };

  if (activity.kind === "tool_started") {
    const existing = content.find(
      (block) => block.type === "tool_use" && block.id === activity.id,
    );
    if (existing) {
      if (activity.name) existing.name = activity.name;
      if (activity.input !== undefined) existing.input = activity.input;
    } else {
      content.push({
        type: "tool_use",
        id: activity.id,
        name: activity.name ?? "Tool",
        input: activity.input ?? {},
      });
    }
    return next;
  }

  const blockType =
    activity.kind === "thinking_delta" || activity.kind === "thinking_replace"
      ? "thinking"
      : "text";
  const existing = content.find(
    (block) => block.type === blockType && block.id === activity.id,
  );
  const nextText = activity.text ?? "";
  const shouldReplace =
    activity.kind === "text_replace" || activity.kind === "thinking_replace";

  if (existing) {
    if (blockType === "thinking") {
      existing.thinking = shouldReplace
        ? nextText
        : `${existing.thinking ?? ""}${nextText}`;
    } else {
      existing.text = shouldReplace
        ? nextText
        : `${existing.text ?? ""}${nextText}`;
    }
  } else if (nextText) {
    content.push(
      blockType === "thinking"
        ? {
            type: "thinking",
            id: activity.id,
            thinking: nextText,
            signature: activity.id,
          }
        : { type: "text", id: activity.id, text: nextText },
    );
  }

  return next;
}

// ─── Store ───

const initialAgentDefaults = getAgentDefaults();
const initialDefaultProvider = initialAgentDefaults.selectedProvider;

export const useAgentChatStore = create<AgentChatState>()((set, get) => ({
  chatProjectRoot: null,
  isLeavingProject: false,
  restoreProjectTabs: (projectRoot, savedTabs, savedActiveTabId) => {
    set(getAgentDefaults());
    const tabs = savedTabs?.length
      ? savedTabs.map((tab) => ({
          ...makeDefaultTab(tab.id, tab.provider),
          ...tab,
          runtimeSessionKey: nextRuntimeSessionKey(),
          roundTiming: tab.roundTiming
            ? { ...tab.roundTiming, runningSince: null }
            : null,
          isStreaming: false,
          providerStatus: null,
          isSettling: false,
          pauseState:
            tab.pauseState || (tab.isStreaming && !tab.cancelledByUser)
              ? ("paused" as const)
              : null,
          pausedRequest:
            tab.cancelledByUser && !tab.pauseState
              ? null
              : tab.turnPhase === "preparing"
                ? tab.pausedRequest
                : tab.isStreaming
                  ? null
                  : tab.pausedRequest,
          pendingQuestion:
            tab.cancelledByUser && !tab.pauseState ? null : tab.pendingQuestion,
          turnPhase: null,
          cancelledByUser: false,
          promptQueuePaused: !!tab.queuedPrompts?.length,
          dispatchingQueuedPromptId: null,
        }))
      : [makeDefaultTab(nextTabId(), get().selectedProvider)];
    const paused = tabs.filter(
      (tab) => !tab.archived && tab.pauseState === "paused",
    );
    let active: TabState | undefined =
      paused.find((tab) => tab.id === savedActiveTabId) ?? paused[0];
    if (!active) {
      active = tabs.find(isNewChatTab);
      if (!active) {
        active = makeDefaultTab(nextTabId(), get().selectedProvider);
        tabs.push(active);
      }
    }
    const selected = active;
    set((state) => ({
      composerFocusRequestNonce: state.composerFocusRequestNonce + 1,
      chatProjectRoot: projectRoot,
      isLeavingProject: false,
      tabs: discardEmptyNewChats(tabs, selected.id),
      activeTabId: selected.id,
      ...applyTabUpdate(
        {
          ...state,
          tabs: discardEmptyNewChats(tabs, selected.id),
          activeTabId: selected.id,
        },
        selected.id,
        selected,
      ),
      pendingAttachments: [],
      drawerOpenRequested: tabs.some(
        (tab) => !tab.archived && (tab.pauseState || tab.agentWorkspace),
      ),
    }));
  },
  // Projected fields (initialized from default tab)
  selectedProvider: initialDefaultProvider,
  messages: [],
  sessionId: null,
  isStreaming: false,
  error: null,
  totalInputTokens: 0,
  totalOutputTokens: 0,

  // Tab state
  tabs: [makeDefaultTab(DEFAULT_TAB_ID, initialDefaultProvider)],
  activeTabId: DEFAULT_TAB_ID,

  selectedClaudeModel: initialAgentDefaults.selectedClaudeModel,
  setSelectedClaudeModel: (model) => set({ selectedClaudeModel: model }),
  selectedClaudeExecutionMode: initialAgentDefaults.selectedClaudeExecutionMode,
  setSelectedClaudeExecutionMode: (mode) =>
    set((state) =>
      applyTabUpdate(state, state.activeTabId, {
        selectedClaudeExecutionMode: mode,
      }),
    ),

  selectedPiModel: initialAgentDefaults.selectedPiModel,
  setSelectedPiModel: (model) => set({ selectedPiModel: model }),
  selectedPiReasoningEffort: initialAgentDefaults.selectedPiReasoningEffort,
  setSelectedPiReasoningEffort: (level) =>
    set({ selectedPiReasoningEffort: level }),
  selectedPiExecutionMode: initialAgentDefaults.selectedPiExecutionMode,
  setSelectedPiExecutionMode: (mode) =>
    set((state) =>
      applyTabUpdate(state, state.activeTabId, {
        selectedPiExecutionMode: mode,
      }),
    ),
  selectedCodexModel: initialAgentDefaults.selectedCodexModel,
  selectedCodexFastMode: false,
  setSelectedCodexFastMode: (enabled) =>
    set({ selectedCodexFastMode: enabled }),
  setSelectedCodexModel: (model) => set({ selectedCodexModel: model }),
  selectedCodexReasoningEffort:
    initialAgentDefaults.selectedCodexReasoningEffort,
  setSelectedCodexReasoningEffort: (level) =>
    set({ selectedCodexReasoningEffort: level }),
  selectedCodexExecutionMode: initialAgentDefaults.selectedCodexExecutionMode,
  setSelectedCodexExecutionMode: (mode) =>
    set((state) =>
      applyTabUpdate(state, state.activeTabId, {
        selectedCodexExecutionMode: mode,
      }),
    ),

  setProvider: (provider) => {
    if (!useSettingsStore.getState().enabledProviders[provider]) return;
    const { activeTabId, tabs } = get();
    const activeTab = tabs.find((tab) => tab.id === activeTabId);
    if (!activeTab || activeTab.isStreaming || activeTab.provider === provider)
      return;
    set((state) =>
      applyTabUpdate(state, activeTabId, {
        provider,
        sessionId: activeTab.providerSessionIds[provider] ?? null,
        pendingCrossProviderTranscript: null,
        error: null,
        isStreaming: false,
        pendingClaudeExecutionMode: null,
      }),
    );
    void syncTabToSharedSession(activeTabId, get, set);
    void get()._runNextQueuedPrompt(activeTabId);
  },
  applyAgentDefaults: () => {
    const defaults = getAgentDefaults();
    const { activeTabId, tabs } = get();
    const activeTab = tabs.find((tab) => tab.id === activeTabId);
    if (activeTab?.isStreaming) return;
    const canApplyProviderDefault =
      !activeTab?.sessionId &&
      !Object.values(activeTab?.providerSessionIds ?? {}).some(Boolean) &&
      (activeTab?.messages.length ?? 0) === 0;
    const {
      selectedProvider,
      selectedClaudeExecutionMode: _claudeMode,
      selectedCodexExecutionMode: _codexMode,
      selectedPiExecutionMode: _piMode,
      ...llmDefaults
    } = defaults;
    set((state) => ({
      ...applyTabUpdate(
        state,
        activeTabId,
        canApplyProviderDefault ? { provider: selectedProvider } : {},
      ),
      ...llmDefaults,
      ...(canApplyProviderDefault ? { selectedProvider } : {}),
    }));
  },
  setPendingResumeChoice: (tabId, choice) => {
    set((state) =>
      applyTabUpdate(state, tabId, { pendingResumeChoice: choice }),
    );
  },
  resolvePendingResumeChoice: async (useSessionLlm) => {
    const state = get();
    const activeTab = state.tabs.find((tab) => tab.id === state.activeTabId);
    const choice = activeTab?.pendingResumeChoice;
    if (!choice) return;
    await get().resumeSession(choice.sharedSessionId, {
      sessionProvider: choice.sessionProvider,
      sessionClaudeModel: choice.sessionClaudeModel,
      sessionCodexModel: choice.sessionCodexModel,
      sessionPiModel: choice.sessionPiModel,
      useSessionLlm,
    });
  },

  effortLevel: initialAgentDefaults.effortLevel,
  setEffortLevel: (level) => set({ effortLevel: level }),

  pendingInitialPrompt: null,
  setPendingInitialPrompt: (prompt) => set({ pendingInitialPrompt: prompt }),
  consumePendingInitialPrompt: () => {
    const { pendingInitialPrompt } = get();
    if (pendingInitialPrompt) {
      set({ pendingInitialPrompt: null });
    }
    return pendingInitialPrompt;
  },
  drawerCollapseRequestNonce: 0,
  requestDrawerCollapse: () =>
    set((state) => ({
      drawerCollapseRequestNonce: state.drawerCollapseRequestNonce + 1,
    })),
  drawerOpenRequested: false,
  promptQueueFolded: { mini: true, half: false, full: false },
  togglePromptQueueFolded: (mode) =>
    set((state) => ({
      promptQueueFolded: {
        ...state.promptQueueFolded,
        [mode]: !state.promptQueueFolded[mode],
      },
    })),
  requestDrawerOpen: () => set({ drawerOpenRequested: true }),
  consumeDrawerOpenRequest: () => {
    const requested = get().drawerOpenRequested;
    if (requested) set({ drawerOpenRequested: false });
    return requested;
  },

  pendingAttachments: [],
  addPendingAttachment: (attachment) => {
    set((state) => ({
      pendingAttachments: [...state.pendingAttachments, attachment],
    }));
  },
  consumePendingAttachments: () => {
    const { pendingAttachments } = get();
    if (pendingAttachments.length > 0) {
      set({ pendingAttachments: [] });
    }
    return pendingAttachments;
  },

  anyStreaming: () => get().tabs.some((t) => t.isStreaming),

  enqueuePrompt: (tabId, prompt, context) => {
    const state = get();
    const tab = state.tabs.find((item) => item.id === tabId);
    const items = chatContextItems(
      context ??
        (/^\/compact(?:\s|$)/.test(prompt.trim())
          ? []
          : getCurrentSelectionDraftContext()) ??
        [],
    );
    if (
      !tab ||
      state.isLeavingProject ||
      !useDocumentStore.getState().projectRoot ||
      (state.chatProjectRoot &&
        state.chatProjectRoot !== useDocumentStore.getState().projectRoot) ||
      (!prompt.trim() && !items.length)
    )
      return false;
    const queued: QueuedChatPrompt = {
      id: `prompt-${Date.now()}-${++queuedPromptCounter}`,
      prompt,
      context: structuredClone(items),
      ...(/^\/compact(?:\s|$)/.test(prompt.trim())
        ? { provider: tab.provider }
        : {}),
    };
    set((current) =>
      applyTabUpdate(current, tabId, {
        queuedPrompts: [
          ...(current.tabs.find((item) => item.id === tabId)?.queuedPrompts ??
            []),
          queued,
        ],
      }),
    );
    return true;
  },
  removeQueuedPrompt: (tabId, id) => {
    set((state) => {
      const tab = state.tabs.find((item) => item.id === tabId);
      if (!tab || tab.dispatchingQueuedPromptId === id) return {};
      return applyTabUpdate(state, tabId, {
        queuedPrompts: tab.queuedPrompts?.filter((item) => item.id !== id),
      });
    });
    void get()._runNextQueuedPrompt(tabId);
  },
  moveQueuedPrompt: (tabId, id, targetId) => {
    set((state) => {
      const tab = state.tabs.find((item) => item.id === tabId);
      const queue = [...(tab?.queuedPrompts ?? [])];
      const from = queue.findIndex((item) => item.id === id);
      const to = queue.findIndex((item) => item.id === targetId);
      if (
        !tab ||
        from < 0 ||
        to < 0 ||
        id === targetId ||
        tab.dispatchingQueuedPromptId === id ||
        tab.dispatchingQueuedPromptId === targetId
      )
        return {};
      queue.splice(to, 0, queue.splice(from, 1)[0]);
      return applyTabUpdate(state, tabId, { queuedPrompts: queue });
    });
  },
  editQueuedPrompt: (tabId, id) => {
    let draft: TabDraft | null = null;
    set((state) => {
      const tab = state.tabs.find((item) => item.id === tabId);
      const item = tab?.queuedPrompts?.find((item) => item.id === id);
      if (!tab || !item || tab.dispatchingQueuedPromptId === id) return {};
      draft = {
        input: item.prompt,
        pinnedContexts: structuredClone(item.context),
      };
      return applyTabUpdate(state, tabId, {
        draft,
        queuedPrompts: tab.queuedPrompts?.filter((entry) => entry.id !== id),
      });
    });
    if (draft) void get()._runNextQueuedPrompt(tabId);
    return draft;
  },
  resumePromptQueue: async (tabId) => {
    const tab = get().tabs.find((item) => item.id === tabId);
    if (!tab || tab.error || get().isLeavingProject) return;
    set((state) => applyTabUpdate(state, tabId, { promptQueuePaused: false }));
    if (tab.pauseState === "paused" && get().activeTabId === tabId)
      await get().continueExecution();
    else await get()._runNextQueuedPrompt(tabId);
  },
  _runNextQueuedPrompt: async (tabId) => {
    const state = get();
    const tab = state.tabs.find((item) => item.id === tabId);
    const head = tab?.queuedPrompts?.[0];
    if (
      !tab ||
      !head ||
      (head.provider && head.provider !== tab.provider) ||
      dispatchingPromptQueues.has(tab.runtimeSessionKey) ||
      tab.promptQueuePaused ||
      tab.isStreaming ||
      tab.isSettling ||
      tab.turnPhase ||
      tab.pauseState ||
      tab.error ||
      getUnansweredQuestion(tab) ||
      tab.pendingResumeChoice ||
      tab.archived ||
      state.isLeavingProject ||
      !state.chatProjectRoot ||
      state.chatProjectRoot !== useDocumentStore.getState().projectRoot ||
      !useSettingsStore.getState().enabledProviders[tab.provider]
    )
      return;
    // Refinement flushes the visible review buffers. Wait until that chat and
    // its draft are open; never switch focus behind the user's back.
    if (
      tab.agentWorkspace &&
      tab.agentWorkspace.status !== "active" &&
      state.activeTabId !== tabId
    )
      return;
    dispatchingPromptQueues.add(tab.runtimeSessionKey);
    set((current) =>
      applyTabUpdate(current, tabId, { dispatchingQueuedPromptId: head.id }),
    );
    let accepted = false;
    try {
      await get().sendPrompt(
        head.prompt,
        structuredClone(head.context),
        false,
        () => {
          accepted = true;
          set((current) => {
            const currentTab = current.tabs.find((item) => item.id === tabId);
            if (currentTab?.runtimeSessionKey !== tab.runtimeSessionKey)
              return {};
            return applyTabUpdate(current, tabId, {
              queuedPrompts: currentTab.queuedPrompts?.filter(
                (item) => item.id !== head.id,
              ),
              dispatchingQueuedPromptId: null,
            });
          });
        },
        tabId,
      );
    } catch (error) {
      if (
        get().tabs.find((item) => item.id === tabId)?.runtimeSessionKey ===
        tab.runtimeSessionKey
      )
        get()._setError(
          tabId,
          `Could not send the queued prompt: ${String(error)}`,
        );
    } finally {
      dispatchingPromptQueues.delete(tab.runtimeSessionKey);
      set((current) => {
        const currentTab = current.tabs.find((item) => item.id === tabId);
        return currentTab?.runtimeSessionKey === tab.runtimeSessionKey
          ? applyTabUpdate(current, tabId, { dispatchingQueuedPromptId: null })
          : {};
      });
      // A very short turn may complete before its launch acknowledgement.
      // Completion could not drain while this dispatch still held the lock.
      if (
        accepted &&
        get().tabs.find((item) => item.id === tabId)?.runtimeSessionKey ===
          tab.runtimeSessionKey
      )
        void get()._runNextQueuedPrompt(tabId);
    }
  },

  sendPrompt: async (
    userPrompt: string,
    contextOverride?: ChatPromptContext,
    retryPausedRequest = false,
    onAccepted?: () => void,
    targetTabId?: string,
  ) => {
    const requestedTab = targetTabId ?? get().activeTabId;
    const requestedState = get().tabs.find((tab) => tab.id === requestedTab);
    if (
      requestedState &&
      !targetTabId &&
      !retryPausedRequest &&
      (requestedState.isStreaming ||
        requestedState.isSettling ||
        requestedState.turnPhase ||
        requestedState.queuedPrompts?.length)
    ) {
      if (get().enqueuePrompt(requestedTab, userPrompt, contextOverride)) {
        onAccepted?.();
        void get()._runNextQueuedPrompt(requestedTab);
      }
      return;
    }
    if (
      !requestedState ||
      requestedState.isStreaming ||
      requestedState.isSettling ||
      get().isLeavingProject ||
      requestedState.turnPhase === "starting"
    )
      return;
    const requestedProvider = requestedState.provider;
    const compact = userPrompt.trim().match(/^\/compact(?:\s+([\s\S]*))?$/);
    if (compact) {
      if (!HARNESSES[requestedProvider].compact) {
        get()._setError(
          requestedTab,
          "Manual compaction is not available for this harness.",
        );
        return;
      }
      const projectRoot = useDocumentStore.getState().projectRoot;
      if (
        !projectRoot ||
        (get().chatProjectRoot && get().chatProjectRoot !== projectRoot)
      )
        return;
      if (
        !requestedState.sessionId ||
        requestedState.archived ||
        requestedState.history?.writable === false
      ) {
        get()._setError(
          requestedTab,
          "Start or resume this agent's conversation before compacting.",
        );
        return;
      }
      const compactBlockedReason = getUnansweredQuestion(requestedState)
        ? "Answer the pending question before compacting."
        : requestedState.pendingResumeChoice
          ? "Choose how to resume this conversation before compacting."
          : requestedState.pauseState
            ? "Resume or stop the paused turn before compacting."
            : null;
      if (compactBlockedReason) {
        get()._setError(requestedTab, compactBlockedReason);
        return;
      }
      const followUp = compact[1]?.trim();
      if (!followUp && chatContextItems(contextOverride).length) {
        get()._setError(
          requestedTab,
          "Add a follow-up message to send attachments after compaction.",
        );
        return;
      }
      set((state) =>
        applyTabUpdate(state, requestedTab, {
          compacting: true,
          retryRequest: null,
          roundTiming: {
            elapsedMs: 0,
            runningSince: Date.now(),
            startIndex:
              (requestedState.history?.start ?? 0) +
              requestedState.messages.length,
            waitingFor: [],
          },
          isStreaming: true,
          turnPhase: "starting",
          cancelledByUser: false,
          error: null,
          promptQueuePaused: false,
          ...(followUp
            ? {
                queuedPrompts: [
                  {
                    id: `prompt-${Date.now()}-${++queuedPromptCounter}`,
                    prompt: followUp,
                    context: structuredClone(chatContextItems(contextOverride)),
                    provider: requestedProvider,
                  },
                  ...(state.tabs.find((tab) => tab.id === requestedTab)
                    ?.queuedPrompts ?? []),
                ],
              }
            : {}),
        }),
      );
      get()._setProviderStatus(requestedTab, requestedProvider, "compacting");
      onAccepted?.();
      try {
        const settings = get();
        const piModel = findPiModel(
          usePiSetupStore.getState().models,
          settings.selectedPiModel,
        );
        if (requestedProvider === "pi" && !piModel)
          throw new Error("Choose an available Pi model before compacting.");
        await invoke(`compact_${requestedProvider}_session`, {
          tabId: requestedTab,
          runtimeSessionKey: requestedState.runtimeSessionKey,
          sessionId: requestedState.sessionId,
          projectPath:
            requestedState.agentWorkspace?.status === "active"
              ? requestedState.agentWorkspace.candidateRoot
              : projectRoot,
          sourceProjectPath: projectRoot,
          model:
            requestedProvider === "codex"
              ? settings.selectedCodexModel
              : settings.selectedClaudeModel,
          reasoningEffort: settings.selectedCodexReasoningEffort,
          effortLevel: settings.effortLevel,
          ...(requestedProvider === "pi"
            ? {
                piConfig: piConfigFromSettings(),
                model: settings.selectedPiModel,
                reasoningEffort: resolvePiThinkingLevel(
                  piModel,
                  settings.selectedPiReasoningEffort,
                ),
              }
            : {}),
        });
        const current = get().tabs.find((tab) => tab.id === requestedTab);
        if (current?.compacting) {
          set((state) =>
            applyTabUpdate(state, requestedTab, { turnPhase: "running" }),
          );
          if (current.pauseState === "pausing" || current.cancelledByUser)
            await get()._cancelExecutionForTab(requestedTab);
        }
      } catch (error) {
        get()._setError(
          requestedTab,
          `Could not compact context: ${String(error)}`,
        );
        get()._finishCompaction(requestedTab, false);
      }
      return;
    }
    const requestedConversation = get().tabs.find(
      (tab) => tab.id === requestedTab,
    )?.runtimeSessionKey;
    try {
      if (
        get().tabs.find((tab) => tab.id === requestedTab)?.history ||
        get().tabs.find((tab) => tab.id === requestedTab)
          ?.pendingReviewDecisions?.length
      ) {
        const tab = get().tabs.find((item) => item.id === requestedTab)!;
        if (tab.history && tab.sessionId && tab.sharedSessionId) {
          const { withChatCheckpoint } = await import(
            "@/lib/project-chat-lifecycle"
          );
          await withChatCheckpoint(async () => {
            if (
              get().tabs.find((item) => item.id === requestedTab)
                ?.runtimeSessionKey !== requestedConversation ||
              get().tabs.find((tab) => tab.id === requestedTab)?.isStreaming
            )
              return;
            const prepared = await invoke<{
              messages: AgentStreamMessage[];
              start: number;
              total: number;
              prefixCount: number;
              latestReview: AgentStreamMessage | null;
              transcript: string;
            }>("desktop:chat:prepare-turn", {
              projectRoot: get().chatProjectRoot,
              tabId: requestedTab,
              runtimeSessionKey: requestedConversation,
              cursor: tab.providerSyncCursors[tab.provider] ?? 0,
              retry: retryPausedRequest,
            });
            if (
              get().tabs.find((item) => item.id === requestedTab)
                ?.runtimeSessionKey !== requestedConversation ||
              get().tabs.find((tab) => tab.id === requestedTab)?.isStreaming
            )
              return;
            const { messages, ...history } = prepared;
            set((current) =>
              applyTabUpdate(current, requestedTab, {
                messages: rehydrateGeneratedImageMessages(messages),
                history: { ...history, writable: true },
              }),
            );
          });
        } else await get().loadHistory(requestedTab);
      }
    } catch (error) {
      if (
        get().tabs.find((tab) => tab.id === requestedTab)?.runtimeSessionKey !==
        requestedConversation
      )
        return;
      set((state) =>
        applyTabUpdate(state, requestedTab, {
          error: `Could not load chat history: ${String(error)}`,
        }),
      );
      return;
    }
    if (
      (!targetTabId && get().activeTabId !== requestedTab) ||
      get().tabs.find((tab) => tab.id === requestedTab)?.provider !==
        requestedProvider ||
      get().tabs.find((tab) => tab.id === requestedTab)?.runtimeSessionKey !==
        requestedConversation
    )
      return;
    const currentState = get();
    const requested = currentState.tabs.find((tab) => tab.id === requestedTab);
    const state = targetTabId
      ? {
          ...currentState,
          activeTabId: requestedTab,
          selectedProvider: requestedProvider,
          ...(requested ? tabPermissions(requested, currentState) : {}),
        }
      : currentState;
    const { activeTabId } = state;
    const activeTab = state.tabs.find((t) => t.id === activeTabId);
    if (
      activeTab &&
      !useSettingsStore.getState().enabledProviders[activeTab.provider]
    )
      return;
    // Guard: prevent sending from a tab that's already streaming
    if (
      state.isLeavingProject ||
      !activeTab ||
      activeTab.isSettling ||
      activeTab.isStreaming ||
      activeTab.turnPhase === "starting"
    )
      return;
    let refinementInstructions: string | undefined;
    let resumableAgentWorkspace =
      activeTab?.agentWorkspace?.status === "active"
        ? activeTab.agentWorkspace
        : null;
    if (resumableAgentWorkspace && activeTab.pauseState === "paused") {
      try {
        const { usePausedReviewStore } = await import("./paused-review-store");
        if (
          await usePausedReviewStore
            .getState()
            .check(activeTabId, userPrompt, contextOverride)
        ) {
          onAccepted?.();
          return;
        }
      } catch (error) {
        set((current) =>
          applyTabUpdate(current, activeTabId, {
            error: `Could not check the paused draft. Your work is preserved: ${String(error)}`,
          }),
        );
        return;
      }
    }
    if (activeTab.agentWorkspace && !resumableAgentWorkspace) {
      const { useAgentReviewQueueStore } = await import(
        "./agent-review-queue-store"
      );
      const currentTab = get().tabs.find((item) => item.id === activeTabId);
      if (
        currentTab?.turnPhase === "starting" ||
        currentTab?.isStreaming ||
        get().activeTabId !== activeTabId
      )
        return;
      const queue = useAgentReviewQueueStore.getState();
      const entry = queue.entries.find(
        (item) =>
          item.session.sessionId === activeTab.agentWorkspace?.sessionId,
      );
      if (entry?.phase !== "review") return;
      // Restoring the source editor clears its draft selection. Capture the
      // proposal excerpt before beginning that workspace transition.
      contextOverride ??= getCurrentSelectionDraftContext() ?? undefined;
      set((current) =>
        applyTabUpdate(current, activeTabId, {
          turnPhase: "starting",
          error: null,
        }),
      );
      try {
        const refinement = await queue.beginRefinement(entry.session.sessionId);
        resumableAgentWorkspace = refinement.session;
        refinementInstructions = refinement.instructions;
        get()._setAgentWorkspace(activeTabId, refinement.session);
      } catch (error) {
        set((current) =>
          applyTabUpdate(current, activeTabId, {
            turnPhase: null,
            error: `Could not start refinement. Your draft and message are preserved. ${String(error)}`,
          }),
        );
        return;
      }
    }

    const {
      selectedProvider,
      selectedClaudeModel,
      selectedClaudeExecutionMode,
      selectedCodexModel,
      selectedCodexReasoningEffort,
      selectedCodexExecutionMode,
      selectedCodexFastMode,
      selectedPiModel,
      selectedPiReasoningEffort,
      selectedPiExecutionMode,
      effortLevel,
    } = state;
    const sessionId = activeTab?.sessionId ?? null;
    const runtimeSessionKey =
      activeTab?.runtimeSessionKey ?? nextRuntimeSessionKey();
    const codexThreadId =
      selectedProvider === "codex"
        ? (activeTab?.providerSessionIds.codex ?? sessionId)
        : null;
    const claudeExecutionMode = selectedClaudeExecutionMode;
    const codexExecutionMode = selectedCodexExecutionMode;
    const executionMode =
      selectedProvider === "claude"
        ? claudeExecutionMode
        : selectedProvider === "pi"
          ? selectedPiExecutionMode
          : codexExecutionMode;

    const sendStart = performance.now();
    log.info("sendPrompt start", {
      sessionId: !!sessionId,
      hasContext: !!contextOverride,
      tab: activeTabId,
    });

    const docState = useDocumentStore.getState();
    const projectPath = docState.projectRoot;
    if (!projectPath) {
      set((s) => applyTabUpdate(s, activeTabId, { error: "No project open" }));
      return;
    }

    // Compute context label for display in chat history
    const activeFile = docState.files.find(
      (f) => f.id === docState.activeFileId,
    );
    let contextLabel: string | null = null;

    if (contextOverride) {
      contextLabel = chatContextItems(contextOverride)
        .map((context) => context.label)
        .join(", ");
    } else if (activeFile) {
      const selRange = docState.selectionRange;
      if (selRange && activeFile.content) {
        const content = activeFile.content;
        const startLC = offsetToLineCol(content, selRange.start);
        const endLC = offsetToLineCol(content, selRange.end);
        contextLabel = `@${activeFile.relativePath}:${startLC.line}:${startLC.col}-${endLC.line}:${endLC.col}`;
      }
    }

    // Add user message to the list for display (with context label visible)
    const displayText = contextLabel
      ? `${contextLabel}\n${userPrompt}`
      : userPrompt;
    const contextImageDataUrls = chatContextItems(contextOverride).flatMap(
      (context) => [
        ...(context.imageDataUrl ? [context.imageDataUrl] : []),
        ...(context.imageDataUrls ?? []),
      ],
    );
    const userMessage: AgentStreamMessage = {
      type: "user",
      sentAt: Date.now(),
      provider: selectedProvider,
      message: {
        content: [
          { type: "text", text: displayText },
          ...contextImageDataUrls.map(
            (imageDataUrl, index): ContentBlock => ({
              type: "image",
              imageDataUrl,
              alt:
                contextImageDataUrls.length === 1
                  ? (contextLabel ?? "Attached image")
                  : `${contextLabel ?? "Attached image"} ${index + 1}`,
            }),
          ),
        ],
      },
    };

    // Auto-set tab title from first prompt
    const isFirstMessage =
      activeTab && activeTab.messages.length === 0 && !activeTab.history?.total;
    const tabTitle = isFirstMessage
      ? userPrompt.slice(0, 40) + (userPrompt.length > 40 ? "..." : "")
      : undefined;

    set((s) => {
      const tabUpdates: Partial<TabState> = {
        promptQueuePaused: false,
        lastActivityAt: Math.floor(Date.now() / 1000),
        messages: [
          ...(s.tabs.find((t) => t.id === activeTabId)?.messages ?? []),
          ...(retryPausedRequest ? [] : [userMessage]),
        ],
        isStreaming: true,
        roundTiming: {
          elapsedMs: 0,
          runningSince: Date.now(),
          waitingFor: [],
          startIndex:
            (activeTab.history?.start ?? 0) + activeTab.messages.length,
        },
        turnPhase: "preparing",
        pauseState: null,
        pausedRequest: { prompt: userPrompt, context: contextOverride },
        retryRequest: {
          prompt: userPrompt,
          context: structuredClone(
            contextOverride ?? getCurrentSelectionDraftContext() ?? [],
          ),
          provider: selectedProvider,
        },
        error: null,
        pendingFileBaseline: null,
        pendingClaudeExecutionMode: executionMode,
        agentWorkspace: resumableAgentWorkspace,
        cancelledByUser: false,
        pendingQuestion: null,
      };
      if (tabTitle) tabUpdates.title = tabTitle;
      return applyTabUpdate(s, activeTabId, tabUpdates);
    });
    onAccepted?.();
    await syncTabToSharedSession(activeTabId, get, set);

    const stopBeforeLaunch = async (
      workspace?: AgentWorkspaceSession | null,
    ) => {
      const tab = get().tabs.find((item) => item.id === activeTabId);
      if (!tab || (!tab.cancelledByUser && tab.pauseState !== "pausing"))
        return false;
      if (tab.pauseState === "pausing") {
        get()._setStreaming(activeTabId, false);
        return true;
      }
      // Stop during preparation never launches a provider. Retain any existing
      // proposal for review, just as a stopped running turn does.
      set((state) => applyTabUpdate(state, activeTabId, { isSettling: true }));
      get()._setStreaming(activeTabId, false);
      try {
        const draft = workspace ?? tab.agentWorkspace;
        if (draft) {
          get()._setAgentWorkspace(activeTabId, draft);
          const reconciliation = await reconcileAgentWorkspace(
            draft.projectRoot,
            draft.sessionId,
            "cancelled",
          );
          const { useAgentReviewQueueStore } = await import(
            "./agent-review-queue-store"
          );
          get()._setAgentWorkspace(activeTabId, reconciliation.session);
          if (reconciliation.changes.length) {
            await useAgentReviewQueueStore
              .getState()
              .enqueue(reconciliation.session);
          } else {
            await retireAgentDraft(reconciliation.session);
            await useAgentReviewQueueStore.getState().finish(draft.sessionId);
          }
        }
        await get()._syncSharedSession(activeTabId);
      } catch (error) {
        get()._setError(
          activeTabId,
          `The agent stopped, but its draft could not be prepared for review. Your work is preserved. ${String(error)}`,
        );
      } finally {
        set((state) =>
          applyTabUpdate(state, activeTabId, { isSettling: false }),
        );
      }
      return true;
    };
    if (await stopBeforeLaunch()) return;

    const workspaceMode = executionMode === "edit" ? "edit" : "ask";
    let agentWorkspace: AgentWorkspaceSession | null = null;
    try {
      // New drafts must start from saved source, not an unsaved-buffer overlay.
      // An active draft continuation keeps its existing isolated workspace.
      let savedSource = docState;
      const startIsCurrent = () => {
        const tab = get().tabs.find((tab) => tab.id === activeTabId);
        return (
          tab?.isStreaming &&
          !tab.cancelledByUser &&
          tab.runtimeSessionKey === runtimeSessionKey
        );
      };
      if (!resumableAgentWorkspace) {
        await showDocumentWorkspaceForTab(activeTab);
        const source = useDocumentStore.getState();
        if (source.projectRoot !== projectPath)
          throw new Error("The project changed before saving. Try again.");
        if (!source.agentWorkspaceRoot)
          await source.saveAllFiles({ requireClean: true });
        if (
          get().tabs.find((tab) => tab.id === activeTabId)?.cancelledByUser &&
          (await stopBeforeLaunch())
        )
          return;
        const saved = useDocumentStore.getState();
        if (
          saved.projectRoot !== projectPath ||
          (saved.sourceViewSnapshot?.files ?? saved.files).some(
            (file) => file.isDirty || file.externalChange,
          )
        )
          throw new Error("The source changed while saving. Try again.");
        if (!startIsCurrent()) throw new Error("Agent startup was cancelled.");
        savedSource = {
          ...saved,
          files: saved.sourceViewSnapshot?.files ?? saved.files,
        };
      }
      agentWorkspace =
        resumableAgentWorkspace ??
        (await prepareAgentWorkspace(
          projectPath,
          activeTabId,
          get().tabs.find((tab) => tab.id === activeTabId)?.sharedSessionId ??
            null,
          workspaceMode,
          [],
        ));
      if (
        get().tabs.find((tab) => tab.id === activeTabId)?.cancelledByUser &&
        (await stopBeforeLaunch(agentWorkspace))
      )
        return;
      const currentDocument = useDocumentStore.getState();
      const sourceFiles = new Map(
        (
          currentDocument.sourceViewSnapshot?.files ?? currentDocument.files
        ).map((file) => [file.absolutePath, file]),
      );
      if (
        !resumableAgentWorkspace &&
        (!startIsCurrent() ||
          sourceFiles.size !== savedSource.files.length ||
          savedSource.files.some(
            (file) =>
              !sourceFiles.has(file.absolutePath) ||
              sourceFiles.get(file.absolutePath)?.content !== file.content ||
              sourceFiles.get(file.absolutePath)?.isDirty,
          ))
      ) {
        await retireAgentDraft(agentWorkspace);
        agentWorkspace = null;
        throw new Error(
          "Agent startup was cancelled or the source changed while preparing the draft. Try again.",
        );
      }
      if (useDocumentStore.getState().projectRoot !== projectPath) {
        await retireAgentDraft(agentWorkspace);
        set((current) =>
          applyTabUpdate(current, activeTabId, {
            isStreaming: false,
            pauseState: null,
            turnPhase: null,
            pausedRequest: null,
            pendingClaudeExecutionMode: null,
            agentVerificationContext: null,
            cancelledByUser: false,
          }),
        );
        return;
      }
      const preparedWorkspace = agentWorkspace;
      set((current) =>
        applyTabUpdate(current, activeTabId, {
          agentWorkspace: preparedWorkspace,
        }),
      );
      if (useDocumentStore.getState().projectRoot !== projectPath) {
        await retireAgentDraft(preparedWorkspace);
        set((current) =>
          applyTabUpdate(current, activeTabId, {
            isStreaming: false,
            pauseState: null,
            turnPhase: null,
            pausedRequest: null,
            pendingClaudeExecutionMode: null,
            agentVerificationContext: null,
            cancelledByUser: false,
          }),
        );
        return;
      }
      const preparedTab = get().tabs.find((tab) => tab.id === activeTabId);
      if (get().activeTabId === activeTabId && preparedTab) {
        await showDocumentWorkspaceForTab(preparedTab);
      }
    } catch (error) {
      log.error("Failed to prepare isolated agent workspace", {
        error: String(error),
      });
      set((current) =>
        applyTabUpdate(current, activeTabId, {
          isStreaming: false,
          turnPhase: null,
          pauseState: activeTab.pauseState === "paused" ? "paused" : null,
          error: `Could not create an isolated agent workspace: ${String(error)}`,
          pendingClaudeExecutionMode: null,
          agentVerificationContext: null,
          cancelledByUser: false,
        }),
      );
      if (activeTab.pauseState === "paused" && resumableAgentWorkspace) return;
      if (agentWorkspace) {
        try {
          const reconciliation = await reconcileAgentWorkspace(
            projectPath,
            agentWorkspace.sessionId,
            "failed",
          );
          if (reconciliation.changes.length === 0) {
            const { useAgentReviewQueueStore } = await import(
              "./agent-review-queue-store"
            );
            await retireAgentDraft(reconciliation.session);
            await useAgentReviewQueueStore
              .getState()
              .finish(agentWorkspace.sessionId);
          } else {
            set((current) =>
              applyTabUpdate(current, activeTabId, {
                agentWorkspace: reconciliation.session,
              }),
            );
            const { useAgentReviewQueueStore } = await import(
              "./agent-review-queue-store"
            );
            await useAgentReviewQueueStore
              .getState()
              .enqueue(reconciliation.session);
          }
        } catch (cleanupError) {
          const { useAgentReviewQueueStore } = await import(
            "./agent-review-queue-store"
          );
          await useAgentReviewQueueStore
            .getState()
            .recoverRefinement(agentWorkspace.sessionId);
          log.error("Failed to retain workspace after setup error", {
            error: String(cleanupError),
          });
        }
      }
      return;
    }
    if (!agentWorkspace) return;
    if (await stopBeforeLaunch(agentWorkspace)) return;
    const agentProjectPath = agentWorkspace.candidateRoot;

    // Build prompt with full context for the selected provider
    // Pi expands skills only at the beginning of its input. Keep the marker
    // outside the shared context wrappers; Pi owns lookup and expansion.
    const piSkillCommand =
      selectedProvider === "pi"
        ? userPrompt.match(/^\/skill:\S+/)?.[0]
        : undefined;
    let prompt = formatChatPrompt(
      piSkillCommand
        ? userPrompt.slice(piSkillCommand.length).trimStart()
        : userPrompt,
      activeFile?.relativePath,
      contextOverride ?? getCurrentSelectionDraftContext() ?? undefined,
    );
    const previousReview =
      [...activeTab.messages]
        .reverse()
        .find((message) => message.subtype === "draft_review_decisions") ??
      activeTab.history?.latestReview;
    if (previousReview) {
      const decisions = previousReview.message?.content
        ?.filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
      prompt = `The user's most recent settled draft decisions (rejected proposals were not applied):\n${decisions}\n\n${prompt}`;
    }
    if (refinementInstructions)
      prompt = `${refinementInstructions}\n\nUser feedback:\n${prompt}`;
    const providerSyncCursor =
      activeTab?.providerSyncCursors[selectedProvider] ?? 0;
    const unseenProviderTranscript = activeTab.history?.writable
      ? (activeTab.history.transcript ?? "")
      : activeTab
        ? buildCrossProviderTranscript(
            retryPausedRequest
              ? activeTab.messages.slice(0, -1)
              : activeTab.messages,
            providerSyncCursor,
          )
        : "";
    if (unseenProviderTranscript) {
      prompt = [
        "The following is prior chat history imported from another LLM session.",
        "Use it as context and continue the conversation naturally.",
        "",
        "[Imported history]",
        unseenProviderTranscript,
        "",
        "[Latest user message]",
        prompt,
      ].join("\n");
    }
    const settings = useSettingsStore.getState();
    // The provider retains this first-turn context in its native session history.
    // Instruction edits affect new sessions, never an existing conversation.
    const providerSessionId =
      selectedProvider === "codex" ? codexThreadId : sessionId;
    const globalPrompt = settings.globalAgentPrompt.trim();
    if (!providerSessionId && globalPrompt) {
      prompt = [
        "[Agent instructions]",
        `[Global]\n${globalPrompt}`,
        "[User/context prompt]",
        prompt,
      ].join("\n\n");
    }
    if (piSkillCommand) prompt = `${piSkillCommand} ${prompt}`;
    const verificationContext = (() => {
      const resolved = resolveCompileTarget(
        docState.activeFileId,
        docState.files,
      );
      if (!resolved) return null;
      const rootFile = docState.files.find(
        (file) => file.id === resolved.rootId,
      );
      const detectedEngine = rootFile?.content
        ? detectTexEngineFromContent(rootFile.content)
        : null;
      const { backend, engine, autoEngine } =
        settings.initializeCompilerChoiceForRoot(
          projectPath,
          resolved.rootId,
          detectedEngine,
        );
      return {
        rootId: resolved.rootId,
        targetPath: resolved.targetPath,
        backend,
        engine,
        autoEngine,
      };
    })();
    set((current) =>
      applyTabUpdate(current, activeTabId, {
        agentVerificationContext: verificationContext,
      }),
    );
    const invocationMode =
      selectedProvider === "codex"
        ? codexThreadId
          ? "resume"
          : "new"
        : sessionId
          ? "resume"
          : "new";
    log.info("invoking CLI", {
      promptLength: prompt.length,
      mode: invocationMode,
    });

    try {
      if (await stopBeforeLaunch(agentWorkspace)) return;
      set((current) =>
        applyTabUpdate(current, activeTabId, { turnPhase: "starting" }),
      );
      if (selectedProvider === "claude") {
        const claudeModel = selectedClaudeModel;
        const modelInfo = findClaudeModel(
          mergeClaudeModels(
            useClaudeSetupStore.getState().models,
            useSettingsStore.getState().customModels,
          ),
          claudeModel,
        );
        const supportedEfforts = claudeModelEfforts(modelInfo);
        const claudeEffort = modelInfo
          ? supportedEfforts.includes(effortLevel)
            ? effortLevel
            : supportedEfforts[0]
          : effortLevel;
        if (sessionId) {
          await invoke(harnessCommand("claude", "resume"), {
            projectPath: agentProjectPath,
            sourceProjectPath: projectPath,
            sessionId,
            prompt,
            tabId: activeTabId,
            runtimeSessionKey,
            model: claudeModel,
            effortLevel: claudeEffort,
            compileContext: verificationContext,
          });
        } else {
          await invoke(harnessCommand("claude", "execute"), {
            projectPath: agentProjectPath,
            sourceProjectPath: projectPath,
            prompt,
            tabId: activeTabId,
            runtimeSessionKey,
            model: claudeModel,
            effortLevel: claudeEffort,
            compileContext: verificationContext,
          });
        }
      } else if (selectedProvider === "pi") {
        const piModel = findPiModel(
          usePiSetupStore.getState().models,
          selectedPiModel,
        );
        if (!piModel)
          throw new Error("Choose an available Pi model before sending.");
        await invoke(harnessCommand("pi", sessionId ? "resume" : "execute"), {
          piConfig: piConfigFromSettings(),
          projectPath: agentProjectPath,
          sourceProjectPath: projectPath,
          runtimeSessionKey,
          sessionId,
          prompt,
          tabId: activeTabId,
          model: selectedPiModel,
          reasoningEffort: resolvePiThinkingLevel(
            piModel,
            selectedPiReasoningEffort,
          ),
          compileContext: verificationContext,
        });
      } else {
        const codexModel = selectedCodexModel;
        if (codexThreadId) {
          await invoke(harnessCommand("codex", "resume"), {
            projectPath: agentProjectPath,
            sourceProjectPath: projectPath,
            runtimeSessionKey,
            sessionId: codexThreadId,
            prompt,
            tabId: activeTabId,
            model: codexModel,
            reasoningEffort: selectedCodexReasoningEffort,
            fastMode: selectedCodexFastMode,
            compileContext: verificationContext,
          });
        } else {
          await invoke(harnessCommand("codex", "execute"), {
            projectPath: agentProjectPath,
            sourceProjectPath: projectPath,
            runtimeSessionKey,
            prompt,
            tabId: activeTabId,
            model: codexModel,
            reasoningEffort: selectedCodexReasoningEffort,
            fastMode: selectedCodexFastMode,
            compileContext: verificationContext,
          });
        }
      }
      set((current) => {
        const tab = current.tabs.find((item) => item.id === activeTabId);
        return applyTabUpdate(current, activeTabId, {
          turnPhase: tab?.isStreaming ? "running" : null,
          pausedRequest: null,
        });
      });
      // A stop/pause during native startup is delivered after the turn exists.
      const startedTab = get().tabs.find((item) => item.id === activeTabId);
      if (
        startedTab?.isStreaming &&
        (startedTab.pauseState === "pausing" || startedTab.cancelledByUser)
      ) {
        await get()._cancelExecutionForTab(activeTabId);
      }
      if (activeTab?.pendingCrossProviderTranscript) {
        set((s) =>
          applyTabUpdate(s, activeTabId, {
            pendingCrossProviderTranscript: null,
          }),
        );
      }
      log.info(
        `sendPrompt complete in ${(performance.now() - sendStart).toFixed(0)}ms`,
      );
    } catch (err: any) {
      log.error(
        `sendPrompt failed after ${(performance.now() - sendStart).toFixed(0)}ms`,
        { error: String(err) },
      );
      set((s) =>
        applyTabUpdate(s, activeTabId, {
          isStreaming: false,
          turnPhase: null,
          pauseState: activeTab.pauseState === "paused" ? "paused" : null,
          error: err?.message || String(err),
          pendingFileBaseline: null,
          pendingClaudeExecutionMode: null,
          agentVerificationContext: null,
          cancelledByUser: false,
        }),
      );
      if (activeTab.pauseState === "paused" && resumableAgentWorkspace) return;
      try {
        const reconciliation = await reconcileAgentWorkspace(
          projectPath,
          agentWorkspace.sessionId,
          "failed",
        );
        if (reconciliation.changes.length === 0) {
          const { useAgentReviewQueueStore } = await import(
            "./agent-review-queue-store"
          );
          await retireAgentDraft(reconciliation.session);
          await useAgentReviewQueueStore
            .getState()
            .finish(agentWorkspace.sessionId);
        } else {
          set((current) =>
            applyTabUpdate(current, activeTabId, {
              agentWorkspace: reconciliation.session,
            }),
          );
          const { useAgentReviewQueueStore } = await import(
            "./agent-review-queue-store"
          );
          await useAgentReviewQueueStore
            .getState()
            .enqueue(reconciliation.session);
        }
      } catch (reconcileError) {
        const { useAgentReviewQueueStore } = await import(
          "./agent-review-queue-store"
        );
        await useAgentReviewQueueStore
          .getState()
          .recoverRefinement(agentWorkspace.sessionId);
        log.error("Failed to reconcile workspace after launch error", {
          error: String(reconcileError),
        });
      }
    }
  },

  pauseExecution: async (tabId) => {
    const { tabs } = get();
    const activeTabId = tabId ?? get().activeTabId;
    const tab = tabs.find((item) => item.id === activeTabId);
    if (
      !tab?.isStreaming ||
      tab.pauseState === "pausing" ||
      tab.cancelledByUser
    )
      return;
    set((state) =>
      applyTabUpdate(state, activeTabId, {
        pauseState: "pausing",
        promptQueuePaused: true,
        error: null,
      }),
    );
    // Preparation can pause locally; native startup is interrupted after its acknowledgement.
    if (tab.turnPhase === "preparing" || tab.turnPhase === "starting") return;
    await get()._cancelExecutionForTab(activeTabId);
  },

  _cancelExecutionForTab: async (tabId) => {
    const tab = get().tabs.find((item) => item.id === tabId);
    if (
      !tab?.isStreaming ||
      (!tab.cancelledByUser && tab.pauseState !== "pausing")
    )
      return;
    set((state) => applyTabUpdate(state, tabId, { cancelledByUser: true }));
    try {
      await invoke(harnessCommand(tab.provider, "cancel"), { tabId });
    } catch (error) {
      const current = get().tabs.find((item) => item.id === tabId);
      if (
        current?.isStreaming &&
        (current.cancelledByUser || current.pauseState === "pausing")
      ) {
        set((state) =>
          applyTabUpdate(state, tabId, {
            pauseState: null,
            cancelledByUser: false,
            error: `Could not ${tab.pauseState === "pausing" ? "pause" : "stop"} the agent. Try again. ${String(error)}`,
          }),
        );
      }
    }
  },

  continueExecution: async () => {
    const state = get();
    const tab = state.tabs.find((item) => item.id === state.activeTabId);
    if (
      !tab ||
      !useSettingsStore.getState().enabledProviders[tab.provider] ||
      isNewChatTab(tab) ||
      tab.isStreaming ||
      tab.turnPhase === "starting" ||
      tab.pauseState !== "paused"
    )
      return;
    set((current) =>
      applyTabUpdate(current, tab.id, { promptQueuePaused: false }),
    );
    if (tab.pausedRequest) {
      await state.sendPrompt(
        tab.pausedRequest.prompt,
        tab.pausedRequest.context ?? [],
        true,
        undefined,
        tab.id,
      );
    } else {
      // An explicit empty context prevents Send's live-selection fallback.
      // Newly attached badges remain in the draft for the next explicit Send.
      await state.sendPrompt("Continue", [], false, undefined, tab.id);
    }
  },

  cancelExecution: async () => {
    const { activeTabId, tabs } = get();
    const tab = tabs.find((item) => item.id === activeTabId);
    if (
      !tab?.isStreaming ||
      tab.cancelledByUser ||
      tab.pauseState === "pausing"
    )
      return;
    set((state) =>
      applyTabUpdate(state, activeTabId, {
        cancelledByUser: true,
        promptQueuePaused: true,
        error: null,
      }),
    );
    if (tab.turnPhase === "preparing" || tab.turnPhase === "starting") return;
    await get()._cancelExecutionForTab(activeTabId);
    // Keep the tab streaming until the provider's completion event arrives so
    // the shared post-completion path can reconcile and retain the draft.
  },

  clearMessages: () => {
    const { activeTabId, tabs } = get();
    if (
      tabs.some((tab) => tab.id === activeTabId && tab.queuedPrompts?.length)
    ) {
      get()._setError(
        activeTabId,
        "Send or remove queued prompts before clearing this chat.",
      );
      return;
    }
    if (tabs.find((tab) => tab.id === activeTabId)?.agentWorkspace) {
      set((state) =>
        applyTabUpdate(state, activeTabId, {
          error:
            "Finish reviewing the current agent draft before clearing this chat.",
        }),
      );
      return;
    }
    set((s) =>
      applyTabUpdate(s, activeTabId, {
        roundTiming: null,
        messages: [],
        history: undefined,
        pendingReviewDecisions: undefined,
        pauseState: null,
        turnPhase: null,
        pausedRequest: null,
        pendingCrossProviderTranscript: null,
        error: null,
        pendingClaudeExecutionMode: null,
        agentWorkspace: null,
        totalInputTokens: 0,
        totalOutputTokens: 0,
      }),
    );
  },

  newSession: () => {
    log.info("Starting new session");
    const { activeTabId, tabs } = get();
    if (
      tabs.some((tab) => tab.id === activeTabId && tab.queuedPrompts?.length)
    ) {
      get()._setError(
        activeTabId,
        "Send or remove queued prompts before replacing this chat.",
      );
      return;
    }
    if (
      useDocumentStore.getState().projectRoot &&
      tabs.find((tab) => tab.id === activeTabId)?.agentWorkspace
    ) {
      set((state) =>
        applyTabUpdate(state, activeTabId, {
          error:
            "Finish reviewing the current agent draft before starting a new chat.",
        }),
      );
      return;
    }
    set((s) =>
      applyTabUpdate(s, activeTabId, {
        ...permissionDefaults(),
        runtimeSessionKey: nextRuntimeSessionKey(),
        pauseState: null,
        turnPhase: null,
        pausedRequest: null,
        roundTiming: null,
        messages: [],
        history: undefined,
        pendingReviewDecisions: undefined,
        pendingQuestion: null,
        sessionId: null,
        sharedSessionId: null,
        providerSessionIds: {},
        providerSyncCursors: {},
        pendingCrossProviderTranscript: null,
        error: null,
        isStreaming: false,
        pendingClaudeExecutionMode: null,
        agentWorkspace: null,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        title: "New Chat",
      }),
    );
  },

  resumeSession: async (sharedSessionId: string, options = {}) => {
    const currentState = get();
    if (
      currentState.tabs.some(
        (tab) =>
          tab.id === currentState.activeTabId && tab.queuedPrompts?.length,
      )
    ) {
      get()._setError(
        currentState.activeTabId,
        "Open a new chat or remove queued prompts before loading another session.",
      );
      return;
    }
    const activeProvider = currentState.selectedProvider;
    const { activeTabId } = currentState;
    const projectPath = useDocumentStore.getState().projectRoot;
    if (!projectPath) {
      set((s) =>
        applyTabUpdate(s, activeTabId, {
          error: "No project open",
        }),
      );
      return;
    }

    let session: SharedSessionPayload;
    try {
      session = await invoke<SharedSessionPayload>("load_shared_session", {
        projectPath,
        sharedSessionId,
      });
    } catch (err) {
      log.error("Failed to load shared session", { error: String(err) });
      set((s) =>
        applyTabUpdate(s, activeTabId, {
          error: "Failed to load session",
        }),
      );
      return;
    }

    const sessionProvider =
      options.sessionProvider ?? normalizeChatProvider(session.last_provider);
    const useSessionLlm = options.useSessionLlm ?? false;
    const targetProvider = useSessionLlm ? sessionProvider : activeProvider;
    await disposeHarnesses(activeTabId);
    const providerSessionIds = restoreProviderState(
      session.provider_session_ids,
      null,
      sessionProvider,
      0,
    ).providerSessionIds;
    const targetSessionId = providerSessionIds[targetProvider] ?? null;

    const sharedClaudeModel = normalizeClaudeModel(session.last_claude_model);
    const sharedCodexModel = normalizeCodexModel(session.last_codex_model);
    if (useSessionLlm) {
      if (sessionProvider === "pi") {
        set({
          selectedPiModel:
            options.sessionPiModel ??
            session.last_pi_model ??
            useSettingsStore.getState().defaultPiModel,
        });
      } else if (sessionProvider === "claude") {
        set({
          selectedClaudeModel:
            options.sessionClaudeModel ??
            sharedClaudeModel ??
            useSettingsStore.getState().defaultClaudeModel,
        });
      } else {
        set({
          selectedCodexModel:
            options.sessionCodexModel ??
            sharedCodexModel ??
            useSettingsStore.getState().defaultCodexModel,
        });
      }
    }

    const messages = rehydrateGeneratedImageMessages(
      session.messages.filter(
        (m) =>
          m.type === "user" ||
          m.type === "assistant" ||
          m.type === "result" ||
          m.subtype === "draft_review_decisions",
      ),
    );
    const transcriptCount = handoffMessageCount(messages);
    const providerSyncCursors = restoreProviderState(
      session.provider_session_ids,
      session.provider_sync_cursors,
      sessionProvider,
      transcriptCount,
    ).providerSyncCursors;

    set((s) =>
      applyTabUpdate(s, activeTabId, {
        runtimeSessionKey: nextRuntimeSessionKey(),
        pauseState: null,
        turnPhase: null,
        pausedRequest: null,
        provider: targetProvider,
        title: session.title?.trim() || "New Chat",
        lastActivityAt: session.last_modified,
        roundTiming: null,
        messages,
        history: undefined,
        pendingReviewDecisions: undefined,
        sessionId: targetSessionId,
        pendingQuestion: session.pending_question ?? null,
        sharedSessionId: session.shared_session_id,
        providerSessionIds,
        providerSyncCursors,
        pendingCrossProviderTranscript: null,
        error: null,
        isStreaming: false,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        pendingResumeChoice: null,
        pendingClaudeExecutionMode: null,
      }),
    );
  },

  // ─── Tab Actions ───

  composerFocusRequestNonce: 0,
  requestNewChat: () => {
    const state = get();
    const active = state.tabs.find((tab) => tab.id === state.activeTabId);
    const draft = state.tabs.find(isNewChatTab);
    // Attachments waiting for the composer belong to the chat being left.
    if (
      active &&
      active.id !== draft?.id &&
      state.pendingAttachments.length > 0
    ) {
      state.saveDraft(active.id, {
        ...active.draft,
        pinnedContexts: [
          ...active.draft.pinnedContexts,
          ...state.pendingAttachments,
        ],
      });
      set({ pendingAttachments: [] });
    }
    const id = draft ? draft.id : get().createTab();
    if (draft) get().setActiveTab(draft.id);
    set((current) => ({
      composerFocusRequestNonce: current.composerFocusRequestNonce + 1,
    }));
    return id;
  },

  createTab: () => {
    log.debug("Creating new tab");
    const state = get();
    const id = nextTabId();
    const newTab = makeDefaultTab(id, state.selectedProvider);
    const activeTab = state.tabs.find((tab) => tab.id === state.activeTabId);
    const selectionContext =
      getPinnedSelectionContext(activeTab?.draft.pinnedContexts ?? []) ??
      getCurrentSelectionDraftContext();
    if (selectionContext) {
      newTab.draft = { input: "", pinnedContexts: [selectionContext] };
    }
    set((s) => ({
      tabs: [...s.tabs, newTab],
      activeTabId: id,
      selectedProvider: newTab.provider,
      ...tabPermissions(newTab, s),
      // Project new tab fields to top-level
      messages: newTab.messages,
      sessionId: newTab.sessionId,
      isStreaming: newTab.isStreaming,
      error: newTab.error,
      totalInputTokens: newTab.totalInputTokens,
      totalOutputTokens: newTab.totalOutputTokens,
    }));
    void showDocumentWorkspaceForTab(newTab);
    return id;
  },

  loadHistory: async (tabId, start = 0, limit) => {
    const { waitForChatCheckpointWrites } = await import(
      "@/lib/project-chat-lifecycle"
    );
    await waitForChatCheckpointWrites();
    const beforeLoad = get().tabs.find((tab) => tab.id === tabId);
    if (
      beforeLoad?.history?.writable &&
      (limit === undefined ||
        (!beforeLoad.isStreaming &&
          !beforeLoad.isSettling &&
          !beforeLoad.turnPhase))
    ) {
      const { saveProjectChats } = await import("@/lib/project-chat-lifecycle");
      await saveProjectChats();
    }
    if (
      get().tabs.find((tab) => tab.id === tabId)?.pendingReviewDecisions?.length
    ) {
      const { saveProjectChats } = await import("@/lib/project-chat-lifecycle");
      await saveProjectChats();
    }
    const state = get();
    const tab = state.tabs.find((item) => item.id === tabId);
    if (!tab?.history || !state.chatProjectRoot) return;
    if (
      tab.history.writable &&
      limit !== undefined &&
      (tab.isStreaming || tab.isSettling || tab.turnPhase)
    ) {
      if (start >= tab.history.start) return;
      // Writable suffixes must start on a persisted chunk boundary.
      start = Math.floor(start / 100) * 100;
      const older = await invoke<AgentStreamMessage[]>(
        "desktop:chat:messages",
        {
          projectRoot: state.chatProjectRoot,
          tabId,
          start,
          limit: tab.history.start - start,
        },
      );
      const current = get().tabs.find((item) => item.id === tabId);
      if (
        get().chatProjectRoot !== state.chatProjectRoot ||
        !current?.history?.writable ||
        current.history.start !== tab.history.start ||
        current.runtimeSessionKey !== tab.runtimeSessionKey
      )
        return;
      const currentHistory = current.history;
      set((value) =>
        applyTabUpdate(value, tabId, {
          messages: [
            ...rehydrateGeneratedImageMessages(older),
            ...current.messages,
          ],
          history: {
            ...currentHistory,
            start,
            prefixCount:
              (currentHistory.prefixCount ?? 0) - handoffMessageCount(older),
          },
        }),
      );
      return;
    }
    const messages = await invoke<AgentStreamMessage[]>(
      "desktop:chat:messages",
      {
        projectRoot: state.chatProjectRoot,
        tabId,
        start,
        limit: limit ?? tab.history.total,
      },
    );
    const current = get().tabs.find((item) => item.id === tabId);
    if (get().chatProjectRoot !== state.chatProjectRoot || !current)
      throw new Error("The project or chat changed while loading history.");
    if (current.runtimeSessionKey !== tab.runtimeSessionKey)
      throw new Error("The conversation changed while loading history.");
    if (current.history !== tab.history) {
      if (current.history && limit === undefined)
        await get().loadHistory(tabId);
      return;
    }
    set((value) =>
      applyTabUpdate(value, tabId, {
        messages: rehydrateGeneratedImageMessages(messages),
        history:
          start === 0 && messages.length === tab.history!.total
            ? undefined
            : { total: tab.history!.total, start },
      }),
    );
  },

  forkSessionAtMessage: async (messageIndex) => {
    const tabId = get().activeTabId;
    const conversation = get().tabs.find(
      (tab) => tab.id === tabId,
    )?.runtimeSessionKey;
    const projectRoot = get().chatProjectRoot;
    if (projectRoot) {
      const { withChatCheckpoint } = await import(
        "@/lib/project-chat-lifecycle"
      );
      return withChatCheckpoint(async () => {
        const state = get();
        const source = state.tabs.find((tab) => tab.id === tabId);
        if (
          !source ||
          source.runtimeSessionKey !== conversation ||
          state.activeTabId !== tabId ||
          state.chatProjectRoot !== projectRoot
        )
          return null;
        const id = nextTabId();
        const metadata = makeDefaultTab(id, source.provider);
        Object.assign(metadata, tabPermissions(source, state), {
          title: `${source.title.trim() || "New Chat"} (fork)`,
        });
        const fork = await invoke<TabState>("desktop:chat:fork", {
          projectRoot,
          tabId,
          runtimeSessionKey: conversation,
          messageIndex,
          tab: metadata,
        });
        if (
          get().chatProjectRoot !== projectRoot ||
          get().tabs.find((tab) => tab.id === tabId)?.runtimeSessionKey !==
            conversation
        ) {
          await invoke("desktop:chat:cancel-fork", {
            projectRoot,
            tabId: id,
            sharedSessionId: fork.sharedSessionId,
          });
          return null;
        }
        let messages: AgentStreamMessage[];
        try {
          messages = await invoke<AgentStreamMessage[]>(
            "desktop:chat:messages",
            {
              projectRoot,
              tabId: id,
              start: Math.max(0, messageIndex + 1 - 200),
              limit: 200,
            },
          );
        } catch (error) {
          await invoke("desktop:chat:cancel-fork", {
            projectRoot,
            tabId: id,
            sharedSessionId: fork.sharedSessionId,
          });
          throw error;
        }
        if (
          get().chatProjectRoot !== projectRoot ||
          get().tabs.find((tab) => tab.id === tabId)?.runtimeSessionKey !==
            conversation
        ) {
          await invoke("desktop:chat:cancel-fork", {
            projectRoot,
            tabId: id,
            sharedSessionId: fork.sharedSessionId,
          });
          return null;
        }
        const restored = {
          ...fork,
          messages: rehydrateGeneratedImageMessages(messages),
          history: {
            total: messageIndex + 1,
            start: Math.max(0, messageIndex + 1 - 200),
          },
        };
        set((current) => ({
          tabs: [...discardEmptyNewChats(current.tabs), restored],
        }));
        get().setActiveTab(id);
        window.dispatchEvent(
          new CustomEvent(SHARED_SESSION_SAVED_EVENT, {
            detail: { projectRoot },
          }),
        );
        return id;
      });
    }
    try {
      await get().loadHistory(tabId);
    } catch (error) {
      if (
        get().tabs.find((tab) => tab.id === tabId)?.runtimeSessionKey !==
        conversation
      )
        return null;
      throw error;
    }
    if (
      get().activeTabId !== tabId ||
      get().tabs.find((tab) => tab.id === tabId)?.runtimeSessionKey !==
        conversation
    )
      return null;
    const state = get();
    const sourceTab = state.tabs.find((tab) => tab.id === state.activeTabId);
    const forkPoint = sourceTab?.messages[messageIndex];
    if (
      !sourceTab ||
      !forkPoint ||
      (forkPoint.type !== "assistant" && forkPoint.type !== "result")
    ) {
      return null;
    }

    const id = nextTabId();
    const forkedTab = makeDefaultTab(id, sourceTab.provider);
    Object.assign(forkedTab, tabPermissions(sourceTab, state));
    forkedTab.title = `${sourceTab.title.trim() || "New Chat"} (fork)`;
    forkedTab.messages = sourceTab.messages
      .slice(0, messageIndex + 1)
      .map((message) => ({
        ...message,
        message: message.message
          ? {
              ...message.message,
              content: message.message.content?.map((block) => ({ ...block })),
            }
          : undefined,
      }));

    // A fork intentionally has no provider runtime IDs. Its first prompt starts
    // a fresh runtime and imports the copied transcript as context, leaving the
    // source conversation untouched.
    set((current) => ({
      tabs: [...discardEmptyNewChats(current.tabs), forkedTab],
      activeTabId: id,
      selectedProvider: forkedTab.provider,
      ...tabPermissions(forkedTab, current),
      messages: forkedTab.messages,
      sessionId: null,
      isStreaming: false,
      error: null,
      totalInputTokens: 0,
      totalOutputTokens: 0,
    }));
    void showDocumentWorkspaceForTab(forkedTab);
    void syncTabToSharedSession(id, get, set);
    return id;
  },

  updateSessionArchive: (sharedSessionId, archived, restoredTab) => {
    let tabs = get().tabs.map((tab) =>
      tab.sharedSessionId === sharedSessionId ? { ...tab, archived } : tab,
    );
    if (
      !archived &&
      restoredTab &&
      !tabs.some((tab) => tab.sharedSessionId === sharedSessionId)
    )
      tabs = [...tabs, restoredTab];
    set({ tabs });
    const activeIndex = tabs.findIndex((tab) => tab.id === get().activeTabId);
    if (tabs[activeIndex]?.archived) {
      const next =
        tabs.slice(activeIndex + 1).find((tab) => !tab.archived) ??
        tabs
          .slice(0, activeIndex)
          .reverse()
          .find((tab) => !tab.archived);
      if (next) get().setActiveTab(next.id);
      else get().createTab();
    }
  },

  archiveTab: async (tabId) => {
    const { useAgentReviewQueueStore } = await import(
      "./agent-review-queue-store"
    );
    const { usePausedReviewStore } = await import("./paused-review-store");
    const reviewPhases = (candidate: TabState) =>
      useAgentReviewQueueStore
        .getState()
        .entries.filter((entry) => entry.session.tabId === candidate.id)
        .map((entry) => entry.phase);
    const tab = get().tabs.find((item) => item.id === tabId);
    if (
      !tab ||
      usePausedReviewStore.getState().busy ||
      !isChatArchiveEligible(tab, {
        isNewChat: isNewChatTab(tab),
        reviewPhases: reviewPhases(tab),
      }) ||
      (tab.agentWorkspace && tab.pauseState !== "paused") ||
      (tab.pauseState !== "paused" && getUnansweredQuestion(tab))
    )
      return;
    const projectPath = useDocumentStore.getState().projectRoot;
    if (!projectPath) return;
    // A stopped refinement is interruptible history, not an active review.
    if (tab.pauseState === "paused") get()._finishRoundTiming(tabId);
    await syncTabToSharedSession(tabId, get, set, true);
    const current = get().tabs.find((item) => item.id === tabId);
    if (
      !current ||
      usePausedReviewStore.getState().busy ||
      current.runtimeSessionKey !== tab.runtimeSessionKey ||
      useDocumentStore.getState().projectRoot !== projectPath ||
      !isChatArchiveEligible(current, {
        reviewPhases: reviewPhases(current),
      }) ||
      (current.agentWorkspace && current.pauseState !== "paused") ||
      (current.pauseState !== "paused" && getUnansweredQuestion(current))
    )
      return;
    if (current.sharedSessionId) {
      set((state) => applyTabUpdate(state, tabId, { isSettling: true }));
      try {
        if (current.pauseState === "paused") {
          const { useAgentQuestionStore } = await import(
            "./agent-question-store"
          );
          const queue = useAgentReviewQueueStore.getState();
          const workspaces = new Map(
            [
              current.agentWorkspace,
              ...(usePausedReviewStore.getState().backups[tabId] ?? []),
              ...queue.entries
                .filter((entry) => entry.session.tabId === tabId)
                .map((entry) => entry.session),
            ]
              .filter((session): session is AgentWorkspaceSession =>
                Boolean(session),
              )
              .map((session) => [session.sessionId, session]),
          );
          // Release idle provider handles before deleting their working directory.
          await disposeHarnesses(tabId);
          // Keep the resumable draft until every backup was successfully removed.
          const cleanupOrder = [...workspaces.values()].sort(
            (left, right) =>
              Number(left.sessionId === current.agentWorkspace?.sessionId) -
              Number(right.sessionId === current.agentWorkspace?.sessionId),
          );
          for (const session of cleanupOrder) {
            if (
              useDocumentStore.getState().projectRoot !== projectPath ||
              get().tabs.find((item) => item.id === tabId)
                ?.runtimeSessionKey !== current.runtimeSessionKey
            )
              throw new Error(
                "The chat changed before its draft could be discarded.",
              );
            await retireAgentDraft(session);
            if (
              useDocumentStore.getState().projectRoot !== projectPath ||
              get().tabs.find((item) => item.id === tabId)
                ?.runtimeSessionKey !== current.runtimeSessionKey
            )
              throw new Error(
                "The chat changed while its draft was being discarded.",
              );
            usePausedReviewStore.setState((state) => ({
              backups: {
                ...state.backups,
                [tabId]: (state.backups[tabId] ?? []).filter(
                  (backup) => backup.sessionId !== session.sessionId,
                ),
              },
            }));
          }
          usePausedReviewStore.setState((state) => ({
            pending: { ...state.pending, [tabId]: undefined },
          }));
          useAgentQuestionStore.setState((state) => ({
            questions: state.questions.filter(
              (question) => question.tabId !== tabId,
            ),
          }));
          set((state) =>
            applyTabUpdate(state, tabId, {
              pauseState: null,
              pausedRequest: null,
              retryRequest: null,
              pendingQuestion: null,
              turnPhase: null,
              cancelledByUser: false,
            }),
          );
          for (const entry of queue.entries) {
            if (entry.session.tabId === tabId)
              await queue.finish(entry.session.sessionId);
          }
          // Persist the cleaned transcript before publishing the archived flag.
          await syncTabToSharedSession(tabId, get, set, true);
          const { saveProjectChats } = await import(
            "@/lib/project-chat-lifecycle"
          );
          await saveProjectChats();
        }
        await invoke("set_shared_session_archived", {
          projectPath,
          sharedSessionId: current.sharedSessionId,
          archived: true,
        });
        if (useDocumentStore.getState().projectRoot !== projectPath) return;
        get().updateSessionArchive(current.sharedSessionId, true);
      } finally {
        set((state) => applyTabUpdate(state, tabId, { isSettling: false }));
      }
    } else {
      if (
        current.messages.length ||
        current.draft.input.length ||
        current.draft.pinnedContexts.length
      )
        throw new Error("Could not save this chat before archiving.");
      if (get().tabs.filter((item) => !item.archived).length === 1)
        get().createTab();
      get().closeTab(tabId);
    }
  },

  closeTab: (tabId: string) => {
    const state = get();
    const tab = state.tabs.find((t) => t.id === tabId);
    // Keep an isolated workspace reachable until it has been settled.
    if (tab?.isStreaming || tab?.agentWorkspace || tab?.queuedPrompts?.length)
      return;
    // Prevent closing the last tab
    if (state.tabs.length <= 1) return;
    void disposeHarnesses(tabId);

    const idx = state.tabs.findIndex((t) => t.id === tabId);
    if (idx === -1) return;

    const newTabs = state.tabs.filter((t) => t.id !== tabId);

    if (tabId === state.activeTabId) {
      // Switch to adjacent tab
      const newIdx = Math.min(idx, newTabs.length - 1);
      const newActive =
        newTabs.slice(newIdx).find((item) => !item.archived) ??
        newTabs.find((item) => !item.archived);
      if (!newActive) return;
      set({
        tabs: newTabs,
        activeTabId: newActive.id,
        selectedProvider: newActive.provider,
        ...tabPermissions(newActive, state),
        // Project new active tab
        messages: newActive.messages,
        sessionId: newActive.sessionId,
        isStreaming: newActive.isStreaming,
        error: newActive.error,
        totalInputTokens: newActive.totalInputTokens,
        totalOutputTokens: newActive.totalOutputTokens,
      });
      void showDocumentWorkspaceForTab(newActive);
    } else {
      set({ tabs: newTabs });
    }
  },

  setActiveTab: (tabId: string, finishSessionLoad = false) => {
    let state = get();
    if (tabId === state.activeTabId) {
      if (finishSessionLoad)
        set({ tabs: discardEmptyNewChats(state.tabs, tabId) });
      return;
    }
    const targetTab = state.tabs.find((t) => t.id === tabId);
    if (!targetTab) return;

    if (state.pendingAttachments.length > 0) {
      const source = state.tabs.find((tab) => tab.id === state.activeTabId);
      if (source)
        state.saveDraft(source.id, {
          ...source.draft,
          pinnedContexts: [
            ...source.draft.pinnedContexts,
            ...state.pendingAttachments,
          ],
        });
      set({ pendingAttachments: [] });
      state = get();
    }
    // Project the target tab's fields to top-level
    set({
      tabs: discardEmptyNewChats(state.tabs, tabId),
      activeTabId: tabId,
      selectedProvider: targetTab.provider,
      ...tabPermissions(targetTab, state),
      messages: targetTab.messages,
      sessionId: targetTab.sessionId,
      isStreaming: targetTab.isStreaming,
      error: targetTab.error,
      totalInputTokens: targetTab.totalInputTokens,
      totalOutputTokens: targetTab.totalOutputTokens,
    });
    void showDocumentWorkspaceForTab(targetTab).then(() =>
      get()._runNextQueuedPrompt(tabId),
    );
  },

  saveDraft: (tabId: string, draft: TabDraft) => {
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, draft } : t)),
    }));
  },

  // ─── Internal Actions (routed by explicit tabId) ───

  _rememberQuestion: (question) => {
    const tab = get().tabs.find((tab) => tab.id === question.tabId);
    if (
      !tab?.isStreaming ||
      tab.cancelledByUser ||
      tab.runtimeSessionKey !== question.sessionId ||
      useDocumentStore.getState().projectRoot !== question.projectRoot
    )
      return;
    const {
      requestId,
      projectRoot,
      question: text,
      options,
      details,
    } = question;
    set((state) =>
      applyTabUpdate(state, question.tabId, {
        pendingQuestion: {
          requestId,
          projectRoot,
          question: text,
          options,
          details,
        },
        lastActivityAt: Math.floor(Date.now() / 1000),
      }),
    );
    void syncTabToSharedSession(question.tabId, get, set);
  },

  _answerRestoredQuestion: async (tabId, requestId, answer) => {
    const tab = get().tabs.find((tab) => tab.id === tabId);
    const question = tab && getUnansweredQuestion(tab);
    if (
      !tab ||
      isNewChatTab(tab) ||
      tab.isStreaming ||
      get().activeTabId !== tabId ||
      question?.requestId !== requestId ||
      !answer.trim() ||
      question.projectRoot !== useDocumentStore.getState().projectRoot
    )
      throw new Error("This saved question is no longer active.");
    await get().sendPrompt(
      `Answer to your pending question:\n${question.question}\n\nMy answer: ${answer.trim()}\n\nContinue from this answer. Recheck the current document before applying any pending changes or comments.`,
      undefined,
      false,
      undefined,
      tabId,
    );
    const current = get().tabs.find((tab) => tab.id === tabId);
    if (current && getUnansweredQuestion(current)?.requestId === requestId)
      throw new Error(
        current.error ?? "Could not continue the chat. Try again.",
      );
  },

  _answerQuestion: async (question, answer) => {
    const { tabId, sessionId, projectRoot, requestId } = question;
    const tab = get().tabs.find((tab) => tab.id === tabId);
    const uuid = `question-answer-${requestId}`;
    if (
      !tab?.isStreaming ||
      tab.cancelledByUser ||
      tab.runtimeSessionKey !== sessionId ||
      useDocumentStore.getState().projectRoot !== projectRoot ||
      tab.messages.some((message) => message.uuid === uuid)
    )
      throw new Error(
        "This question is no longer active or is already being answered.",
      );

    get()._setRoundWaiting(tabId, requestId, false);
    // Insert before IPC: the waiting provider can resume before its acknowledgement.
    // This is visible user input, but not a new provider turn/start.
    get()._appendMessage(tabId, {
      type: "user",
      uuid,
      subtype: "question_answer",
      sentAt: Date.now(),
      message: { content: [{ type: "text", text: answer.trim() }] },
    });
    try {
      await invoke("answer_agent_question", {
        requestId,
        tabId,
        sessionId,
        answer,
      });
      // Status must survive unloading the transcript. Clear only this answered
      // question: the provider may already have asked another before replying.
      set((state) => {
        const current = state.tabs.find((tab) => tab.id === tabId);
        if (
          current?.runtimeSessionKey !== sessionId ||
          current.pendingQuestion?.requestId !== requestId
        )
          return {};
        return applyTabUpdate(state, tabId, { pendingQuestion: null });
      });
    } catch (error) {
      set((state) => {
        const current = state.tabs.find((tab) => tab.id === tabId);
        if (current?.runtimeSessionKey !== sessionId) return {};
        return applyTabUpdate(state, tabId, {
          roundTiming: current.roundTiming
            ? {
                ...freezeRound(current.roundTiming),
                waitingFor: [
                  ...new Set([...current.roundTiming.waitingFor, requestId]),
                ],
              }
            : null,
          messages: current.messages.filter((message) => message.uuid !== uuid),
        });
      });
      throw error;
    } finally {
      if (
        useDocumentStore.getState().projectRoot === projectRoot &&
        get().tabs.find((tab) => tab.id === tabId)?.runtimeSessionKey ===
          sessionId
      )
        await syncTabToSharedSession(tabId, get, set);
    }
  },

  _recordReviewDecision: async (tabId, message) => {
    const tab = get().tabs.find((item) => item.id === tabId);
    if (!tab || !message.uuid || !get().chatProjectRoot)
      throw new Error("The review chat is unavailable.");
    // A completion save may still be assigning the shared-session ID. Keep the
    // compatibility record attached to that session without loading its history.
    const sharedWrite = sharedSessionWrites.get(
      `${get().chatProjectRoot}:${tab.runtimeSessionKey}`,
    );
    if (sharedWrite) await sharedWrite;
    const current = get().tabs.find((item) => item.id === tabId);
    if (!current || current.runtimeSessionKey !== tab.runtimeSessionKey)
      throw new Error("The review conversation changed.");
    set((state) =>
      applyTabUpdate(state, tabId, {
        pendingReviewDecisions: [
          ...(current.pendingReviewDecisions ?? []).filter(
            (item) => item.uuid !== message.uuid,
          ),
          message,
        ],
      }),
    );
    const { saveProjectChats } = await import("@/lib/project-chat-lifecycle");
    await saveProjectChats();
  },

  _appendMessage: (tabId: string, msg: AgentStreamMessage) => {
    set((state) => {
      let inputDelta = 0;
      let outputDelta = 0;
      const usage = msg.usage || msg.message?.usage;
      if (usage) {
        inputDelta = usage.input_tokens || 0;
        outputDelta = usage.output_tokens || 0;
      }

      const tab = state.tabs.find((t) => t.id === tabId);
      if (!tab) return {};

      return applyTabUpdate(state, tabId, {
        messages: [
          ...tab.messages,
          { ...msg, provider: msg.provider ?? tab.provider },
        ],
        ...(["user", "assistant", "result"].includes(msg.type)
          ? { lastActivityAt: Math.floor(Date.now() / 1000) }
          : {}),
        totalInputTokens: tab.totalInputTokens + inputDelta,
        totalOutputTokens: tab.totalOutputTokens + outputDelta,
      });
    });
  },

  _applyActivity: (tabId: string, activity: AgentActivity) => {
    set((state) => {
      const tab = state.tabs.find((item) => item.id === tabId);
      if (!tab) return {};

      const messages = applyActivityToMessages(
        tab.messages,
        activity,
        tab.provider,
      );
      return applyTabUpdate(state, tabId, {
        messages,
        ...(messages !== tab.messages
          ? { lastActivityAt: Math.floor(Date.now() / 1000) }
          : {}),
      });
    });
  },

  _setSessionId: (tabId: string, id: string) => {
    set((state) => {
      const tab = state.tabs.find((t) => t.id === tabId);
      if (!tab) return {};
      return applyTabUpdate(state, tabId, {
        sessionId: id,
        contextUsage:
          tab.providerSessionIds[tab.provider] === id
            ? tab.contextUsage
            : { ...tab.contextUsage, [tab.provider]: undefined },
        providerSessionIds: {
          ...tab.providerSessionIds,
          [tab.provider]: id,
        },
      });
    });
    void syncTabToSharedSession(tabId, get, set);
  },

  _markProviderSynced: (tabId: string, provider: ChatProvider) => {
    set((state) => {
      const tab = state.tabs.find((item) => item.id === tabId);
      if (!tab) return {};
      return applyTabUpdate(state, tabId, {
        retryRequest: null,
        providerSyncCursors: {
          ...tab.providerSyncCursors,
          [provider]:
            (tab.history?.prefixCount ?? 0) + handoffMessageCount(tab.messages),
        },
      });
    });
  },

  _setRoundWaiting: (tabId, requestId, waiting) => {
    set((state) => {
      const tab = state.tabs.find((item) => item.id === tabId);
      const timing = tab?.roundTiming;
      if (!tab?.isStreaming || !timing || timing.finished) return {};
      const waitingFor = waiting
        ? [...new Set([...timing.waitingFor, requestId])]
        : timing.waitingFor.filter((id) => id !== requestId);
      return applyTabUpdate(state, tabId, {
        roundTiming: waiting
          ? { ...freezeRound(timing), waitingFor }
          : {
              ...timing,
              waitingFor,
              runningSince:
                waitingFor.length === 0 && !tab.isSettling
                  ? (timing.runningSince ?? Date.now())
                  : null,
            },
      });
    });
  },

  _finishRoundTiming: (tabId) => {
    set((state) => {
      const tab = state.tabs.find((item) => item.id === tabId);
      if (!tab?.roundTiming || tab.roundTiming.finished) return {};
      const completedAt = Date.now();
      const timing = freezeRound(tab.roundTiming, completedAt);
      return applyTabUpdate(state, tabId, {
        roundTiming: { ...timing, finished: true },
        messages: stampRoundDuration(
          tab.messages,
          timing.startIndex - (tab.history?.start ?? 0),
          timing.elapsedMs,
          completedAt,
        ),
      });
    });
  },

  _setStreaming: (tabId: string, streaming: boolean, interrupted = false) => {
    set((state) => {
      const tab = state.tabs.find((item) => item.id === tabId);
      return applyTabUpdate(state, tabId, {
        isStreaming: streaming,
        ...(streaming
          ? {}
          : {
              pendingClaudeExecutionMode: null,
              cancelledByUser: false,
              agentVerificationContext: null,
              ...(tab?.cancelledByUser && !tab.pauseState
                ? { pendingQuestion: null, retryRequest: null }
                : {}),
              pauseState: interrupted || tab?.pauseState ? "paused" : null,
              turnPhase: tab?.turnPhase === "starting" ? "starting" : null,
              ...(interrupted || !tab?.pauseState
                ? { pausedRequest: null }
                : {}),
            }),
      });
    });
  },

  _recordContextUsage: (tabId, provider, message) => {
    set((state) => {
      const tab = state.tabs.find((item) => item.id === tabId);
      if (!tab || tab.provider !== provider || !tab.isStreaming) return state;
      const usage = readAgentContextUsage(
        provider,
        message,
        tab.contextUsage?.[provider],
      );
      if (!usage) return state;
      return applyTabUpdate(state, tabId, {
        contextUsage: { ...tab.contextUsage, [provider]: usage },
      });
    });
  },

  _setProviderStatus: (tabId, provider, status) => {
    set((state) => {
      const tab = state.tabs.find((item) => item.id === tabId);
      if (!tab || tab.provider !== provider) return state;
      if (
        status &&
        (!tab.isStreaming ||
          tab.isSettling ||
          tab.pauseState ||
          tab.cancelledByUser ||
          tab.error)
      )
        return state;
      if (tab.providerStatus === status) return state;
      return applyTabUpdate(state, tabId, { providerStatus: status });
    });
  },

  _finishCompaction: (tabId, success) => {
    const tab = get().tabs.find((item) => item.id === tabId);
    if (!tab?.compacting) return;
    const completed =
      success && !tab.cancelledByUser && !tab.pauseState && !tab.error;
    set((state) =>
      applyTabUpdate(state, tabId, {
        compacting: false,
        roundTiming: null,
        isStreaming: false,
        turnPhase: null,
        providerStatus: null,
        pauseState: null,
        cancelledByUser: false,
        promptQueuePaused: !completed,
        error: completed
          ? null
          : (tab.error ?? "Compaction stopped. The follow-up remains queued."),
      }),
    );
    if (completed) void get()._runNextQueuedPrompt(tabId);
  },

  _setError: (tabId: string, error: string | null) => {
    set((state) => applyTabUpdate(state, tabId, { error }));
  },

  _recoverError: (tabId, expectedError) => {
    set((state) => {
      const tab = state.tabs.find((item) => item.id === tabId);
      if (
        !tab ||
        state.activeTabId !== tabId ||
        tab.error !== expectedError ||
        tab.isStreaming ||
        tab.isSettling ||
        tab.turnPhase === "starting"
      )
        return {};
      // A rejected launch is still an unsent request. Preserve any newer draft.
      const request = tab.pauseState ? null : tab.pausedRequest;
      const draft =
        request && !tab.draft.input.trim() && !tab.draft.pinnedContexts.length
          ? {
              input: request.prompt,
              pinnedContexts: chatContextItems(
                tab.retryRequest?.context ?? request.context,
              ),
            }
          : tab.draft;
      return applyTabUpdate(state, tabId, {
        error: null,
        retryRequest: null,
        pausedRequest: tab.pauseState ? tab.pausedRequest : null,
        draft,
      });
    });
  },

  _setPendingFileBaseline: (tabId: string, baseline) => {
    set((state) =>
      applyTabUpdate(state, tabId, { pendingFileBaseline: baseline }),
    );
  },

  _retireLegacyWorkspace: (tabId) => {
    set((state) => {
      const tab = state.tabs.find((item) => item.id === tabId);
      if (!tab || (tab.agentWorkspace && tab.agentWorkspace.version !== 1))
        return state;
      return applyTabUpdate(state, tabId, {
        agentWorkspace: null,
        pauseState: null,
        pausedRequest: null,
        pendingResumeChoice: null,
        pendingFileBaseline: null,
        pendingClaudeExecutionMode: null,
        retryRequest: null,
        agentVerificationContext: null,
        pendingQuestion: null,
        pendingReviewDecisions: [],
        isStreaming: false,
        isSettling: false,
        turnPhase: null,
        roundTiming: tab.roundTiming
          ? { ...freezeRound(tab.roundTiming), finished: true, waitingFor: [] }
          : null,
      });
    });
  },
  _setAgentWorkspace: (tabId: string, workspace) => {
    set((state) => applyTabUpdate(state, tabId, { agentWorkspace: workspace }));
  },

  _detachProjectAgentWorkspaces: (projectRoot) => {
    const affected = get().tabs.filter(
      (tab) => tab.agentWorkspace?.projectRoot === projectRoot,
    );
    for (const tab of affected) {
      get()._finishRoundTiming(tab.id);
      if (tab.isStreaming) {
        void invoke(harnessCommand(tab.provider, "cancel"), {
          tabId: tab.id,
        }).catch(() => undefined);
      }
    }
    set((state) => {
      const affectedIds = new Set(affected.map((tab) => tab.id));
      const tabs = state.tabs.map((tab) =>
        affectedIds.has(tab.id)
          ? {
              ...tab,
              agentWorkspace: null,
              isStreaming: false,
              pendingClaudeExecutionMode: null,
              agentVerificationContext: null,
              cancelledByUser: false,
            }
          : tab,
      );
      const activeWasAffected = affectedIds.has(state.activeTabId);
      return {
        tabs,
        ...(activeWasAffected ? { isStreaming: false } : {}),
      };
    });
  },

  _syncSharedSession: async (tabId: string) => {
    await syncTabToSharedSession(tabId, get, set);
  },
}));
