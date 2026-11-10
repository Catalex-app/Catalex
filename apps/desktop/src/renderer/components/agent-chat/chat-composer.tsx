import { useLibraryPromptsExpanded } from "@/hooks/use-library-prompts-expanded";
import { PromptSuggestions } from "./prompt-suggestions";
import { PRODUCT_NAME } from "../../../branding";
import { isPromptSelection } from "@/lib/prompt-library";
import { usePiSetupStore } from "@/stores/pi-setup-store";
import {
  findPiModel,
  initialPiModelValue,
  piModelThinkingLevels,
  resolvePiThinkingLevel,
  piModelLabel,
  piModelValue,
} from "@/lib/pi-models";
import { isComposingKey, consumeKey } from "@/lib/keyboard-events";
import { EDIT_ICON_PATHS } from "@/lib/edit-icon";
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { QueuedPromptRow } from "./queued-prompt-row";
import { ChatImagePreview } from "./chat-image-preview";
import { getAssetUrl } from "@/lib/project-files";
import { usePopupExit } from "@/components/ui/use-popup-exit";
import { ModelPickerTransition } from "./model-picker-transition";
import { ModelDescription } from "./model-description";
import { Progress } from "@/components/ui/progress";
import {
  readSubscriptionUsage,
  type SubscriptionWindow,
} from "@/lib/subscription-usage";
import { ARTISAN_MODE_REQUEST_EVENT } from "@/lib/workspace-events";
import { useSettingsStore } from "@/stores/settings-store";
import { ChatErrorPanel } from "./chat-error-panel";
import { ChatErrorRecovery } from "./chat-error-recovery";
import { CodexSessionRecovery } from "./codex-session-recovery";
import { ComposerErrorPreviewContext } from "./composer-error-preview-context";
import { useAgentReviewQueueStore } from "@/stores/agent-review-queue-store";
import {
  captureProposedDraft,
  isEarlierDraftContext,
  isSelectionRangeContextLabel,
  isSameSelectionContext,
} from "@/lib/chat-context";
export { isSelectionRangeContextLabel } from "@/lib/chat-context";
import { useProjectComments } from "@/components/workspace/editor/use-project-comments";
import { commentsInSelection } from "@/lib/comment-chat-context";
import { ContextBadgeList, type ChatContextBadge } from "./context-badge-list";
import { Hint } from "@/components/ui/tooltip";
import { SettingsSwitch } from "@/components/settings/settings-switch";
import {
  PopupSurface,
  PopupHeader,
  PopupSeparator,
} from "@/components/ui/popup-surface";
import { ButtonGroup } from "@/components/ui/button-group";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { toast } from "sonner";
import {
  useClaudeModels,
  useCodexModels,
  usePiModels,
} from "@/lib/use-agent-models";
import { formatCodexModelName, codexEffortLabel } from "@/lib/codex-models";
import { AGENT_EXECUTION_MODES } from "@/lib/agent-execution-mode";
import {
  type FC,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  ArrowUpIcon,
  ZapIcon,
  LockKeyholeIcon,
  SquareIcon,
  PlayIcon,
  LoaderCircleIcon,
  XIcon,
  FileTextIcon,
  FileCodeIcon,
  FileIcon,
  ImageIcon,
  FileSpreadsheetIcon,
  PaperclipIcon,
  PinIcon,
  CheckIcon,
  ChevronDownIcon,
  MinusIcon,
  PlusIcon,
  ShieldCheckIcon,
  Settings2Icon,
  BotMessageSquareIcon,
} from "lucide-react";
import { getCurrentWebview } from "@/lib/desktop/webview";
import { invoke } from "@/lib/desktop/core";
import {
  useAgentChatStore,
  type ClaudeModelId,
  type AgentExecutionMode,
  type CodexModelId,
  type CodexReasoningEffort,
  type ChatProvider,
  offsetToLineCol,
} from "@/stores/agent-chat-store";
import { useDocumentStore, type ProjectFile } from "@/stores/document-store";
import {
  claudeModelLabel,
  claudeModelEfforts,
  findClaudeModel,
  type ClaudeEffortLevel,
  type ClaudeModelInfo,
} from "@/lib/claude-models";
import { useClaudeSetupStore } from "@/stores/claude-setup-store";
import { useCodexSetupStore } from "@/stores/codex-setup-store";
import { isNativeDropPointInsideElement } from "@/lib/desktop/native-drop";
import { TooltipIconButton } from "@/components/assistant-ui/tooltip-icon-button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  SlashCommandPicker,
  commandSyntaxForProvider,
  type SlashCommand,
} from "./slash-command-picker";
import { createLogger } from "@/lib/debug/logger";
import {
  SELECTION_OWNER_EVENT,
  PDF_COMMENT_NAVIGATE_EVENT,
} from "@/lib/workspace-events";
import {
  AgentQuestionPrompt,
  useActiveAgentQuestion,
} from "./agent-question-prompt";

const log = createLogger("chat-composer");

// Re-export for other modules
export type { SlashCommand };

type PinnedContext = ChatContextBadge;

export interface SelectionContextLabelParts {
  filePath: string;
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
}

export interface SelectionContextTarget {
  fileId: string;
  filePath: string;
  start: number;
  end: number;
}

function pinnedContextsEqual(a: PinnedContext[], b: PinnedContext[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((context, index) => {
    const other = b[index];
    return (
      context.label === other?.label &&
      context.filePath === other.filePath &&
      context.selectedText === other.selectedText &&
      context.imageDataUrl === other.imageDataUrl &&
      context.selectionPinned === other.selectionPinned &&
      context.selectionKey === other.selectionKey &&
      JSON.stringify(context.pdf) === JSON.stringify(other.pdf) &&
      JSON.stringify(context.proposedDraft) ===
        JSON.stringify(other.proposedDraft) &&
      context.comment?.id === other.comment?.id &&
      context.comment?.agent === other.comment?.agent &&
      JSON.stringify(context.comment) === JSON.stringify(other.comment)
    );
  });
}

export function parseSelectionContextLabel(
  label: string,
): SelectionContextLabelParts | null {
  const match = label.match(
    /^(?:PDF p\.\d+ · )?@(.+):(\d+):(\d+)-(\d+):(\d+)(?: · PDF p\.\d+)?$/,
  );
  if (!match) return null;

  const [, filePath, startLine, startCol, endLine, endCol] = match;
  return {
    filePath,
    startLine: Number(startLine),
    startCol: Number(startCol),
    endLine: Number(endLine),
    endCol: Number(endCol),
  };
}

function lineColToOffset(
  content: string,
  lineNumber: number,
  colNumber: number,
): number | null {
  const lines = content.split("\n");
  const lineIndex = lineNumber - 1;
  const line = lines[lineIndex];
  if (line === undefined) return null;
  const colIndex = colNumber - 1;
  if (colIndex < 0 || colIndex > line.length) return null;
  let offset = colIndex;
  for (let index = 0; index < lineIndex; index += 1) {
    offset += lines[index].length + 1;
  }
  return offset;
}

export function resolveSelectionContextTarget(
  context: Pick<PinnedContext, "label" | "filePath"> & Partial<PinnedContext>,
  files: ProjectFile[],
): SelectionContextTarget | null {
  const parsed = parseSelectionContextLabel(context.label);
  if (!parsed) return null;

  const file = files.find(
    (candidate) =>
      candidate.relativePath === parsed.filePath ||
      candidate.relativePath === context.filePath ||
      candidate.id === parsed.filePath ||
      candidate.id === context.filePath,
  );
  if (!file?.content) return null;
  if (
    context.proposedDraft &&
    isEarlierDraftContext(
      context as PinnedContext,
      useDocumentStore.getState().agentWorkspaceSessionId,
      file.content,
    )
  )
    return null;

  const start = lineColToOffset(
    file.content,
    parsed.startLine,
    parsed.startCol,
  );
  const end = lineColToOffset(file.content, parsed.endLine, parsed.endCol);
  if (start === null || end === null || start >= end) return null;

  return {
    fileId: file.id,
    filePath: file.relativePath,
    start,
    end,
  };
}

function getFileIcon(file: ProjectFile) {
  if (file.type === "image")
    return <ImageIcon className="size-3.5 shrink-0 text-muted-foreground" />;
  if (file.type === "pdf")
    return (
      <FileSpreadsheetIcon className="size-3.5 shrink-0 text-muted-foreground" />
    );
  if (file.type === "csv")
    return (
      <FileSpreadsheetIcon className="size-3.5 shrink-0 text-muted-foreground" />
    );
  if (file.type === "style")
    return <FileCodeIcon className="size-3.5 shrink-0 text-muted-foreground" />;
  if (file.type === "other")
    return <FileIcon className="size-3.5 shrink-0 text-muted-foreground" />;
  return <FileTextIcon className="size-3.5 shrink-0 text-muted-foreground" />;
}

function codexModelLabel(model: CodexModelId | null): string {
  return model ? formatCodexModelName(model) : "GPT-5.4";
}

function llmConfigLabel(
  provider: ChatProvider,
  claudeModel: ClaudeModelId | null,
  codexModel: CodexModelId | null,
  effortLevel?: ClaudeEffortLevel,
  codexReasoningEffort?: CodexReasoningEffort,
  executionMode?: AgentExecutionMode,
  claudeModels: ClaudeModelInfo[] = [],
  piModel?: string | null,
): string {
  if (provider === "pi") return piModelLabel(piModel ?? null);
  const base =
    provider === "claude"
      ? claudeModelLabel(claudeModel, claudeModels)
      : codexModelLabel(codexModel);
  if (provider === "claude" && effortLevel) {
    const effort = `${base} • ${claudeEffortLabel(effortLevel)} effort`;
    return executionMode && executionMode !== "default"
      ? `${effort} • ${AGENT_EXECUTION_MODES[executionMode].label}`
      : effort;
  }
  if (provider === "codex" && codexReasoningEffort) {
    const effort = `${base} • ${codexEffortLabel(codexReasoningEffort)} effort`;
    return executionMode && executionMode !== "default"
      ? `${effort} • ${AGENT_EXECUTION_MODES[executionMode].label}`
      : effort;
  }
  return base;
}

function claudeEffortLabel(level: string): string {
  if (level === "xhigh") return "Extra High";
  if (level === "low") return "Low";
  if (level === "medium") return "Medium";
  if (level === "high") return "High";
  return level
    .split(/[-_]/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function nextExecutionMode(mode: AgentExecutionMode): AgentExecutionMode {
  if (mode === "default") return "edit";
  return "default";
}

function hasHiddenDirectory(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, "/");
  const parts = normalized.split("/").filter((part) => part.length > 0);
  return parts.slice(0, -1).some((part) => part.startsWith("."));
}

function getMentionFileTypeRank(file: ProjectFile): number {
  switch (file.type) {
    case "tex":
      return 0;
    case "bib":
      return 1;
    case "style":
      return 2;
    case "csv":
      return 3;
    case "other":
      return 4;
    case "pdf":
      return 5;
    case "image":
      return 6;
  }
}

function compareMentionFiles(a: ProjectFile, b: ProjectFile): number {
  const typeDiff = getMentionFileTypeRank(a) - getMentionFileTypeRank(b);
  if (typeDiff !== 0) return typeDiff;
  return a.relativePath.localeCompare(b.relativePath);
}

export function getMentionFileMatches(
  files: ProjectFile[],
  mentionQuery: string,
): ProjectFile[] {
  const q = mentionQuery.toLowerCase();
  return files
    .filter(
      (f) =>
        !hasHiddenDirectory(f.relativePath) &&
        (f.relativePath.toLowerCase().includes(q) ||
          f.name.toLowerCase().includes(q)),
    )
    .sort(compareMentionFiles);
}

function effortShortLabel(level: string): string {
  if (level === "off") return "Off";
  if (level === "low") return "L";
  if (level === "medium") return "M";
  if (level === "xhigh") return "XH";
  if (level === "high") return "H";
  if (level === "ultra") return "U";
  if (level === "max") return "Max";
  return level.slice(0, 2).toUpperCase();
}

function providerBadgeClasses(provider: ChatProvider): string {
  return provider === "pi"
    ? "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-300"
    : provider === "codex"
      ? "border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-900/60 dark:bg-blue-950/40 dark:text-blue-300"
      : "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-300";
}

export const ChatComposer: FC<{
  isOpen?: boolean;
  isExpanded?: boolean;
  acceptPendingAttachments?: boolean;
}> = ({ isOpen, isExpanded, acceptPendingAttachments = true }) => {
  const isCollapsed = !isOpen && !isExpanded;
  const renderErrorPreview = useContext(ComposerErrorPreviewContext);
  const composerError = useAgentChatStore((s) => s.error);
  const { question: activeQuestion } = useActiveAgentQuestion();
  const sendPrompt = useAgentChatStore((s) => s.sendPrompt);
  const reviewEntries = useAgentReviewQueueStore((s) => s.entries);
  const sendBlockedReason = useAgentChatStore((s) => {
    const tab = s.tabs.find((item) => item.id === s.activeTabId);
    if (s.isLeavingProject) return "Wait for the project to finish closing.";
    if (tab?.isStreaming || tab?.isSettling || tab?.turnPhase) return null;
    if (tab?.agentWorkspace && tab.agentWorkspace.status !== "active") {
      const entry = reviewEntries.find(
        (entry) => entry.session.sessionId === tab.agentWorkspace?.sessionId,
      );
      if (entry?.phase !== "review")
        return "This draft is waiting in the review queue or needs a source check.";
    }
    return null;
  });
  const cancelExecution = useAgentChatStore((s) => s.cancelExecution);
  const continueExecution = useAgentChatStore((s) => s.continueExecution);
  const pauseState = useAgentChatStore(
    (s) => s.tabs.find((tab) => tab.id === s.activeTabId)?.pauseState,
  );
  const isStarting = useAgentChatStore(
    (s) =>
      s.tabs.find((tab) => tab.id === s.activeTabId)?.turnPhase === "starting",
  );
  const isStreaming = useAgentChatStore((s) => s.isStreaming);
  const queueTab = useAgentChatStore((s) =>
    s.tabs.find((tab) => tab.id === s.activeTabId),
  );
  const promptsPinned = useSettingsStore((s) => s.keepMiniPromptsOpen);
  const promptsExpanded = useLibraryPromptsExpanded(queueTab, promptsPinned);
  const queuedPrompts = queueTab?.queuedPrompts ?? [];
  const hasQueuedPrompts = queuedPrompts.length > 0;
  const queueSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );
  const isBusy = isStreaming || isStarting || !!queueTab?.isSettling;
  const queueWaiting =
    !!queueTab?.promptQueuePaused || !!pauseState || !!queueTab?.error;
  const selectedProvider = useAgentChatStore((s) => s.selectedProvider);
  const setProvider = useAgentChatStore((s) => s.setProvider);
  const selectedClaudeModel = useAgentChatStore((s) => s.selectedClaudeModel);
  const setSelectedClaudeModel = useAgentChatStore(
    (s) => s.setSelectedClaudeModel,
  );
  const selectedClaudeExecutionMode = useAgentChatStore(
    (s) => s.selectedClaudeExecutionMode,
  );
  const setSelectedClaudeExecutionMode = useAgentChatStore(
    (s) => s.setSelectedClaudeExecutionMode,
  );
  const selectedPiModel = useAgentChatStore((s) => s.selectedPiModel);
  const setSelectedPiModel = useAgentChatStore((s) => s.setSelectedPiModel);
  const selectedPiReasoningEffort = useAgentChatStore(
    (s) => s.selectedPiReasoningEffort,
  );
  const setSelectedPiReasoningEffort = useAgentChatStore(
    (s) => s.setSelectedPiReasoningEffort,
  );
  const selectedPiExecutionMode = useAgentChatStore(
    (s) => s.selectedPiExecutionMode,
  );
  const setSelectedPiExecutionMode = useAgentChatStore(
    (s) => s.setSelectedPiExecutionMode,
  );
  const selectedCodexModel = useAgentChatStore((s) => s.selectedCodexModel);
  const selectedCodexFastMode = useAgentChatStore(
    (s) => s.selectedCodexFastMode,
  );
  const setSelectedCodexFastMode = useAgentChatStore(
    (s) => s.setSelectedCodexFastMode,
  );
  const setSelectedCodexModel = useAgentChatStore(
    (s) => s.setSelectedCodexModel,
  );
  const selectedCodexReasoningEffort = useAgentChatStore(
    (s) => s.selectedCodexReasoningEffort,
  );
  const setSelectedCodexReasoningEffort = useAgentChatStore(
    (s) => s.setSelectedCodexReasoningEffort,
  );
  const selectedCodexExecutionMode = useAgentChatStore(
    (s) => s.selectedCodexExecutionMode,
  );
  const setSelectedCodexExecutionMode = useAgentChatStore(
    (s) => s.setSelectedCodexExecutionMode,
  );
  const pendingResumeChoice = useAgentChatStore(
    (s) =>
      s.tabs.find((tab) => tab.id === s.activeTabId)?.pendingResumeChoice ??
      null,
  );
  const resolvePendingResumeChoice = useAgentChatStore(
    (s) => s.resolvePendingResumeChoice,
  );
  const claudeReady = useClaudeSetupStore((s) => s.status === "ready");
  const codexReady = useCodexSetupStore((s) => s.status === "ready");
  const discoveredClaudeModels = useClaudeModels();
  const claudeModelsStatus = useClaudeSetupStore((s) => s.modelsStatus);
  const claudeModelsError = useClaudeSetupStore((s) => s.modelsError);
  const refreshClaudeModels = useClaudeSetupStore((s) => s.refreshModels);
  const claudeModelOptions = useMemo(() => {
    return discoveredClaudeModels.map((model) => ({
      id: model.value,
      name: claudeModelLabel(model.value, discoveredClaudeModels),
      desc: model.description || "Available from your Claude Code CLI",
      modelId: model.resolvedModel || model.value,
    }));
  }, [discoveredClaudeModels]);
  const selectedClaudeModelInfo = findClaudeModel(
    discoveredClaudeModels,
    selectedClaudeModel,
  );
  const claudeModelsReady = !!selectedClaudeModelInfo;
  const claudePickerLabel =
    claudeModelsStatus === "error" && !claudeModelsReady
      ? "Model loading failed"
      : claudeModelsReady
        ? claudeModelLabel(selectedClaudeModel, discoveredClaudeModels)
        : claudeModelsStatus === "ready"
          ? "Choose a model"
          : "Loading models…";
  const claudeEffortOptions = useMemo(
    () => claudeModelEfforts(selectedClaudeModelInfo),
    [selectedClaudeModelInfo],
  );
  const discoveredCodexModels = useCodexModels();
  const codexModelsStatus = useCodexSetupStore((s) => s.modelsStatus);
  const codexModelsError = useCodexSetupStore((s) => s.modelsError);
  const refreshCodexModels = useCodexSetupStore((s) => s.refreshModels);
  const claudeSetupError = useClaudeSetupStore((s) => s.error);
  const codexSetupError = useCodexSetupStore((s) => s.error);
  const claudeSetupStatus = useClaudeSetupStore((s) => s.status);
  const codexSetupStatus = useCodexSetupStore((s) => s.status);
  const pi = usePiSetupStore();
  const piReady = pi.status === "ready";
  const discoveredPiModels = usePiModels();
  const piModelInfo = findPiModel(discoveredPiModels, selectedPiModel);
  const piEffortOptions = piModelInfo?.reasoning
    ? piModelThinkingLevels(piModelInfo)
    : [];
  const piEffort = resolvePiThinkingLevel(
    piModelInfo,
    selectedPiReasoningEffort,
  );
  const piModelsReady = pi.modelsStatus === "ready" && !!piModelInfo;
  const piPickerLabel =
    pi.modelsStatus === "error"
      ? "Model loading failed"
      : piModelsReady
        ? piModelLabel(selectedPiModel, discoveredPiModels)
        : pi.modelsStatus === "ready"
          ? "Choose a model"
          : "Loading models…";
  const piModelOptions = discoveredPiModels.map((model) => ({
    id: piModelValue(model),
    name: model.name || model.id,
    desc: model.provider,
    modelId: model.id,
  }));
  const heldErrors = useRef<Record<string, string | null>>({});
  const holdError = (key: string, value: string | null, checking: boolean) => {
    if (!checking || value) heldErrors.current[key] = value;
    return value ?? (checking ? heldErrors.current[key] : null) ?? null;
  };
  const setupError = holdError(
    `${selectedProvider}:setup`,
    selectedProvider === "pi"
      ? pi.error
      : selectedProvider === "claude"
        ? claudeSetupError
        : codexSetupError,
    (selectedProvider === "pi"
      ? pi.status
      : selectedProvider === "claude"
        ? claudeSetupStatus
        : codexSetupStatus) === "checking",
  );
  const modelError = holdError(
    `${selectedProvider}:models`,
    selectedProvider === "pi"
      ? pi.modelsError
      : selectedProvider === "claude"
        ? claudeModelsError
        : codexModelsError,
    (selectedProvider === "pi"
      ? pi.modelsStatus
      : selectedProvider === "claude"
        ? claudeModelsStatus
        : codexModelsStatus) === "loading",
  );
  const enabledProviders = useSettingsStore((s) => s.enabledProviders);
  const providerDisabled = !enabledProviders[selectedProvider];
  const noProvidersEnabled =
    !enabledProviders.claude && !enabledProviders.codex && !enabledProviders.pi;
  const multipleProvidersEnabled =
    Object.values(enabledProviders).filter(Boolean).length > 1;
  const alternativeProvider = (["codex", "claude", "pi"] as const).find(
    (provider) => provider !== selectedProvider && enabledProviders[provider],
  );
  const providerName =
    selectedProvider === "pi"
      ? "Pi"
      : selectedProvider === "claude"
        ? "Claude"
        : "Codex";
  const visibleError = providerDisabled
    ? null
    : (composerError ?? setupError ?? modelError);
  const showErrorPanel =
    Boolean(visibleError) || (providerDisabled && !isStreaming);
  const errorSource = composerError ? "chat" : setupError ? "setup" : "models";

  const checkClaudeStatus = useClaudeSetupStore((s) => s.checkStatus);
  const checkCodexStatus = useCodexSetupStore((s) => s.checkStatus);
  const effortLevel = useAgentChatStore((s) => s.effortLevel);
  const setEffortLevel = useAgentChatStore((s) => s.setEffortLevel);
  const activeTabId = useAgentChatStore((s) => s.activeTabId);
  const codexModelOptions = useMemo(() => {
    return discoveredCodexModels.map((model) => ({
      id: model.model,
      name: model.display_name || formatCodexModelName(model.model),
      desc: model.description || "Available from your Codex CLI",
    }));
  }, [discoveredCodexModels]);
  const selectedCodexModelInfo = discoveredCodexModels.find(
    (model) => model.model === selectedCodexModel,
  );
  const codexModelsReady = !!selectedCodexModelInfo;
  const modelSelectionBlocked =
    selectedProvider === "pi"
      ? !piModelsReady
      : selectedProvider === "claude"
        ? !claudeModelsReady
        : !codexModelsReady;
  const codexPickerLabel =
    codexModelsStatus === "error" && !codexModelsReady
      ? "Model loading failed"
      : codexModelsReady
        ? formatCodexModelName(selectedCodexModel)
        : codexModelsStatus === "ready"
          ? "Choose a model"
          : "Loading models…";
  const codexEffortOptions = useMemo(
    () =>
      selectedCodexModelInfo?.supported_reasoning_efforts.map(
        (effort) => effort.value,
      ) ?? [],
    [selectedCodexModelInfo],
  );
  const pickerLabel =
    selectedProvider === "pi"
      ? piPickerLabel
      : selectedProvider === "claude"
        ? claudePickerLabel
        : codexPickerLabel;
  const selectedEffort =
    selectedProvider === "pi"
      ? (piEffort ?? selectedPiReasoningEffort)
      : selectedProvider === "claude"
        ? effortLevel
        : selectedCodexReasoningEffort;
  const effortOptions =
    selectedProvider === "pi"
      ? piModelsReady
        ? piEffortOptions
        : []
      : selectedProvider === "claude"
        ? claudeEffortOptions
        : codexEffortOptions;
  const showEffort = !modelSelectionBlocked && effortOptions.length > 0;
  const modelTooltipLabel =
    selectedProvider === "claude"
      ? `${claudePickerLabel} · ${selectedClaudeModelInfo?.resolvedModel || selectedClaudeModel}`
      : pickerLabel;
  const modelTooltipEffort = showEffort
    ? claudeEffortLabel(selectedEffort)
    : null;
  const modelTooltip = modelTooltipEffort
    ? `${modelTooltipLabel} · Thinking effort: ${modelTooltipEffort}`
    : modelTooltipLabel;
  const [input, setInput] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [toolbarElement, setToolbarElement] = useState<HTMLDivElement | null>(
    null,
  );
  const [compactToolbar, setCompactToolbar] = useState(false);
  const [toolbarShortcutsOpen, setToolbarShortcutsOpen] = useState(false);
  const toolbarToggleRef = useRef<HTMLButtonElement>(null);
  const showToolbarShortcuts = !compactToolbar || toolbarShortcutsOpen;

  useLayoutEffect(() => {
    if (!toolbarElement) {
      setToolbarShortcutsOpen(false);
      return;
    }
    const shortcuts = toolbarElement.querySelector<HTMLElement>(
      "[data-composer-shortcuts]",
    );
    const controls = toolbarElement.querySelector<HTMLElement>(
      "[data-composer-controls]",
    );
    const submit = toolbarElement.querySelector<HTMLElement>(
      "[data-composer-submit]",
    );
    if (!shortcuts || !controls || !submit) return;
    const measure = () => {
      const style = getComputedStyle(toolbarElement);
      const available =
        toolbarElement.clientWidth -
        Number.parseFloat(style.paddingLeft) -
        Number.parseFloat(style.paddingRight);
      const shortcutsWidth = shortcuts.offsetWidth;
      const controlsWidth = controls.offsetWidth;
      toolbarElement.style.setProperty(
        "--composer-shortcuts-width",
        `${shortcutsWidth}px`,
      );
      toolbarElement.style.setProperty(
        "--composer-controls-width",
        `${controlsWidth}px`,
      );
      toolbarElement.style.setProperty(
        "--composer-submit-width",
        `${submit.offsetWidth}px`,
      );
      const compact = shortcutsWidth + controlsWidth + 8 > available;
      setCompactToolbar(compact);
      if (!compact) setToolbarShortcutsOpen(false);
    };
    measure();
    const observer = new ResizeObserver(measure);
    for (const element of [toolbarElement, shortcuts, controls, submit])
      observer.observe(element);
    return () => observer.disconnect();
  }, [toolbarElement]);

  // Model picker state
  const [openPicker, setOpenPicker] = useState<"model" | "permission" | null>(
    null,
  );
  const modelPickerOpen = openPicker === "model";
  const contextUsage = useAgentChatStore(
    (state) =>
      state.tabs.find((tab) => tab.id === state.activeTabId)?.contextUsage?.[
        selectedProvider
      ],
  );
  const contextPercent = contextUsage?.capacity
    ? Math.min(100, (contextUsage.tokens / contextUsage.capacity) * 100)
    : null;
  const contextTooltip = contextUsage
    ? `Context: ${contextUsage.tokens.toLocaleString()}${contextUsage.capacity ? ` / ${contextUsage.capacity.toLocaleString()}` : ""} tokens${contextPercent !== null ? ` (${Math.round(contextPercent)}% used)` : " · capacity unavailable"} · Last response`
    : "Context usage unavailable · Updates with responses";
  const contextIndicator =
    contextPercent !== null ? (
      <Hint content={contextTooltip}>
        <button
          type="button"
          aria-label={contextTooltip}
          className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <span
            aria-hidden="true"
            className="flex size-3 items-end overflow-hidden rounded-[2px] bg-muted-foreground/20"
          >
            <span
              data-context-fill=""
              className="w-full bg-current"
              style={{ height: `${contextPercent}%` }}
            />
          </span>
        </button>
      </Hint>
    ) : null;
  const [usageRefresh, setUsageRefresh] = useState(0);
  const [subscriptionUsage, setSubscriptionUsage] = useState<{
    provider: ChatProvider;
    windows: SubscriptionWindow[] | null;
  } | null>(null);
  useEffect(() => {
    if (!modelPickerOpen) return;
    let cancelled = false;
    setSubscriptionUsage(null);
    void (
      selectedProvider === "pi"
        ? Promise.resolve(null)
        : readSubscriptionUsage(selectedProvider)
    ).then(
      (windows) => {
        if (!cancelled)
          setSubscriptionUsage({ provider: selectedProvider, windows });
      },
      () => {
        if (!cancelled)
          setSubscriptionUsage({ provider: selectedProvider, windows: null });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [modelPickerOpen, selectedProvider, usageRefresh]);
  const modelPickerRef = useRef<HTMLDivElement>(null);
  const modelButtonRef = useRef<HTMLButtonElement>(null);
  const permissionPickerRef = useRef<HTMLDivElement>(null);
  const modelPickerId = useId();
  const [pickerPos, setPickerPos] = useState<{ left: number; bottom: number }>({
    left: 0,
    bottom: 0,
  });

  // Keep the popup anchored while the window is resized.
  useLayoutEffect(() => {
    if (!modelPickerOpen) return;
    const positionPicker = () => {
      const rect = modelButtonRef.current?.getBoundingClientRect();
      if (!rect) return;
      const width = modelPickerRef.current?.offsetWidth ?? 288;
      setPickerPos({
        left: Math.max(
          8,
          Math.min(
            rect.left + (rect.width - width) / 2,
            window.innerWidth - width - 8,
          ),
        ),
        bottom: window.innerHeight - rect.top + 4,
      });
    };
    positionPicker();
    window.addEventListener("resize", positionPicker);
    return () => window.removeEventListener("resize", positionPicker);
  }, [modelPickerOpen]);

  useLayoutEffect(() => {
    if (modelPickerOpen) modelPickerRef.current?.focus({ preventScroll: true });
  }, [modelPickerOpen]);

  // Pinned contexts — supports multiple files/selections
  const [pinnedContexts, setPinnedContexts] = useState<PinnedContext[]>([]);

  // File drop state
  const [isDragOver, setIsDragOver] = useState(false);

  // @ mention state
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [mentionFiles, setMentionFiles] = useState<ProjectFile[]>([]);
  const mentionRef = useRef<HTMLDivElement>(null);
  const mentionPopupRef = usePopupExit(mentionRef);
  const [mentionPickerPos, setMentionPickerPos] = useState<{
    left: number;
    right: number;
    bottom: number;
  }>({
    left: 0,
    right: 0,
    bottom: 0,
  });

  // / slash command state
  const [slashQuery, setSlashQuery] = useState<string | null>(null);
  const slashRangeRef = useRef<{ start: number; end: number } | null>(null);

  // Restore each tab’s persisted draft when switching chats.
  const prevTabIdRef = useRef(activeTabId);
  const restoringDraftRef = useRef(false);
  const savingDraftRef = useRef(false);
  const localDraftRef = useRef({ input, pinnedContexts });
  localDraftRef.current = { input, pinnedContexts };
  useEffect(() => {
    if (
      pi.modelsStatus !== "ready" ||
      (selectedPiModel && selectedPiModel !== "default")
    )
      return;
    const saved = useSettingsStore.getState().defaultPiModel;
    const next = findPiModel(discoveredPiModels, saved)
      ? saved
      : initialPiModelValue(discoveredPiModels);
    if (next) setSelectedPiModel(next);
  }, [
    pi.modelsStatus,
    discoveredPiModels,
    selectedPiModel,
    setSelectedPiModel,
  ]);

  useEffect(() => {
    if (piEffort !== undefined && piEffort !== selectedPiReasoningEffort) {
      setSelectedPiReasoningEffort(piEffort);
    }
  }, [piEffort, selectedPiReasoningEffort, setSelectedPiReasoningEffort]);

  useEffect(() => {
    if (!acceptPendingAttachments) return;
    // Draft changes are persisted below while the tab is active. Do not
    // overwrite the previous draft here; it may contain queued attachments.
    prevTabIdRef.current = activeTabId;

    restoringDraftRef.current = true;
    // Restore draft from the new active tab
    const tab = useAgentChatStore
      .getState()
      .tabs.find((t) => t.id === activeTabId);
    const draft = tab?.draft;
    setInput(draft?.input ?? "");
    setPinnedContexts(draft?.pinnedContexts ?? []);
    setMentionQuery(null);
    setSlashQuery(null);
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  }, [activeTabId, acceptPendingAttachments]);

  // Another workspace view can edit the same draft without switching chats.
  useEffect(() => {
    if (!acceptPendingAttachments) return;
    return useAgentChatStore.subscribe((state, previous) => {
      if (
        savingDraftRef.current ||
        state.activeTabId !== activeTabId ||
        previous.activeTabId !== activeTabId
      )
        return;
      const draft = state.tabs.find((tab) => tab.id === activeTabId)?.draft;
      const before = previous.tabs.find((tab) => tab.id === activeTabId)?.draft;
      if (!draft || draft === before) return;
      const local = localDraftRef.current;
      if (
        local.input === draft.input &&
        pinnedContextsEqual(local.pinnedContexts, draft.pinnedContexts)
      )
        return;
      restoringDraftRef.current = true;
      setInput(draft.input);
      setPinnedContexts(draft.pinnedContexts);
      setMentionQuery(null);
      setSlashQuery(null);
    });
  }, [activeTabId, acceptPendingAttachments]);

  useEffect(() => {
    if (!acceptPendingAttachments) return;
    if (restoringDraftRef.current) {
      restoringDraftRef.current = false;
      return;
    }
    if (prevTabIdRef.current !== activeTabId) return;
    const store = useAgentChatStore.getState();
    const tab = store.tabs.find((t) => t.id === activeTabId);
    if (!tab) return;
    if (
      tab.draft.input === input &&
      pinnedContextsEqual(tab.draft.pinnedContexts, pinnedContexts)
    )
      return;
    savingDraftRef.current = true;
    try {
      store.saveDraft(activeTabId, { input, pinnedContexts });
    } finally {
      savingDraftRef.current = false;
    }
  }, [activeTabId, input, pinnedContexts, acceptPendingAttachments]);

  const [slashCommands, setSlashCommands] = useState<SlashCommand[]>([]);
  const composerRef = useRef<HTMLDivElement>(null);
  const inputSurfaceRef = useRef<HTMLDivElement>(null);

  // Watch the live document selection independently of explicitly pinned excerpts
  const selectionRange = useDocumentStore((s) => s.selectionRange);
  const pdfSelectionContext = useDocumentStore((s) => s.pdfSelectionContext);
  const commentSelectionContext = useDocumentStore(
    (s) => s.commentSelectionContext,
  );
  const activeFileId = useDocumentStore((s) => s.activeFileId);
  const files = useDocumentStore((s) => s.files);
  const draftSessionId = useDocumentStore((s) => s.agentWorkspaceSessionId);
  const setActiveFile = useDocumentStore((s) => s.setActiveFile);
  const setSelectionRange = useDocumentStore((s) => s.setSelectionRange);
  const setSelectionPreviewRange = useDocumentStore(
    (s) => s.setSelectionPreviewRange,
  );
  const requestJumpToSelectionRange = useDocumentStore(
    (s) => s.requestJumpToSelectionRange,
  );
  const projectRoot = useDocumentStore((s) => s.projectRoot);
  const hasSavedCommentContexts = useAgentChatStore(
    (s) =>
      s.chatProjectRoot === projectRoot &&
      s.tabs.some((tab) =>
        tab.draft.pinnedContexts.some((context) => !!context.comment),
      ),
  );
  const needsComments =
    isOpen ||
    isExpanded ||
    !!selectionRange ||
    !!pdfSelectionContext ||
    !!commentSelectionContext ||
    hasSavedCommentContexts ||
    pinnedContexts.some((context) => !!context.comment);
  const [commentsByFile, , , commentsLoaded] = useProjectComments(
    needsComments ? projectRoot : null,
  );

  // Consume pending attachments from external sources (e.g. PDF capture)
  const pendingAttachments = useAgentChatStore((s) => s.pendingAttachments);
  const consumePendingAttachments = useAgentChatStore(
    (s) => s.consumePendingAttachments,
  );
  const isVisible = !!(isOpen || isExpanded);
  const queueMode = isExpanded ? "full" : isOpen ? "half" : "mini";
  const queueFolded = useAgentChatStore((s) => s.promptQueueFolded[queueMode]);
  const toggleQueueFolded = useAgentChatStore((s) => s.togglePromptQueueFolded);
  const queueListId = useId();
  const textareaMaxHeight = isCollapsed ? 48 : 160;
  const resizeTextarea = useCallback(
    (textarea: HTMLTextAreaElement | null = textareaRef.current) => {
      if (!textarea) return;
      textarea.style.height = "auto";
      textarea.style.height = `${Math.min(
        textarea.scrollHeight,
        textareaMaxHeight,
      )}px`;
    },
    [textareaMaxHeight],
  );
  const attachMiniTextarea = useCallback(
    (textarea: HTMLTextAreaElement | null) => {
      textareaRef.current = textarea;
      if (!textarea) return;
      let width = textarea.clientWidth;
      const observer = new ResizeObserver(() => {
        const nextWidth = textarea.clientWidth;
        if (nextWidth === width) return;
        width = nextWidth;
        resizeTextarea(textarea);
      });
      observer.observe(textarea);
      return () => {
        observer.disconnect();
        textareaRef.current = null;
      };
    },
    [resizeTextarea],
  );
  const currentLlmLabel = llmConfigLabel(
    selectedProvider,
    selectedClaudeModel,
    selectedCodexModel,
    effortLevel,
    selectedCodexReasoningEffort,
    selectedProvider === "claude"
      ? selectedClaudeExecutionMode
      : selectedProvider === "pi"
        ? selectedPiExecutionMode
        : selectedCodexExecutionMode,
    discoveredClaudeModels,
    selectedPiModel,
  );
  const previousLlmLabel = pendingResumeChoice
    ? llmConfigLabel(
        pendingResumeChoice.sessionProvider,
        pendingResumeChoice.sessionClaudeModel,
        pendingResumeChoice.sessionCodexModel,
        undefined,
        undefined,
        undefined,
        discoveredClaudeModels,
        pendingResumeChoice.sessionPiModel,
      )
    : null;
  const selectedExecutionMode =
    selectedProvider === "claude"
      ? selectedClaudeExecutionMode
      : selectedProvider === "pi"
        ? selectedPiExecutionMode
        : selectedCodexExecutionMode;
  const setExecutionMode =
    selectedProvider === "claude"
      ? setSelectedClaudeExecutionMode
      : selectedProvider === "pi"
        ? setSelectedPiExecutionMode
        : setSelectedCodexExecutionMode;
  const cycleExecutionMode = useCallback(
    () => setExecutionMode(nextExecutionMode(selectedExecutionMode)),
    [selectedExecutionMode, setExecutionMode],
  );
  const {
    icon: ExecutionModeIcon,
    label: executionModeLabel,
    labelClassName: executionModeColor,
  } = AGENT_EXECUTION_MODES[selectedExecutionMode];
  const modelButton = (
    <Hint content={modelPickerOpen ? undefined : modelTooltip}>
      <button
        ref={modelButtonRef}
        aria-label={
          isCollapsed
            ? "Model settings"
            : `${modelTooltipLabel} · Model settings`
        }
        aria-haspopup="dialog"
        aria-expanded={modelPickerOpen}
        aria-controls={modelPickerOpen ? modelPickerId : undefined}
        type="button"
        onClick={() =>
          setOpenPicker((open) => (open === "model" ? null : "model"))
        }
        className="flex h-7 min-w-6 items-center justify-center gap-1 rounded-md px-1 text-muted-foreground text-xs transition-colors hover:bg-muted hover:text-foreground"
      >
        {isCollapsed && (
          <BotMessageSquareIcon
            className="@min-[360px]/mini-composer:hidden size-3.5 shrink-0"
            aria-hidden="true"
          />
        )}
        <span
          className={cn(
            "min-w-0 items-center gap-1",
            isCollapsed ? "@min-[360px]/mini-composer:flex hidden" : "flex",
          )}
        >
          {selectedProvider === "codex" && selectedCodexFastMode && (
            <ZapIcon
              aria-label="Fast mode enabled"
              fill="currentColor"
              className="size-3 shrink-0"
            />
          )}
          <span className="max-w-[120px] truncate">{pickerLabel}</span>
          {showEffort && (
            <span className="shrink-0 text-muted-foreground/60">
              {effortShortLabel(selectedEffort)}
            </span>
          )}
        </span>
        <ChevronDownIcon
          className={cn(
            "size-3 shrink-0",
            isCollapsed && "@min-[360px]/mini-composer:block hidden",
          )}
          aria-hidden="true"
        />
      </button>
    </Hint>
  );

  const permissionButton = (
    <Popover
      open={openPicker === "permission"}
      onOpenChange={(open) =>
        setOpenPicker((current) =>
          open ? "permission" : current === "permission" ? null : current,
        )
      }
    >
      <Hint
        content={
          openPicker === "permission"
            ? undefined
            : `Writing permission · ${executionModeLabel}`
        }
      >
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label="Writing permission"
            aria-description={executionModeLabel}
            className={cn(
              "flex h-7 w-6 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-muted data-[state=open]:bg-muted",
              executionModeColor ??
                "text-muted-foreground hover:text-foreground",
            )}
          >
            <ExecutionModeIcon className="size-3.5" aria-hidden="true" />
          </button>
        </PopoverTrigger>
      </Hint>
      <PopoverContent
        ref={permissionPickerRef}
        side="top"
        align="center"
        collisionPadding={8}
        aria-label="Writing permission"
        tabIndex={-1}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          permissionPickerRef.current?.focus({ preventScroll: true });
        }}
        className="z-[9999] w-64 max-w-[calc(100vw-1rem)] p-1"
      >
        <PopupHeader>
          <ShieldCheckIcon
            className="size-3.5 text-muted-foreground"
            aria-hidden="true"
          />
          <h2>Permission</h2>
        </PopupHeader>
        <PopupSeparator />
        <div className="shrink-0 px-2 py-1.5">
          <div className="mb-1.5 font-medium text-muted-foreground text-xs">
            Writing permission
          </div>
          <ButtonGroup aria-label="Writing permission" className="flex gap-1">
            {Object.values(AGENT_EXECUTION_MODES).map((option) => {
              const {
                value: mode,
                label,
                description,
                icon: Icon,
                labelClassName,
              } = option;
              return (
                <Hint key={mode} content={description}>
                  <button
                    type="button"
                    aria-pressed={selectedExecutionMode === mode}
                    disabled={isStreaming}
                    className={cn(
                      "flex flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-1.5 py-1.5 font-medium text-xs transition-colors motion-reduce:transition-none",
                      isStreaming && "cursor-not-allowed opacity-50",
                      selectedExecutionMode === mode
                        ? [
                            "bg-background shadow-sm",
                            labelClassName ?? "text-foreground",
                          ]
                        : "text-muted-foreground hover:bg-background/70 hover:text-foreground",
                    )}
                    onClick={() => setExecutionMode(mode)}
                  >
                    <Icon className="size-3 shrink-0" aria-hidden="true" />
                    {label}
                  </button>
                </Hint>
              );
            })}
          </ButtonGroup>
        </div>
      </PopoverContent>
    </Popover>
  );
  const agentControls = (
    <div data-chat-agent-controls className="flex min-w-0 items-center">
      {contextIndicator}
      {permissionButton}
      {modelButton}
    </div>
  );

  useLayoutEffect(() => {
    resizeTextarea();
  }, [input, textareaMaxHeight, isCollapsed, isVisible, resizeTextarea]);

  const composerFocusRequestNonce = useAgentChatStore(
    (s) => s.composerFocusRequestNonce,
  );
  const previousFocusRequest = useRef(0);
  useEffect(() => {
    if (previousFocusRequest.current === composerFocusRequestNonce) return;
    previousFocusRequest.current = composerFocusRequestNonce;
    if (!acceptPendingAttachments) return;
    // The input may still be translated below the drawer during mode transfer.
    // Focusing must not scroll its containing panel to that temporary position.
    const frame = requestAnimationFrame(() =>
      textareaRef.current?.focus({ preventScroll: true }),
    );
    return () => cancelAnimationFrame(frame);
  }, [composerFocusRequestNonce, acceptPendingAttachments]);

  // Keep focus without moving the drawer during its entry animation.
  const prevOpenRef = useRef(false);
  useEffect(() => {
    if (isVisible && !prevOpenRef.current) {
      setTimeout(() => textareaRef.current?.focus({ preventScroll: true }), 0);
    }
    prevOpenRef.current = isVisible;
  }, [isVisible]);

  useEffect(() => {
    checkClaudeStatus().catch(() => {});
    checkCodexStatus().catch(() => {});
    void usePiSetupStore.getState().checkStatus();
  }, [checkClaudeStatus, checkCodexStatus]);

  useEffect(() => {
    if (
      claudeModelsStatus === "ready" &&
      discoveredClaudeModels.length > 0 &&
      !findClaudeModel(discoveredClaudeModels, selectedClaudeModel)
    ) {
      setSelectedClaudeModel(
        discoveredClaudeModels.find((model) => model.value === "default")
          ?.value ?? discoveredClaudeModels[0].value,
      );
    }
  }, [
    claudeModelsStatus,
    discoveredClaudeModels,
    selectedClaudeModel,
    setSelectedClaudeModel,
  ]);

  useEffect(() => {
    if (
      claudeModelsReady &&
      claudeEffortOptions.length > 0 &&
      !claudeEffortOptions.includes(effortLevel)
    ) {
      setEffortLevel(
        claudeEffortOptions.includes("medium")
          ? "medium"
          : claudeEffortOptions[0],
      );
    }
  }, [claudeModelsReady, claudeEffortOptions, effortLevel, setEffortLevel]);

  useEffect(() => {
    if (
      codexModelsStatus === "ready" &&
      discoveredCodexModels.length > 0 &&
      !discoveredCodexModels.some((model) => model.model === selectedCodexModel)
    ) {
      setSelectedCodexModel(
        discoveredCodexModels.find((model) => model.is_default)?.model ??
          discoveredCodexModels[0].model,
      );
    }
  }, [
    codexModelsStatus,
    discoveredCodexModels,
    selectedCodexModel,
    setSelectedCodexModel,
  ]);

  useEffect(() => {
    if (
      selectedCodexModelInfo &&
      codexEffortOptions.length > 0 &&
      !codexEffortOptions.includes(selectedCodexReasoningEffort)
    ) {
      setSelectedCodexReasoningEffort(
        selectedCodexModelInfo.default_reasoning_effort ||
          codexEffortOptions[0],
      );
    }
  }, [
    codexEffortOptions,
    selectedCodexModelInfo,
    selectedCodexReasoningEffort,
    setSelectedCodexReasoningEffort,
  ]);

  useEffect(() => {
    if (!acceptPendingAttachments) return;
    if (pendingAttachments.length === 0) return;
    const attachments = consumePendingAttachments();
    if (attachments.length === 0) return;
    setPinnedContexts((prev) => {
      const labels = new Set(prev.map((context) => context.label));
      return [
        ...prev,
        ...attachments.filter((context) => !labels.has(context.label)),
      ];
    });
    // Focus textarea so user can type immediately
    setTimeout(() => textareaRef.current?.focus(), 0);
  }, [acceptPendingAttachments, pendingAttachments, consumePendingAttachments]);

  const editorSelection = useMemo(() => {
    if (!selectionRange) return null;
    const file = files.find((f) => f.id === activeFileId);
    if (!file?.content) return null;
    const start = offsetToLineCol(file.content, selectionRange.start);
    const end = offsetToLineCol(file.content, selectionRange.end);
    return {
      proposedDraft: captureProposedDraft(draftSessionId, file.content),
      label: `@${file.relativePath}:${start.line}:${start.col}-${end.line}:${end.col}`,
      filePath: file.relativePath,
      selectedText: file.content.slice(
        selectionRange.start,
        selectionRange.end,
      ),
    };
  }, [draftSessionId, selectionRange, activeFileId, files]);
  const liveTextSelection = pdfSelectionContext ?? editorSelection;

  const handlePinnedContextMouseEnter = useCallback(
    (context: PinnedContext) => {
      const target = resolveSelectionContextTarget(context, files);
      if (!target) return;
      setSelectionPreviewRange({
        fileId: target.fileId,
        start: target.start,
        end: target.end,
      });
    },
    [files, setSelectionPreviewRange],
  );

  const handlePinnedContextMouseLeave = useCallback(() => {
    setSelectionPreviewRange(null);
  }, [setSelectionPreviewRange]);

  const handlePinnedContextRemove = useCallback(
    (index: number) => {
      // Removing a hovered chip unmounts it before mouseleave can clear the
      // editor preview, so reset the preview as part of the removal itself.
      setSelectionPreviewRange(null);
      const context = pinnedContexts[index];
      if (
        context?.comment &&
        context.selectionKey === commentSelectionContext?.selectionKey
      ) {
        useDocumentStore.getState().setCommentSelectionContext(null);
      }
      if (
        context &&
        isSelectionRangeContextLabel(context.label) &&
        (!context.selectionPinned ||
          context.label === editorSelection?.label ||
          (pdfSelectionContext &&
            isSameSelectionContext(context, pdfSelectionContext)))
      ) {
        setSelectionRange(null);
        window.dispatchEvent(
          new CustomEvent(SELECTION_OWNER_EVENT, { detail: "none" }),
        );
      }
      setPinnedContexts((prev) =>
        prev.filter((_, contextIndex) => contextIndex !== index),
      );
    },
    [
      pinnedContexts,
      editorSelection?.label,
      pdfSelectionContext,
      commentSelectionContext,
      setSelectionRange,
      setSelectionPreviewRange,
    ],
  );

  const handleContextRemoveMouseDown = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      // Keep the draft's caret and focus when removing context while typing.
      if (document.activeElement === textareaRef.current) {
        event.preventDefault();
      }
    },
    [],
  );

  const handlePinnedContextActivate = useCallback(
    (context: PinnedContext) => {
      if (context.comment) {
        window.dispatchEvent(
          new CustomEvent(PDF_COMMENT_NAVIGATE_EVENT, {
            detail: {
              projectRoot: useDocumentStore.getState().projectRoot,
              filePath: context.filePath,
              commentId: context.comment.id,
            },
          }),
        );
        return;
      }
      if (context.selectionKey?.startsWith("file:")) {
        const file = files.find(
          (file) => file.relativePath === context.filePath,
        );
        if (file) setActiveFile(file.id);
        return;
      }
      const target = resolveSelectionContextTarget(context, files);
      if (!target) return;
      if (target.fileId !== activeFileId) {
        setActiveFile(target.fileId);
      }
      setSelectionPreviewRange(null);
      setSelectionRange({ start: target.start, end: target.end });
      requestJumpToSelectionRange({ start: target.start, end: target.end });
    },
    [
      activeFileId,
      files,
      requestJumpToSelectionRange,
      setActiveFile,
      setSelectionPreviewRange,
      setSelectionRange,
    ],
  );

  // Text and comments share one live selection lifecycle; grouping is visual only.
  useEffect(() => {
    if (!acceptPendingAttachments) return;
    const keepContext = (context: PinnedContext) => {
      if (!context.comment || !commentsLoaded) return true;
      return Boolean(
        commentsByFile[context.filePath ?? ""]?.some(
          (comment) => comment.id === context.comment!.id && !comment.resolved,
        ),
      );
    };
    if (commentSelectionContext && !keepContext(commentSelectionContext)) {
      useDocumentStore.getState().setCommentSelectionContext(null);
    }
    const store = useAgentChatStore.getState();
    if (store.chatProjectRoot === projectRoot) {
      for (const tab of store.tabs) {
        if (tab.id === activeTabId) continue;
        const contexts = tab.draft.pinnedContexts.filter(keepContext);
        if (contexts.length !== tab.draft.pinnedContexts.length) {
          store.saveDraft(tab.id, { ...tab.draft, pinnedContexts: contexts });
        }
      }
    }
    const liveContext = commentSelectionContext ?? liveTextSelection;
    setPinnedContexts((prev) => {
      const retained = prev.filter(
        (context) =>
          keepContext(context) &&
          (context.selectionPinned ||
            (!isSelectionRangeContextLabel(context.label) && !context.comment)),
      );
      const alreadyPinned =
        liveContext &&
        retained.some((context) =>
          isSameSelectionContext(context, liveContext),
        );
      const target = liveContext
        ? resolveSelectionContextTarget(liveContext, files)
        : null;
      const comments = target
        ? commentsInSelection(
            target.filePath,
            commentsByFile[target.filePath] ?? [],
            target.start,
            target.end,
          )
        : [];
      const next = [
        ...retained,
        ...(liveContext && keepContext(liveContext) && !alreadyPinned
          ? [liveContext]
          : []),
        ...comments.filter(
          (comment) =>
            !retained.some(
              (context) => context.selectionKey === comment.selectionKey,
            ),
        ),
      ];
      return pinnedContextsEqual(prev, next) ? prev : next;
    });
  }, [
    liveTextSelection,
    commentSelectionContext,
    files,
    commentsByFile,
    commentsLoaded,
    projectRoot,
    activeTabId,
    acceptPendingAttachments,
  ]);

  // Compute @ mention matches
  useEffect(() => {
    if (mentionQuery === null) {
      setMentionFiles([]);
      return;
    }
    setMentionFiles(getMentionFileMatches(files, mentionQuery));
    setMentionIndex(0);
  }, [mentionQuery, files]);

  useLayoutEffect(() => {
    if (
      slashQuery !== null ||
      mentionQuery === null ||
      !inputSurfaceRef.current
    )
      return;
    const rect = inputSurfaceRef.current.getBoundingClientRect();
    setMentionPickerPos({
      left: rect.left,
      right: Math.max(window.innerWidth - rect.right, 12),
      bottom: window.innerHeight - rect.top + 8,
    });
  }, [mentionQuery, mentionFiles.length, slashQuery, isCollapsed, isVisible]);

  // Load slash commands when picker is activated (keep loaded after close for send resolution)
  useEffect(() => {
    if (slashQuery === null) return;
    // Pi skills are expanded by Pi. Only the picker needs its native catalog.
    if (selectedProvider === "pi") {
      setSlashCommands([]);
      return;
    }
    invoke<SlashCommand[]>("slash_commands_list", {
      projectPath: projectRoot ?? undefined,
      provider: selectedProvider,
    })
      .then(setSlashCommands)
      .catch(() => setSlashCommands([]));
  }, [slashQuery !== null, projectRoot, selectedProvider]);

  const selectMention = useCallback(
    (file: ProjectFile) => {
      // Replace @query with empty and pin the file as context
      const textarea = textareaRef.current;
      if (!textarea) return;
      const cursorPos = textarea.selectionStart;
      // Find the @ position before cursor
      const textBefore = input.slice(0, cursorPos);
      const atIndex = textBefore.lastIndexOf("@");
      if (atIndex === -1) return;
      const newInput = input.slice(0, atIndex) + input.slice(cursorPos);
      setInput(newInput);
      setMentionQuery(null);

      // Pin the whole file as context
      const isTextFile =
        file.type === "tex" ||
        file.type === "csv" ||
        file.type === "bib" ||
        file.type === "style" ||
        file.type === "other";
      setPinnedContexts((prev) => [
        ...prev,
        {
          proposedDraft: captureProposedDraft(draftSessionId, file.content),
          selectionKey: `file:${file.relativePath}`,
          label: `@${file.relativePath}`,
          filePath: file.relativePath,
          selectedText: isTextFile
            ? (file.content ?? "")
            : `[Referenced file: ${file.relativePath} (${file.type} file)]`,
        },
      ]);

      // Refocus textarea
      setTimeout(() => textarea.focus(), 0);
    },
    [input, draftSessionId],
  );

  const selectSlashCommand = useCallback(
    (command: SlashCommand) => {
      // Replace only the active /query, keeping the rest of the draft intact.
      const cursor = textareaRef.current?.selectionStart ?? input.length;
      const range = slashRangeRef.current ?? { start: cursor, end: cursor };
      const before = input.slice(0, range.start);
      const after = input.slice(range.end);
      const separator = before && !/\s$/.test(before) ? " " : "";
      const existingSpace = after.startsWith(" ");
      const insertion = `${separator}${commandSyntaxForProvider(command, selectedProvider)}${existingSpace ? "" : " "}`;
      const newInput = before + insertion + after;
      const nextCursor =
        before.length + insertion.length + (existingSpace ? 1 : 0);

      setInput(newInput);
      setSlashQuery(null);
      slashRangeRef.current = null;

      // Continue typing immediately after the inserted command.
      setTimeout(() => {
        const textarea = textareaRef.current;
        if (textarea) {
          textarea.focus();
          textarea.selectionStart = textarea.selectionEnd = nextCursor;
          resizeTextarea(textarea);
        }
      }, 0);
    },
    [input, resizeTextarea, selectedProvider],
  );

  const focusTextareaAt = useCallback(
    (cursorPos: number) => {
      setTimeout(() => {
        const textarea = textareaRef.current;
        if (!textarea) return;
        textarea.focus();
        textarea.selectionStart = textarea.selectionEnd = cursorPos;
        resizeTextarea(textarea);
      }, 0);
    },
    [resizeTextarea],
  );

  const insertTriggerAtSelection = useCallback(
    (trigger: "/" | "@") => {
      const textarea = textareaRef.current;
      const selectionStart = textarea?.selectionStart ?? input.length;
      const selectionEnd = textarea?.selectionEnd ?? selectionStart;
      const start = Math.max(0, Math.min(selectionStart, input.length));
      const end = Math.max(start, Math.min(selectionEnd, input.length));
      const prefix = input.slice(0, start);
      const separator =
        trigger === "/" && prefix && !/\s$/.test(prefix) ? " " : "";
      const triggerStart = start + separator.length;
      const nextInput = prefix + separator + trigger + input.slice(end);

      setInput(nextInput);
      focusTextareaAt(triggerStart + trigger.length);
      return { start: triggerStart, end: triggerStart + trigger.length };
    },
    [focusTextareaAt, input],
  );

  const openSlashTrigger = useCallback(() => {
    setToolbarShortcutsOpen(false);
    slashRangeRef.current = insertTriggerAtSelection("/");
    setSlashQuery("");
    setMentionQuery(null);
  }, [insertTriggerAtSelection]);

  const openMentionTrigger = useCallback(() => {
    setToolbarShortcutsOpen(false);
    insertTriggerAtSelection("@");
    setMentionQuery("");
    setSlashQuery(null);
    slashRangeRef.current = null;
  }, [insertTriggerAtSelection]);

  // Handle file drops — guard against duplicate calls from stale HMR listeners
  const isProcessingDropRef = useRef(false);
  const isNativeDropOverChatDrawer = useCallback(
    (position?: { x: number; y: number }) => {
      const panel =
        composerRef.current?.closest("[data-chat-drawer-panel]") ?? null;
      return isNativeDropPointInsideElement(position, panel);
    },
    [],
  );
  const handleFileDropRef = useRef<(paths: string[]) => Promise<void>>(
    async () => {},
  );
  handleFileDropRef.current = async (paths: string[]) => {
    if (!projectRoot || paths.length === 0) return;
    if (isProcessingDropRef.current) return;
    isProcessingDropRef.current = true;

    try {
      const newContexts: PinnedContext[] = [];
      for (const sourcePath of paths) {
        const filePath = await invoke<string>("desktop:chat:attachment", {
          projectRoot,
          sourcePath,
        });
        newContexts.push({
          attachment: true,
          ...(/\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i.test(filePath)
            ? { imageDataUrl: getAssetUrl(filePath) }
            : {}),
          label: `@${sourcePath.split(/[/\\]/).pop() || sourcePath}`,
          filePath,
          selectedText: `[Attached file: ${filePath}]`,
        });
      }

      if (newContexts.length > 0) {
        setPinnedContexts((prev) => {
          // Deduplicate references to the same file
          const existingPaths = new Set(prev.map((c) => c.filePath));
          const unique = newContexts.filter(
            (c) => !existingPaths.has(c.filePath),
          );
          return [...prev, ...unique];
        });
      }
    } catch (error) {
      log.error("Failed to attach dropped files", { error: String(error) });
      toast.error("Could not attach dropped files.");
    } finally {
      isProcessingDropRef.current = false;
    }
  };

  const attachBrowserFilesRef = useRef<(files: File[]) => Promise<void>>(
    async () => {},
  );

  // Listen for native OS file drops
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    getCurrentWebview()
      .onDragDropEvent(async (event) => {
        if (cancelled) return;
        const { type } = event.payload;
        if (type === "enter" || type === "over") {
          const payload = event.payload as {
            position?: { x: number; y: number };
          };
          setIsDragOver(isNativeDropOverChatDrawer(payload.position));
        } else if (type === "drop") {
          setIsDragOver(false);
          // Skip if the sidebar already handled this drop (OS file dropped on sidebar file tree)
          if ((window as any).__sidebarHandledDrop) {
            log.debug("skipped — sidebar handled this drop");
            return;
          }
          const payload = event.payload as {
            paths: string[];
            files?: File[];
            position?: { x: number; y: number };
          };
          if (!isNativeDropOverChatDrawer(payload.position)) {
            log.debug("skipped — drop outside chat drawer");
            return;
          }
          const paths = payload.paths;
          if (paths?.length > 0) {
            await handleFileDropRef.current?.(paths);
          }
          if (payload.files?.length)
            await attachBrowserFilesRef.current(payload.files);
        } else if (type === "leave") {
          setIsDragOver(false);
        }
      })
      .then((fn) => {
        if (cancelled) {
          fn();
        } else {
          unlisten = fn;
        }
      })
      .catch(() => {
        // Native drops are unavailable in browser previews
      });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [isNativeDropOverChatDrawer]);

  // Clipboard and pathless screenshot drops share the same project attachment flow.
  const attachBrowserFiles = useCallback(
    async (fileItems: File[]) => {
      if (!projectRoot || fileItems.length === 0) return;
      const newContexts: PinnedContext[] = [];

      for (const file of fileItems) {
        // Generate a filename — use the original name or a timestamp-based name for screenshots
        let fileName = file.name;
        if (!fileName || fileName === "image.png") {
          const ext = file.type.split("/")[1] || "png";
          fileName = `paste-${Date.now()}.${ext}`;
        }

        try {
          const sourcePath = window.catalex?.getPathForFile(file);
          const filePath = await invoke<string>("desktop:chat:attachment", {
            projectRoot,
            ...(sourcePath
              ? { sourcePath }
              : {
                  name: fileName,
                  bytes: Array.from(new Uint8Array(await file.arrayBuffer())),
                }),
          });

          // Determine if it's a text file
          const isText = file.type.startsWith("text/");
          const content = isText
            ? await file.text()
            : `[Attached file: ${filePath} (${file.type})]`;

          newContexts.push({
            attachment: true,
            ...(file.type.startsWith("image/")
              ? { imageDataUrl: getAssetUrl(filePath) }
              : {}),
            label: `@${fileName}`,
            filePath,
            selectedText: content,
          });
        } catch (err) {
          toast.error(`Could not attach ${fileName}.`);
          log.error("Failed to save attached file", {
            fileName,
            error: String(err),
          });
        }
      }

      if (newContexts.length > 0) {
        setPinnedContexts((prev) => {
          const existingPaths = new Set(prev.map((c) => c.filePath));
          const unique = newContexts.filter(
            (c) => !existingPaths.has(c.filePath),
          );
          return [...prev, ...unique];
        });
      }
    },
    [projectRoot],
  );

  attachBrowserFilesRef.current = attachBrowserFiles;
  const handlePaste = useCallback(
    async (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const files = Array.from(event.clipboardData?.files ?? []);
      if (!projectRoot || files.length === 0) return;
      event.preventDefault();
      await attachBrowserFiles(files);
    },
    [attachBrowserFiles, projectRoot],
  );

  // Live selections alone do not turn an empty paused composer into a new message.
  const hasMessageInput =
    Boolean(input.trim()) ||
    pinnedContexts.some(
      (context) =>
        Boolean(context.imageDataUrl) ||
        context.selectionKey?.startsWith("file:") ||
        (!context.comment &&
          !context.selectionKey &&
          !isSelectionRangeContextLabel(context.label) &&
          Boolean(context.filePath)),
    );

  const handleSend = useCallback(() => {
    const trimmed = input.trim();
    if (
      !hasMessageInput ||
      (modelSelectionBlocked && !isBusy) ||
      sendBlockedReason
    )
      return;

    // Resolve slash commands: if input starts with /command, find the command and substitute $ARGUMENTS
    // Skills are passed through as provider-native markers: /skill for Claude, $skill for Codex.
    let finalPrompt = trimmed;
    const slashMatch = trimmed.match(/^\/(\S+)\s*([\s\S]*)/);
    if (
      selectedProvider !== "pi" &&
      slashMatch &&
      slashMatch[1] !== "compact" &&
      slashCommands.length > 0
    ) {
      const cmdName = slashMatch[1];
      const args = slashMatch[2].trim();
      const matched = slashCommands.find(
        (cmd) => cmd.full_command === `/${cmdName}` || cmd.name === cmdName,
      );
      if (matched && matched.scope !== "skill") {
        finalPrompt = matched.content;
        if (matched.accepts_arguments && args) {
          finalPrompt = finalPrompt.replace(/\$ARGUMENTS/g, args);
        }
      }
    }

    // Clear only once the store accepts or safely queues this prompt.
    void sendPrompt(
      finalPrompt,
      pinnedContexts.length ? pinnedContexts : undefined,
      false,
      () => {
        setInput((current) => (current === input ? "" : current));
        setMentionQuery(null);
        setSlashQuery(null);
        slashRangeRef.current = null;
        if (textareaRef.current) textareaRef.current.style.height = "auto";
        setPinnedContexts((current) =>
          current === pinnedContexts ? [] : current,
        );
      },
    );
  }, [
    input,
    hasMessageInput,
    isBusy,
    modelSelectionBlocked,
    sendBlockedReason,
    sendPrompt,
    pinnedContexts,
    slashCommands,
    selectedProvider,
  ]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // IME candidate confirmation/navigation belongs to the input method.
      // Some platforms report the final composition key as keyCode 229.
      if (isComposingKey(e) || e.defaultPrevented) return;

      if (
        e.key === "Tab" &&
        e.shiftKey &&
        (selectedProvider === "claude" ||
          selectedProvider === "codex" ||
          selectedProvider === "pi") &&
        !isStreaming
      ) {
        e.preventDefault();
        cycleExecutionMode();
        return;
      }

      // Slash command picker is open — let the picker handle keyboard events
      // Its scoped capture listener owns these keys before the composer.
      if (slashQuery !== null) {
        if (
          e.key === "Enter" ||
          e.key === "ArrowDown" ||
          e.key === "ArrowUp" ||
          e.key === "Tab" ||
          e.key === "Escape"
        ) {
          e.preventDefault();
          return;
        }
      }

      // @ mention navigation
      if (mentionQuery !== null && mentionFiles.length > 0) {
        if (e.key === "ArrowDown") {
          consumeKey(e);
          setMentionIndex((i) => Math.min(i + 1, mentionFiles.length - 1));
          return;
        }
        if (e.key === "ArrowUp") {
          consumeKey(e);
          setMentionIndex((i) => Math.max(i - 1, 0));
          return;
        }
        if (e.key === "Enter" || e.key === "Tab") {
          consumeKey(e);
          selectMention(mentionFiles[mentionIndex]);
          return;
        }
        if (e.key === "Escape") {
          consumeKey(e);
          setMentionQuery(null);
          return;
        }
      }

      if (e.key === "Enter" && !e.shiftKey) {
        consumeKey(e);
        handleSend();
      }
    },
    [
      handleSend,
      cycleExecutionMode,
      isStreaming,
      mentionQuery,
      mentionFiles,
      mentionIndex,
      selectMention,
      selectedProvider,
      slashQuery,
    ],
  );

  const handleInput = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const value = e.target.value;
      setInput(value);

      const cursorPos = e.target.selectionStart;
      const textBefore = value.slice(0, cursorPos);
      // Complete a /query at the caret, including within an existing draft.
      const slashMatch = textBefore.match(/(?:^|\s)\/(\S*)$/);
      if (slashMatch) {
        slashRangeRef.current = {
          start: cursorPos - slashMatch[1].length - 1,
          end: cursorPos,
        };
        setSlashQuery(slashMatch[1]);
        setMentionQuery(null);
      } else {
        slashRangeRef.current = null;
        setSlashQuery(null);
      }

      // Detect @ mention trigger (only when not in slash command mode)
      if (!slashMatch) {
        // Match @ at start of input or after a space
        const atMatch = textBefore.match(/(?:^|[\s])@([^\s]*)$/);
        if (atMatch) {
          setMentionQuery(atMatch[1]);
        } else {
          setMentionQuery(null);
        }
      }

      resizeTextarea(e.target);
    },
    [resizeTextarea],
  );

  // Scroll active mention into view
  useEffect(() => {
    if (mentionRef.current) {
      const active = mentionRef.current.querySelector("[data-active=true]");
      active?.scrollIntoView({ block: "nearest" });
    }
  }, [mentionIndex]);

  // Close model picker on click outside
  useEffect(() => {
    if (!modelPickerOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        modelPickerRef.current &&
        !modelPickerRef.current.contains(target) &&
        modelButtonRef.current &&
        !modelButtonRef.current.contains(target)
      ) {
        setOpenPicker((open) => (open === "model" ? null : open));
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [modelPickerOpen]);

  const showContinue = pauseState === "paused" && !hasMessageInput;
  const isStopping = pauseState === "pausing" || !!queueTab?.cancelledByUser;
  const showStop = isStreaming && !hasMessageInput;
  const submitControl = (
    <TooltipIconButton
      data-composer-submit
      tooltip={
        showStop
          ? isStopping
            ? "Stopping…"
            : "Stop"
          : (sendBlockedReason ?? (showContinue ? "Continue" : "Send"))
      }
      side="top"
      variant={showStop ? "secondary" : "default"}
      size="icon"
      className="size-7 shrink-0 rounded-full"
      onClick={
        showStop
          ? () => void cancelExecution()
          : sendBlockedReason
            ? undefined
            : showContinue
              ? continueExecution
              : handleSend
      }
      aria-disabled={!!sendBlockedReason}
      disabled={
        !sendBlockedReason &&
        ((showStop && isStopping) ||
          (!showStop &&
            ((modelSelectionBlocked && !isBusy) ||
              (!showContinue && !hasMessageInput))))
      }
    >
      {showStop ? (
        isStopping ? (
          <LoaderCircleIcon className="size-3.5 animate-spin" />
        ) : (
          <SquareIcon className="size-3 fill-current" />
        )
      ) : sendBlockedReason ? (
        <LockKeyholeIcon className="size-3.5" />
      ) : showContinue ? (
        <PlayIcon className="size-3.5 fill-current" />
      ) : (
        <ArrowUpIcon className="size-3.5" />
      )}
    </TooltipIconButton>
  );

  const answerContexts = useMemo(
    () =>
      activeQuestion
        ? pinnedContexts.filter(
            (context) => context.comment || isPromptSelection(context),
          )
        : null,
    [activeQuestion, pinnedContexts],
  );
  const contextBadges = (
    <ContextBadgeList
      contexts={answerContexts ?? pinnedContexts}
      compact={!!answerContexts}
      isLive={(context) =>
        !context.selectionPinned &&
        (Boolean(context.comment) ||
          isSelectionRangeContextLabel(context.label))
      }
      renderContext={(ctx) => {
        const i = pinnedContexts.indexOf(ctx);
        const earlierDraft = isEarlierDraftContext(
          ctx,
          draftSessionId,
          files.find((file) => file.relativePath === ctx.filePath)?.content,
        );
        const draftLabel = ctx.proposedDraft
          ? earlierDraft
            ? "Agent proposed · Earlier draft"
            : "Agent proposed"
          : null;
        const badge = ctx.imageDataUrl ? (
          <span
            className="inline-flex max-w-full items-center gap-1 rounded-sm border border-border bg-transparent py-0.5 pr-0.5 pl-1 font-mono text-muted-foreground text-xs transition-colors hover:border-muted-foreground/50 hover:bg-muted/50 hover:text-foreground"
            data-attachment-chip="true"
          >
            <ChatImagePreview
              src={ctx.imageDataUrl}
              sourcePath={ctx.filePath}
              alt={ctx.label}
              label={ctx.label}
              tooltip={ctx.attachment ? ctx.filePath : undefined}
              thumbnailClassName="size-4 shrink-0 rounded-sm border-0 object-cover"
            />
            <button
              type="button"
              aria-label="Remove attachment"
              onMouseDown={handleContextRemoveMouseDown}
              onClick={() => handlePinnedContextRemove(i)}
              className="shrink-0 rounded-sm p-0.5 hover:bg-muted-foreground/20"
            >
              <XIcon className="size-3" />
            </button>
          </span>
        ) : (
          <span
            role="button"
            tabIndex={0}
            aria-label={`Show ${ctx.comment ? "comment @" : ctx.selectionKey?.startsWith("file:") ? "file " : "selection "}${ctx.label}`}
            data-attachment-chip={ctx.attachment ? "true" : undefined}
            data-selection-chip={
              ctx.comment || ctx.attachment ? undefined : "true"
            }
            data-comment-chip={ctx.comment ? "true" : undefined}
            data-selection-pinned={Boolean(ctx.selectionPinned)}
            onMouseDown={(event) => {
              if (ctx.comment) event.preventDefault();
            }}
            onClick={() => handlePinnedContextActivate(ctx)}
            onKeyDown={(event) => {
              if (event.target !== event.currentTarget) return;
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              handlePinnedContextActivate(ctx);
            }}
            onMouseEnter={() => handlePinnedContextMouseEnter(ctx)}
            onMouseLeave={handlePinnedContextMouseLeave}
            onFocus={() => handlePinnedContextMouseEnter(ctx)}
            onBlur={handlePinnedContextMouseLeave}
            className={cn(
              "inline-flex max-w-full cursor-pointer items-center gap-1 rounded-sm py-0.5 pr-0.5 pl-1 font-mono text-xs transition-colors focus-visible:outline-none focus-visible:ring-2",
              ctx.attachment
                ? "border border-border bg-transparent text-muted-foreground hover:border-muted-foreground/50 hover:bg-muted/50 hover:text-foreground focus-visible:ring-ring/50"
                : "focus-visible:ring-blue-500/50",
              ctx.attachment
                ? ""
                : ctx.comment
                  ? ctx.comment.agent
                    ? "bg-[#7252b5] text-white hover:bg-[#62439e]"
                    : "bg-[#eab308] text-white hover:bg-[#d6a207]"
                  : "bg-muted text-muted-foreground hover:bg-blue-50 hover:text-blue-700 dark:hover:bg-blue-950/40 dark:hover:text-blue-300",
            )}
            title={
              ctx.comment?.text ??
              (ctx.pdf
                ? `${ctx.pdf.documentPath} · PDF p.${ctx.pdf.page}\n${ctx.selectedText}`
                : undefined) ??
              (ctx.proposedDraft ? ctx.selectedText : undefined)
            }
          >
            {ctx.attachment && (
              <FileIcon aria-hidden="true" className="size-3 shrink-0" />
            )}
            {draftLabel && (
              <span
                className="shrink-0 font-sans"
                data-proposed-draft-context="true"
              >
                {draftLabel} ·
              </span>
            )}
            <span data-context-label="true" className="min-w-0 truncate">
              {ctx.comment ? `@${ctx.label}` : ctx.label}
              <span data-context-glow="true" aria-hidden="true">
                {ctx.comment ? `@${ctx.label}` : ctx.label}
              </span>
            </span>
            {(ctx.comment || isSelectionRangeContextLabel(ctx.label)) && (
              <span className="relative size-4 shrink-0">
                <PinIcon
                  aria-hidden="true"
                  className={cn(
                    "absolute inset-0.5 size-3 transition-opacity duration-150 motion-reduce:duration-75",
                    ctx.selectionPinned ? "opacity-0" : "opacity-100",
                  )}
                />
                <PinIcon
                  aria-label={
                    ctx.selectionPinned
                      ? ctx.comment
                        ? "Pinned comment"
                        : "Pinned selection"
                      : undefined
                  }
                  aria-hidden={!ctx.selectionPinned || undefined}
                  className={cn(
                    "absolute inset-0.5 size-3 fill-current transition-opacity duration-150 motion-reduce:duration-75",
                    ctx.selectionPinned ? "opacity-100" : "opacity-0",
                  )}
                />
                {!ctx.selectionPinned && (
                  <Hint
                    content={
                      ctx.comment
                        ? "Keep this comment while selecting others"
                        : "Keep this selection while selecting more text"
                    }
                  >
                    <button
                      type="button"
                      aria-label={ctx.comment ? "Pin comment" : "Pin selection"}
                      onMouseDown={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                      }}
                      onClick={(event) => {
                        event.stopPropagation();
                        setPinnedContexts((prev) =>
                          prev.map((context, index) =>
                            index === i
                              ? { ...context, selectionPinned: true }
                              : context,
                          ),
                        );
                      }}
                      className="absolute inset-0 rounded-sm transition-colors hover:bg-muted-foreground/20"
                    />
                  </Hint>
                )}
              </span>
            )}
            <button
              type="button"
              aria-label="Remove context"
              onClick={(event) => {
                event.stopPropagation();
                handlePinnedContextRemove(i);
              }}
              onMouseDown={(event) => {
                if (ctx.comment) event.preventDefault();
                handleContextRemoveMouseDown(event);
              }}
              className="rounded-sm p-0.5 transition-colors hover:bg-muted-foreground/20"
            >
              <XIcon className="size-3" />
            </button>
          </span>
        );
        return ctx.attachment && !ctx.imageDataUrl ? (
          <Hint content={ctx.filePath}>{badge}</Hint>
        ) : (
          badge
        );
      }}
    />
  );

  return (
    <div ref={composerRef} className="relative flex min-h-0 flex-col p-3">
      {!isCollapsed && queueTab && (
        <div
          data-prompt-shelf=""
          aria-hidden={isExpanded && !promptsExpanded ? true : undefined}
          inert={isExpanded && !promptsExpanded}
          className={cn(
            "pointer-events-none relative z-10 mb-2 shrink-0 transition-[margin-top,opacity,visibility] duration-200 ease-out motion-reduce:transition-none [&>[data-prompt-suggestions]]:pointer-events-auto",
            // Cancel the folded shell's 30px height and 8px gap, so it floats
            // with the same bottom edge without reserving a composer row.
            promptsExpanded ? "mt-0" : "-mt-[38px]",
            isExpanded && !promptsExpanded && "invisible opacity-0",
          )}
        >
          <PromptSuggestions
            foldedPlacement={isExpanded ? undefined : "half"}
          />
        </div>
      )}
      {/* / slash command picker — portal to body to escape all stacking contexts */}
      {slashQuery !== null && (
        <SlashCommandPicker
          projectPath={projectRoot}
          provider={selectedProvider}
          query={slashQuery}
          anchorRef={inputSurfaceRef}
          onSelect={selectSlashCommand}
          onClose={() => {
            setSlashQuery(null);
          }}
        />
      )}

      {/* Model picker popup — portal to body to escape all stacking contexts */}
      {modelPickerOpen &&
        createPortal(
          <PopupSurface
            ref={modelPickerRef}
            id={modelPickerId}
            role="dialog"
            aria-label="Model settings"
            tabIndex={-1}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              consumeKey(event);
              setOpenPicker(null);
              modelButtonRef.current?.focus();
            }}
            className="fixed flex w-72 max-w-[calc(100vw-1rem)] flex-col overflow-hidden"
            style={{
              left: pickerPos.left,
              bottom: pickerPos.bottom,
              maxHeight: `min(36rem, calc(100vh - ${pickerPos.bottom + 8}px))`,
              zIndex: 9999,
            }}
          >
            <PopupHeader
              action={
                <Hint
                  content={
                    selectedProvider === "pi"
                      ? "Agent Settings"
                      : "Manage legacy models"
                  }
                >
                  <button
                    type="button"
                    aria-label={
                      selectedProvider === "pi"
                        ? "Agent Settings"
                        : "Manage legacy models"
                    }
                    className="flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() => {
                      setOpenPicker(null);
                      void invoke("open_settings_window", {
                        section: "agent",
                        provider: selectedProvider,
                      }).catch((error) =>
                        toast.error(
                          `Could not open Settings: ${String(error)}`,
                        ),
                      );
                    }}
                  >
                    <Settings2Icon className="size-3.5" />
                  </button>
                </Hint>
              }
            >
              <BotMessageSquareIcon
                className="size-3.5 text-muted-foreground"
                aria-hidden="true"
              />
              <h2>Model</h2>
            </PopupHeader>
            <PopupSeparator />
            {multipleProvidersEnabled ? (
              <div className="shrink-0 px-2 py-1.5">
                <div className="mb-1.5 font-medium text-muted-foreground text-xs">
                  Provider
                </div>
                <ButtonGroup aria-label="Provider" className="flex gap-1">
                  {[
                    {
                      id: "codex" as const,
                      label: "Codex",
                      ready: codexReady,
                    },
                    {
                      id: "claude" as const,
                      label: "Claude",
                      ready: claudeReady,
                    },
                    { id: "pi" as const, label: "Pi", ready: piReady },
                  ]
                    .filter((provider) => enabledProviders[provider.id])
                    .map((provider) => (
                      <button
                        key={provider.id}
                        aria-pressed={selectedProvider === provider.id}
                        className={cn(
                          "flex-1 rounded-md px-2 py-1.5 font-medium text-xs transition-colors motion-reduce:transition-none",
                          !provider.ready && "cursor-not-allowed opacity-50",
                          selectedProvider === provider.id
                            ? "bg-background text-foreground shadow-sm"
                            : "text-muted-foreground hover:bg-background/70 hover:text-foreground",
                        )}
                        disabled={!provider.ready}
                        onClick={() => setProvider(provider.id)}
                      >
                        {provider.label}
                      </button>
                    ))}
                </ButtonGroup>
              </div>
            ) : null}

            {multipleProvidersEnabled && <PopupSeparator />}
            <ModelPickerTransition
              provider={`${selectedProvider}:${subscriptionUsage?.provider === selectedProvider ? "ready" : "loading"}`}
            >
              {selectedProvider !== "pi" && (
                <>
                  <div
                    role="group"
                    aria-label="Subscription usage"
                    data-subscription-usage=""
                    className="app-scrollbar max-h-40 shrink-0 space-y-2 overflow-y-auto px-2 py-1.5 text-xs"
                  >
                    <div className="flex items-center justify-between font-medium text-muted-foreground">
                      <span>Subscription usage</span>
                      <button
                        type="button"
                        aria-label="Refresh subscription usage"
                        disabled={
                          subscriptionUsage?.provider !== selectedProvider
                        }
                        onClick={() => {
                          setSubscriptionUsage(null);
                          setUsageRefresh((value) => value + 1);
                        }}
                        className="hover:text-foreground disabled:opacity-50"
                      >
                        Refresh
                      </button>
                    </div>
                    <div data-subscription-content="" className="space-y-2">
                      {subscriptionUsage?.provider !== selectedProvider ? (
                        <div role="status" className="text-muted-foreground">
                          Loading usage...
                        </div>
                      ) : subscriptionUsage.windows?.length ? (
                        subscriptionUsage.windows.map((window) => (
                          <div key={window.id} className="space-y-1">
                            <div className="flex items-center justify-between gap-2">
                              <span>{window.label}</span>
                              <span className="text-muted-foreground tabular-nums">
                                {Math.round(100 - window.usedPercent)}% left
                              </span>
                            </div>
                            <Progress
                              aria-label={`${window.label} subscription remaining`}
                              value={100 - window.usedPercent}
                              className="h-1.5"
                            />
                            {window.resetsAt && (
                              <div className="text-[10px] text-muted-foreground">
                                Resets{" "}
                                {new Date(window.resetsAt).toLocaleString(
                                  undefined,
                                  {
                                    month: "short",
                                    day: "numeric",
                                    hour: "numeric",
                                    minute: "2-digit",
                                  },
                                )}
                              </div>
                            )}
                          </div>
                        ))
                      ) : (
                        <div role="status" className="text-muted-foreground">
                          Usage unavailable
                        </div>
                      )}
                    </div>
                  </div>
                  <PopupSeparator />
                </>
              )}
              {/* Models */}
              <div
                data-model-provider={selectedProvider}
                className="app-scrollbar min-h-0 overflow-y-auto"
              >
                <div className="flex items-center justify-between px-2 py-1 font-medium text-muted-foreground text-xs">
                  <span>Available models</span>
                  <button
                    type="button"
                    disabled={
                      (selectedProvider === "pi"
                        ? pi.modelsStatus
                        : selectedProvider === "claude"
                          ? claudeModelsStatus
                          : codexModelsStatus) === "loading"
                    }
                    onClick={() =>
                      void (selectedProvider === "pi"
                        ? pi.refreshModels()
                        : selectedProvider === "claude"
                          ? refreshClaudeModels()
                          : refreshCodexModels())
                    }
                    className="hover:text-foreground disabled:opacity-50"
                  >
                    Refresh
                  </button>
                </div>
                {modelSelectionBlocked && (
                  <p className="px-2 py-2 text-muted-foreground text-xs">
                    {pickerLabel}
                  </p>
                )}
                {(selectedProvider === "pi"
                  ? piModelOptions
                  : selectedProvider === "claude"
                    ? claudeModelOptions
                    : codexModelOptions
                ).map((m) => (
                  <button
                    key={m.id}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm transition-colors",
                      (
                        selectedProvider === "claude"
                          ? selectedClaudeModelInfo?.value === m.id
                          : selectedProvider === "pi"
                            ? selectedPiModel === m.id
                            : selectedCodexModel === m.id
                      )
                        ? "bg-accent text-accent-foreground"
                        : "hover:bg-accent",
                    )}
                    aria-label={
                      "modelId" in m ? `${m.modelId} — ${m.desc}` : m.desc
                    }
                    onClick={() => {
                      if (selectedProvider === "claude") {
                        setSelectedClaudeModel(m.id as ClaudeModelId);
                      } else if (selectedProvider === "pi") {
                        setSelectedPiModel(m.id);
                      } else {
                        setSelectedCodexModel(m.id as CodexModelId);
                      }
                    }}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="break-words font-medium text-xs">
                        {m.name}
                      </div>
                      {"modelId" in m && (
                        <div className="truncate font-mono text-[10px] text-muted-foreground">
                          {String(m.modelId)}
                        </div>
                      )}
                      <ModelDescription description={m.desc} />
                    </div>
                    {(selectedProvider === "claude"
                      ? selectedClaudeModelInfo?.value === m.id
                      : selectedProvider === "pi"
                        ? selectedPiModel === m.id
                        : selectedCodexModel === m.id) && (
                      <CheckIcon className="size-3 shrink-0" />
                    )}
                  </button>
                ))}
              </div>

              {selectedProvider === "codex" && (
                <>
                  <PopupSeparator />
                  <div className="flex shrink-0 items-center justify-between px-2 py-1.5 text-xs">
                    <span className="flex items-center gap-1.5 font-medium text-muted-foreground">
                      Fast mode
                      <ZapIcon
                        aria-hidden="true"
                        data-fast-mode-icon=""
                        className="size-3 shrink-0"
                        fill={selectedCodexFastMode ? "currentColor" : "none"}
                      />
                    </span>
                    <Hint content="Faster responses on supported models. Uses more allowance. Applies to the next message.">
                      <button
                        type="button"
                        role="switch"
                        aria-label="Fast mode"
                        aria-checked={selectedCodexFastMode}
                        onClick={() =>
                          setSelectedCodexFastMode(!selectedCodexFastMode)
                        }
                        className="flex h-6 shrink-0 items-center rounded-md"
                      >
                        <SettingsSwitch
                          checked={selectedCodexFastMode}
                          size="sm"
                          indicatorOnly
                        />
                      </button>
                    </Hint>
                  </div>
                </>
              )}
              {showEffort && (
                <>
                  <PopupSeparator />

                  {/* Effort level */}
                  <div className="shrink-0 px-2 py-1.5">
                    <div className="mb-1.5 flex items-center justify-between">
                      <span className="font-medium text-muted-foreground text-xs">
                        Effort
                      </span>
                      <span className="text-muted-foreground text-xs">
                        {claudeEffortLabel(selectedEffort)}
                      </span>
                    </div>
                    <ButtonGroup
                      aria-label="Effort"
                      className="flex flex-wrap gap-1"
                    >
                      {effortOptions.map((level) => (
                        <Hint
                          content={
                            selectedProvider === "claude"
                              ? claudeEffortLabel(level as ClaudeEffortLevel)
                              : codexEffortLabel(level)
                          }
                          key={level}
                        >
                          <button
                            aria-pressed={selectedEffort === level}
                            aria-label={
                              selectedProvider === "claude"
                                ? claudeEffortLabel(level as ClaudeEffortLevel)
                                : codexEffortLabel(level)
                            }
                            className={cn(
                              "min-w-8 flex-1 rounded-md px-1 py-1.5 text-center font-medium text-xs transition-colors",
                              selectedEffort === level
                                ? "bg-background text-foreground shadow-sm"
                                : "text-muted-foreground hover:bg-background/70 hover:text-foreground",
                            )}
                            onClick={() => {
                              if (
                                selectedProvider === "claude" &&
                                (level === "low" ||
                                  level === "medium" ||
                                  level === "high" ||
                                  level === "xhigh" ||
                                  level === "max")
                              ) {
                                setEffortLevel(level);
                              } else if (selectedProvider === "pi") {
                                setSelectedPiReasoningEffort(level);
                              } else {
                                setSelectedCodexReasoningEffort(level);
                              }
                            }}
                          >
                            {effortShortLabel(level)}
                          </button>
                        </Hint>
                      ))}
                    </ButtonGroup>
                  </div>
                </>
              )}
            </ModelPickerTransition>
          </PopupSurface>,
          document.body,
        )}

      {/* @ mention dropdown — portal to body to escape drawer clipping */}
      {slashQuery === null &&
        mentionQuery !== null &&
        mentionFiles.length > 0 &&
        createPortal(
          <div
            ref={mentionPopupRef}
            data-ui-surface="popover"
            className="popup-glass popup-motion app-scrollbar fixed max-h-48 overflow-y-auto rounded-xl border border-[color:var(--popup-surface-border,var(--border))] bg-[var(--popup-surface-background,var(--background))] shadow-[0_0_0_transparent,var(--popup-surface-shadow,var(--shadow-lg))]"
            style={{
              left: mentionPickerPos.left,
              right: mentionPickerPos.right,
              bottom: mentionPickerPos.bottom,
              zIndex: 9999,
            }}
          >
            {mentionFiles.map((file, i) => {
              const parts = file.relativePath.split("/");
              const fileName = parts.pop()!;
              const dirPath = parts.length > 0 ? `${parts.join("/")}/` : "";
              return (
                <button
                  key={file.id}
                  data-active={i === mentionIndex}
                  className={cn(
                    "flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors",
                    i === mentionIndex
                      ? "bg-accent text-accent-foreground"
                      : "hover:bg-muted",
                  )}
                  onMouseDown={(e) => {
                    e.preventDefault(); // prevent textarea blur
                    selectMention(file);
                  }}
                  onMouseEnter={() => setMentionIndex(i)}
                >
                  {getFileIcon(file)}
                  <span className="truncate font-mono text-sm">{fileName}</span>
                  {dirPath && (
                    <span className="ml-auto shrink-0 font-mono text-muted-foreground text-xs">
                      {dirPath}
                    </span>
                  )}
                </button>
              );
            })}
          </div>,
          document.body,
        )}

      <div data-chat-feedback-slot="above" />
      <div
        ref={inputSurfaceRef}
        className={cn(
          "flex min-h-0 w-full flex-col rounded-xl border transition-colors",
          showErrorPanel
            ? "border-[#cf454b] bg-[#cf454b] text-white"
            : "border-input bg-muted/30",
          !showErrorPanel &&
            (activeQuestion
              ? "has-[form:focus-within]:border-foreground has-[form:focus-within]:bg-background"
              : "focus-within:border-ring focus-within:bg-background"),
          !showErrorPanel && isDragOver && "border-ring bg-accent/20",
        )}
        data-chat-composer-surface="true"
      >
        {hasQueuedPrompts && (
          <section
            aria-label="Queued prompts"
            className={cn(
              "relative shrink-0 border-inherit p-2 pl-1 after:pointer-events-none after:absolute after:inset-x-3 after:bottom-0 after:border-inherit after:border-b [@media(max-height:650px)]:py-1",
              showErrorPanel &&
                "rounded-t-[inherit] bg-background text-foreground",
            )}
            data-chat-prompt-queue="true"
          >
            <div
              className={cn(
                "flex items-center justify-between gap-2 px-0.5 text-muted-foreground text-xs",
                !queueFolded && "pb-1",
              )}
            >
              <button
                type="button"
                aria-expanded={!queueFolded}
                aria-controls={queueListId}
                className="flex min-w-0 items-center gap-1 rounded-sm hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                onClick={() => toggleQueueFolded(queueMode)}
              >
                <span className="flex w-6 shrink-0 justify-center">
                  <ChevronDownIcon
                    aria-hidden="true"
                    className={cn(
                      "size-3 shrink-0",
                      queueFolded && "-rotate-90",
                    )}
                  />
                </span>
                <span>
                  {queueWaiting ? "Queue paused" : "Queued"} ·{" "}
                  {queuedPrompts.length}
                </span>
              </button>
              {queueWaiting && !isStreaming && (
                <TooltipIconButton
                  tooltip="Resume queue"
                  className="size-5"
                  disabled={
                    !!queueTab?.error ||
                    providerDisabled ||
                    !!sendBlockedReason ||
                    modelSelectionBlocked
                  }
                  onClick={() =>
                    void useAgentChatStore
                      .getState()
                      .resumePromptQueue(activeTabId)
                  }
                >
                  <PlayIcon className="size-3" />
                </TooltipIconButton>
              )}
            </div>
            <DndContext
              key={`${activeTabId}:${queueMode}:${queueFolded}:${queueTab?.dispatchingQueuedPromptId ?? ""}`}
              sensors={queueSensors}
              collisionDetection={closestCenter}
              modifiers={[restrictToVerticalAxis]}
              onDragEnd={({ active, over }) => {
                if (over && active.id !== over.id)
                  useAgentChatStore
                    .getState()
                    .moveQueuedPrompt(
                      activeTabId,
                      String(active.id),
                      String(over.id),
                    );
              }}
              accessibility={{
                screenReaderInstructions: {
                  draggable:
                    "Use Up and Down arrow keys to reorder this queued prompt.",
                },
              }}
            >
              <SortableContext
                items={queuedPrompts.map((item) => item.id)}
                strategy={verticalListSortingStrategy}
              >
                {/* Show 2.5 rows, or 1.5 rows in short windows (28px rows, 2px gaps). */}
                <ol
                  id={queueListId}
                  hidden={queueFolded}
                  className="max-h-[4.625rem] space-y-0.5 overflow-y-auto [@media(max-height:650px)]:max-h-[2.75rem]"
                >
                  {queuedPrompts.map((item, index) => {
                    const dispatching =
                      queueTab?.dispatchingQueuedPromptId === item.id;
                    const store = useAgentChatStore.getState;
                    return (
                      <QueuedPromptRow
                        key={item.id}
                        id={item.id}
                        index={index}
                        disabled={dispatching || queueFolded}
                        onStep={(direction) => {
                          const target = queuedPrompts[index + direction];
                          if (target)
                            store().moveQueuedPrompt(
                              activeTabId,
                              item.id,
                              target.id,
                            );
                        }}
                      >
                        <span
                          className="min-w-0 flex-1 self-center truncate text-xs"
                          title={item.prompt}
                        >
                          {item.prompt || "Attached context"}
                          {item.context.length > 0 && (
                            <span className="ml-1 text-muted-foreground">
                              · {item.context.length} attached
                            </span>
                          )}
                        </span>
                        <div
                          data-queued-prompt-actions="true"
                          className="pointer-events-none absolute top-0.5 right-0.5 flex gap-1 rounded-md bg-background opacity-0 ring-1 ring-border ring-inset group-focus-within/queued-prompt:pointer-events-auto group-focus-within/queued-prompt:opacity-100 group-hover/queued-prompt:pointer-events-auto group-hover/queued-prompt:opacity-100"
                        >
                          <TooltipIconButton
                            tooltip="Edit queued prompt"
                            disabled={
                              dispatching || showErrorPanel || !!activeQuestion
                            }
                            className="size-6 shrink-0"
                            onClick={() => {
                              const draft = store().editQueuedPrompt(
                                activeTabId,
                                item.id,
                              );
                              if (!draft) return;
                              setInput(draft.input);
                              setPinnedContexts(draft.pinnedContexts);
                              setMentionQuery(null);
                              setSlashQuery(null);
                              slashRangeRef.current = null;
                              textareaRef.current?.focus({
                                preventScroll: true,
                              });
                            }}
                          >
                            <svg
                              aria-hidden="true"
                              className="size-3.5"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth={2}
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            >
                              {EDIT_ICON_PATHS.map((path) => (
                                <path key={path} d={path} />
                              ))}
                            </svg>
                          </TooltipIconButton>
                          <TooltipIconButton
                            tooltip="Remove queued prompt"
                            disabled={dispatching}
                            className="size-6 shrink-0"
                            onClick={() =>
                              store().removeQueuedPrompt(activeTabId, item.id)
                            }
                          >
                            <XIcon className="size-3.5" />
                          </TooltipIconButton>
                        </div>
                      </QueuedPromptRow>
                    );
                  })}
                </ol>
              </SortableContext>
            </DndContext>
          </section>
        )}
        {providerDisabled && !isStreaming ? (
          <ChatErrorPanel
            message={
              noProvidersEnabled
                ? "No AI provider enabled"
                : `${providerName} is disabled`
            }
            guidance={
              <p className="mt-1 text-white/80">
                Enable an AI provider in Settings to start chatting.
              </p>
            }
            agentName=""
            effort=""
            actions={[
              ...(noProvidersEnabled && projectRoot
                ? [
                    {
                      label: "Artisan Mode",
                      onClick: () =>
                        window.dispatchEvent(
                          new Event(ARTISAN_MODE_REQUEST_EVENT),
                        ),
                    },
                  ]
                : []),
              ...(alternativeProvider
                ? [
                    {
                      label: `Use ${alternativeProvider === "pi" ? "Pi" : alternativeProvider === "claude" ? "Claude" : "Codex"}`,
                      onClick: () => setProvider(alternativeProvider),
                    },
                  ]
                : []),
              {
                label: "Agent Settings",
                primary: true,
                onClick: () => {
                  void invoke("open_settings_window", {
                    section: "agent",
                    provider: selectedProvider,
                  }).catch((error) =>
                    toast.error(`Could not open Settings: ${String(error)}`),
                  );
                },
              },
            ]}
          />
        ) : renderErrorPreview && composerError ? (
          renderErrorPreview({
            agentName: pickerLabel,
            effort: effortShortLabel(selectedEffort),
          })
        ) : selectedProvider === "codex" &&
          composerError?.startsWith("Could not resume Codex session:") ? (
          <CodexSessionRecovery
            key={activeTabId}
            agentName={codexPickerLabel}
            effort={effortShortLabel(selectedCodexReasoningEffort)}
          />
        ) : visibleError ? (
          <ChatErrorRecovery
            key={activeTabId + selectedProvider + errorSource + visibleError}
            message={visibleError}
            source={errorSource}
            provider={selectedProvider}
            agentName={
              selectedProvider === "claude"
                ? claudeModelLabel(selectedClaudeModel, discoveredClaudeModels)
                : selectedProvider === "pi"
                  ? piPickerLabel
                  : formatCodexModelName(selectedCodexModel)
            }
            effort={effortShortLabel(selectedEffort)}
            canFix={
              !!projectRoot &&
              !isStreaming &&
              !modelSelectionBlocked &&
              !sendBlockedReason &&
              !pendingResumeChoice &&
              (selectedProvider === "pi"
                ? piReady
                : selectedProvider === "claude"
                  ? claudeReady
                  : codexReady)
            }
          />
        ) : (
          <>
            <div data-chat-feedback-slot="inside" />
            <AgentQuestionPrompt
              customAnswerContext={
                answerContexts
                  ? { contexts: answerContexts, badges: contextBadges }
                  : undefined
              }
            />
            {!activeQuestion && contextBadges}

            {isDragOver ? (
              <div className="flex min-h-10 shrink-0 items-center justify-center px-4 py-3 text-muted-foreground text-sm">
                <PaperclipIcon className="mr-2 size-4" />
                Drop files to attach
              </div>
            ) : pendingResumeChoice ? (
              <div className="shrink-0 space-y-3 px-4 py-3">
                <div className="font-medium text-sm">
                  Choose LLM for this resumed chat
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  <button
                    type="button"
                    className="flex min-w-0 flex-col items-start gap-2 rounded-lg border border-border/70 bg-background px-3 py-3 text-left transition-colors hover:bg-muted/40"
                    onClick={() => void resolvePendingResumeChoice(true)}
                  >
                    <div className="flex items-center gap-2">
                      <Badge
                        variant="outline"
                        className="px-1.5 py-0 text-[10px] leading-4"
                      >
                        Session LLM
                      </Badge>
                      <Badge
                        variant="outline"
                        className={cn(
                          "px-1.5 py-0 text-[10px] leading-4",
                          providerBadgeClasses(
                            pendingResumeChoice.sessionProvider,
                          ),
                        )}
                      >
                        {pendingResumeChoice.sessionProvider === "pi"
                          ? "Pi"
                          : pendingResumeChoice.sessionProvider === "claude"
                            ? "Claude"
                            : "Codex"}
                      </Badge>
                    </div>
                    <div className="text-sm">{previousLlmLabel}</div>
                  </button>
                  <button
                    type="button"
                    className="flex min-w-0 flex-col items-start gap-2 rounded-lg border border-border/70 bg-background px-3 py-3 text-left transition-colors hover:bg-muted/40"
                    onClick={() => void resolvePendingResumeChoice(false)}
                  >
                    <div className="flex items-center gap-2">
                      <Badge
                        variant="outline"
                        className="px-1.5 py-0 text-[10px] leading-4"
                      >
                        Current LLM
                      </Badge>
                      <Badge
                        variant="outline"
                        className={cn(
                          "px-1.5 py-0 text-[10px] leading-4",
                          providerBadgeClasses(selectedProvider),
                        )}
                      >
                        {providerName}
                      </Badge>
                    </div>
                    <div className="text-sm">{currentLlmLabel}</div>
                  </button>
                </div>
              </div>
            ) : activeQuestion ? null : isCollapsed ? (
              <div className="@container/mini-composer flex shrink-0 items-end gap-1 py-2 pr-2 pl-1.5">
                <textarea
                  ref={attachMiniTextarea}
                  data-chat-composer-input="true"
                  value={input}
                  onChange={handleInput}
                  onKeyDown={handleKeyDown}
                  onPaste={handlePaste}
                  placeholder={
                    pinnedContexts.some(isPromptSelection)
                      ? "Ask about this selection…"
                      : "Message…"
                  }
                  className="scrollbar-none max-h-12 min-w-0 flex-1 resize-none overflow-y-auto overflow-x-hidden bg-transparent py-[5px] pr-2 pl-1.5 text-sm leading-[18px] outline-none placeholder:truncate placeholder:text-muted-foreground"
                  rows={1}
                />

                <div className="flex shrink-0 items-center gap-1">
                  {agentControls}

                  {submitControl}
                </div>
              </div>
            ) : (
              <>
                <textarea
                  ref={textareaRef}
                  data-chat-composer-input="true"
                  value={input}
                  onChange={handleInput}
                  onKeyDown={handleKeyDown}
                  onPaste={handlePaste}
                  placeholder={
                    pinnedContexts.some(isPromptSelection)
                      ? "Ask about this selection…"
                      : `Write with ${PRODUCT_NAME}…`
                  }
                  className="scrollbar-none max-h-40 min-h-10 w-full shrink-0 resize-none overflow-y-auto overflow-x-hidden bg-transparent pt-[13px] pr-4 pb-[3px] pl-3 text-sm outline-none placeholder:text-muted-foreground"
                  rows={1}
                />

                <div
                  ref={setToolbarElement}
                  data-chat-composer-toolbar
                  className="relative flex shrink-0 items-center justify-end px-2 pb-2 [--composer-collapse-ease:cubic-bezier(0.8,0,0.6,1)]"
                  onBlur={(event) => {
                    if (
                      toolbarShortcutsOpen &&
                      !event.currentTarget.contains(event.relatedTarget)
                    ) {
                      setToolbarShortcutsOpen(false);
                    }
                  }}
                  onKeyDown={(event) => {
                    if (!toolbarShortcutsOpen || event.key !== "Escape") return;
                    event.preventDefault();
                    event.stopPropagation();
                    setToolbarShortcutsOpen(false);
                    toolbarToggleRef.current?.focus({ preventScroll: true });
                  }}
                >
                  <div className="flex min-h-7 min-w-6 flex-1 items-center overflow-x-clip">
                    <div
                      data-composer-shortcuts-track
                      className={cn(
                        "relative flex h-7 shrink-0 items-center overflow-hidden transition-[width] duration-200 motion-reduce:transition-none",
                        showToolbarShortcuts
                          ? "w-(--composer-shortcuts-width) ease-in-out"
                          : "w-6 ease-(--composer-collapse-ease)",
                        toolbarShortcutsOpen &&
                          "w-[calc(var(--composer-shortcuts-width)+1.5rem)]",
                      )}
                    >
                      <button
                        ref={toolbarToggleRef}
                        type="button"
                        aria-label={
                          toolbarShortcutsOpen
                            ? "Hide composer shortcuts"
                            : "Show composer shortcuts"
                        }
                        aria-expanded={toolbarShortcutsOpen}
                        aria-hidden={!compactToolbar || undefined}
                        inert={!compactToolbar}
                        onClick={() => setToolbarShortcutsOpen((open) => !open)}
                        className={cn(
                          "absolute left-0 z-10 flex h-7 w-6 items-center justify-center rounded-md text-muted-foreground transition-opacity duration-100 hover:bg-muted hover:text-foreground motion-reduce:transition-none",
                          compactToolbar
                            ? "delay-100 ease-(--composer-collapse-ease)"
                            : "opacity-0",
                        )}
                      >
                        {toolbarShortcutsOpen ? (
                          <MinusIcon className="size-3.5" aria-hidden="true" />
                        ) : (
                          <PlusIcon className="size-3.5" aria-hidden="true" />
                        )}
                      </button>
                      <div
                        data-composer-shortcuts
                        aria-hidden={!showToolbarShortcuts || undefined}
                        inert={!showToolbarShortcuts}
                        className={cn(
                          "flex w-max shrink-0 items-center whitespace-nowrap transition-[opacity,translate] duration-100 motion-reduce:transition-none",
                          compactToolbar && "translate-x-6",
                          showToolbarShortcuts
                            ? "delay-75"
                            : "opacity-0 delay-25 ease-(--composer-collapse-ease)",
                        )}
                      >
                        <button
                          type="button"
                          onClick={openSlashTrigger}
                          className="rounded-md px-1 py-1 text-muted-foreground text-xs transition-colors hover:bg-muted hover:text-foreground"
                        >
                          / commands
                        </button>
                        <button
                          type="button"
                          onClick={openMentionTrigger}
                          className="rounded-md px-1 py-1 text-muted-foreground text-xs transition-colors hover:bg-muted hover:text-foreground"
                        >
                          @ mention
                        </button>
                      </div>
                    </div>
                  </div>

                  {/* Reserve space for Send even while the agent controls fade. */}
                  <div
                    aria-hidden="true"
                    className={cn(
                      "shrink-0 transition-[width] duration-200 motion-reduce:transition-none",
                      toolbarShortcutsOpen
                        ? "w-(--composer-submit-width) ease-in-out"
                        : "w-(--composer-controls-width) ease-(--composer-collapse-ease)",
                    )}
                  />
                  <div
                    data-composer-controls
                    className={cn(
                      "absolute right-2 flex min-w-0 max-w-[calc(100%-2.5rem)] items-center gap-1",
                      // Let clicks pass through the space behind the fading controls.
                      toolbarShortcutsOpen &&
                        "pointer-events-none [&>[data-composer-submit]]:pointer-events-auto",
                    )}
                  >
                    <div
                      data-composer-agent-controls
                      aria-hidden={toolbarShortcutsOpen || undefined}
                      inert={toolbarShortcutsOpen}
                      className={cn(
                        "min-w-0 transition-opacity duration-200 motion-reduce:transition-none",
                        toolbarShortcutsOpen
                          ? "opacity-0 ease-in-out"
                          : "ease-(--composer-collapse-ease)",
                      )}
                    >
                      {agentControls}
                    </div>

                    {submitControl}
                  </div>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
};
