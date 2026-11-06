import type { TabState } from "@/stores/agent-chat-store";
import {
  captureProposedDraft,
  isEarlierDraftContext,
  isSelectionRangeContextLabel,
  type ChatContextBadge,
} from "./chat-context";

/** One visibility rule for Mini, Half, and Full, including rejected sends. */
export function areLibraryPromptsExpanded(
  tab: TabState | undefined,
  pinned: boolean,
  autoExpand = true,
): boolean {
  const hasConversation = Boolean(
    tab &&
      (tab.messages.length ||
        tab.history?.total ||
        tab.sessionId ||
        tab.sharedSessionId ||
        Object.values(tab.providerSessionIds).some(Boolean)),
  );
  return (
    pinned || (tab?.miniPromptsExpanded ?? (autoExpand && !hasConversation))
  );
}

export const PROMPT_ICON_NAMES = [
  "spell-check",
  "pencil",
  "lightbulb",
  "list-tree",
  "search",
  "languages",
  "file-text",
  "list-checks",
  "book-open",
  "quote",
  "code",
  "calculator",
  "sparkles",
  "message-circle",
  "target",
  "wand-sparkles",
] as const;
export type PromptIconName =
  keyof typeof import("lucide-react/dynamicIconImports").default;

export interface LibraryPrompt {
  id: string;
  title: string;
  prompt: string;
  availability: "always" | "selection" | "issues";
  enabled: boolean;
  /** Missing uses the default icon, null explicitly hides it. */
  icon?: PromptIconName | null;
}

export const PROMPT_AVAILABILITY_OPTIONS: Array<{
  value: LibraryPrompt["availability"];
  label: string;
}> = [
  { value: "always", label: "Always" },
  { value: "selection", label: "Has text selection" },
  { value: "issues", label: "Has issues" },
];

export interface PromptDiagnostic {
  from: number | null;
  to: number | null;
  line: number | null;
  endLine: number | null;
  severity: string;
  message: string;
}

/** Transient diagnostics from the same editor snapshot shown in Problems. */
export interface PromptDiagnosticSnapshot {
  projectRoot: string | null;
  draftSessionId: string | null;
  filePath: string;
  content: string;
  issues: PromptDiagnostic[];
}

const PREVIOUS_PROMPT_LIBRARY: LibraryPrompt[] = [
  {
    id: "proofread",
    title: "Proofread",
    icon: "spell-check",
    prompt:
      "Proofread the attached text and fix spelling, grammar, and punctuation. Preserve its meaning, style, and markup.",
    availability: "always",
    enabled: true,
  },
  {
    id: "fix-issues",
    title: "Fix issues",
    icon: "wand-sparkles",
    prompt:
      "Fix the attached issues in the provided text. Preserve its intended meaning and markup, and verify the fixes.",
    availability: "issues",
    enabled: true,
  },
  {
    id: "explain-selection",
    title: "Explain selection",
    icon: "lightbulb",
    prompt:
      "Explain the selected text in plain language, including any notation or assumptions. Do not edit the document.",
    availability: "selection",
    enabled: true,
  },
  {
    id: "improve-writing",
    title: "Improve writing",
    icon: "list-tree",
    prompt:
      "Improve the clarity, flow, and structure of the attached text. Address repetition, unclear transitions, and logical gaps while preserving its meaning, technical details, citations, and markup.",
    availability: "always",
    enabled: true,
  },
];

export const DEFAULT_PROMPT_LIBRARY: LibraryPrompt[] = [
  {
    ...PREVIOUS_PROMPT_LIBRARY[3],
    icon: "spell-check",
    prompt:
      "Improve the attached text’s spelling, grammar, punctuation, clarity, flow, and structure. Preserve its intended meaning, voice, technical details, citations, and markup. Make only changes that improve the text.",
  },
  PREVIOUS_PROMPT_LIBRARY[1],
  {
    id: "review-and-comment",
    title: "Review & comment",
    icon: "message-circle",
    prompt:
      "Review the attached text for unclear reasoning, gaps, and actionable improvements. Use the create_comment tool to leave concise comments anchored to exact source passages. Keep comments focused on meaningful findings and do not edit the document. If comments cannot be created, report the findings with their locations in chat.",
    availability: "always",
    enabled: true,
  },
  {
    id: "tighten-layout",
    title: "Tighten layout",
    icon: "list-tree",
    prompt:
      "Inspect the rendered document and tighten its layout with small, targeted edits. If text is selected, focus on that passage, especially paragraph-ending lines with only one or two words. Otherwise, look for awkward breaks and avoidable page spillover across the document. Preserve meaning, citations, readability, and required formatting. Keep the existing font size and margins. Re-render when possible to check the result and report what improved.",
    availability: "always",
    enabled: true,
  },
];

// Keep the editor and storage APIs available until customization returns.
export const PROMPT_CUSTOMIZATION_ENABLED: boolean = false;

/** Release UI uses stock content, retaining only saved ordering and toggles. */
export function visiblePromptLibrary(saved: LibraryPrompt[]): LibraryPrompt[] {
  if (PROMPT_CUSTOMIZATION_ENABLED) return saved;
  const remaining = new Map(
    DEFAULT_PROMPT_LIBRARY.map((prompt) => [prompt.id, prompt]),
  );
  const prompts = saved.flatMap((prompt) => {
    const stock = remaining.get(prompt.id);
    if (!stock) return [];
    remaining.delete(prompt.id);
    return [{ ...stock, enabled: prompt.enabled }];
  });
  return [
    ...prompts,
    ...Array.from(remaining.values(), (prompt) => ({ ...prompt })),
  ];
}

const LEGACY_WRITING_DEFAULTS = [
  {
    id: "improve-clarity",
    title: "Improve clarity",
    prompt:
      "Improve the clarity and flow of the attached text. Keep its meaning, technical details, citations, and markup intact.",
    context: "auto",
    icon: "pencil",
  },
  {
    id: "review-structure",
    title: "Review structure",
    prompt:
      "Review the structure and logical flow of the attached document. Identify gaps, repetition, and unclear transitions, and suggest concrete improvements. Do not edit the document yet.",
    context: "document",
    icon: "list-tree",
  },
] as const;

/** Replace the two previous stock icons during the settings upgrade. */
export function migrateStockPromptIcons(
  library: LibraryPrompt[],
): LibraryPrompt[] {
  const previousIcons: Partial<Record<string, PromptIconName>> = {
    "improve-writing": "list-tree",
    "tighten-layout": "target",
  };
  return library.map((prompt) => {
    const previousIcon = previousIcons[prompt.id];
    if (!previousIcon || prompt.icon !== previousIcon) return prompt;
    const stock = DEFAULT_PROMPT_LIBRARY.find((item) => item.id === prompt.id);
    if (
      !stock ||
      prompt.title !== stock.title ||
      prompt.prompt !== stock.prompt ||
      prompt.availability !== stock.availability
    )
      return prompt;
    return { ...prompt, icon: stock.icon };
  });
}

/** Missing settings get defaults; an intentionally empty library stays empty. */
export function normalizePromptLibrary(value: unknown): LibraryPrompt[] {
  if (!Array.isArray(value))
    return DEFAULT_PROMPT_LIBRARY.map((prompt) => ({ ...prompt }));
  const replaceWritingDefaults =
    LEGACY_WRITING_DEFAULTS.every((original) =>
      value.some(
        (item) =>
          item &&
          item.id === original.id &&
          item.title === original.title &&
          item.prompt === original.prompt &&
          item.context === original.context &&
          item.enabled !== false &&
          (item.icon === undefined || item.icon === original.icon),
      ),
    ) &&
    !value.some(
      (item) => item?.id === "fix-issues" || item?.id === "improve-writing",
    );
  const previousEntries = replaceWritingDefaults
    ? value.map((item) =>
        item?.id === "improve-clarity"
          ? PREVIOUS_PROMPT_LIBRARY[1]
          : item?.id === "review-structure"
            ? PREVIOUS_PROMPT_LIBRARY[3]
            : item,
      )
    : value;
  // Upgrade the complete stock set in place, preserving custom cards and
  // libraries with edited, disabled, deleted, or reordered defaults.
  const stockEntries = previousEntries.filter((item) =>
    PREVIOUS_PROMPT_LIBRARY.some((original) => original.id === item?.id),
  );
  const upgradeStock =
    stockEntries.length === PREVIOUS_PROMPT_LIBRARY.length &&
    !previousEntries.some(
      (item) =>
        item?.id === "review-and-comment" || item?.id === "tighten-layout",
    ) &&
    PREVIOUS_PROMPT_LIBRARY.every((original, index) => {
      const item = stockEntries[index];
      return (
        item.id === original.id &&
        item.title === original.title &&
        item.prompt === original.prompt &&
        (item.availability ??
          (item.context === "selection" ? "selection" : "always")) ===
          original.availability &&
        item.enabled !== false &&
        (item.icon === undefined ||
          item.icon === original.icon ||
          (original.id === "improve-writing" && item.icon === "pencil"))
      );
    });
  let stockIndex = 0;
  const entries = upgradeStock
    ? previousEntries.map((item) =>
        PREVIOUS_PROMPT_LIBRARY.some((original) => original.id === item?.id)
          ? DEFAULT_PROMPT_LIBRARY[stockIndex++]
          : item,
      )
    : previousEntries;
  const ids = new Set<string>();
  return entries.flatMap((item): LibraryPrompt[] => {
    if (
      !item ||
      typeof item !== "object" ||
      typeof item.id !== "string" ||
      !item.id.trim() ||
      ids.has(item.id) ||
      typeof item.title !== "string" ||
      !item.title.trim() ||
      typeof item.prompt !== "string" ||
      !item.prompt.trim()
    )
      return [];
    ids.add(item.id);
    return [
      {
        id: item.id,
        title: item.title.trim(),
        prompt: item.prompt,
        availability: PROMPT_AVAILABILITY_OPTIONS.some(
          (option) => option.value === item.availability,
        )
          ? item.availability
          : item.context === "selection"
            ? "selection"
            : "always",
        enabled: item.enabled !== false,
        // Validate the saved key without loading the icon catalog at startup.
        ...(item.icon === null ||
        (typeof item.icon === "string" &&
          /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item.icon))
          ? { icon: item.icon }
          : {}),
      },
    ];
  });
}

export function defaultPromptIconName(id: string): PromptIconName {
  return (
    DEFAULT_PROMPT_LIBRARY.find((item) => item.id === id)?.icon ??
    PREVIOUS_PROMPT_LIBRARY.find((item) => item.id === id)?.icon ??
    LEGACY_WRITING_DEFAULTS.find((item) => item.id === id)?.icon ??
    "bookmark"
  );
}

export function resolvePromptIcon(
  prompt: LibraryPrompt,
): PromptIconName | null {
  return prompt.icon === undefined
    ? defaultPromptIconName(prompt.id)
    : prompt.icon;
}

export function isPromptSelection(context: ChatContextBadge) {
  return (
    !context.comment &&
    !context.imageDataUrl &&
    Boolean(context.selectedText.trim()) &&
    (context.selectionPinned || isSelectionRangeContextLabel(context.label)) &&
    !context.selectionKey?.startsWith("file:")
  );
}

/** Resolve a captured selection against this exact text; stale snapshots never
 * borrow diagnostics from another file, draft, or edited selection. */
function selectionLines(selection: ChatContextBadge, content: string) {
  const match = selection.label.match(
    /:(\d+):(\d+)-(\d+):(\d+)(?: · PDF p\.\d+)?$/,
  );
  if (!match) return null;
  const [startLine, startColumn, endLine, endColumn] = match
    .slice(1)
    .map(Number);
  const lines = content.split("\n");
  const offset = (line: number, column: number) => {
    if (
      line < 1 ||
      line > lines.length ||
      column < 1 ||
      column > lines[line - 1].length + 1
    )
      return null;
    return (
      lines
        .slice(0, line - 1)
        .reduce((length, text) => length + text.length + 1, 0) +
      column -
      1
    );
  };
  const from = offset(startLine, startColumn),
    to = offset(endLine, endColumn);
  if (
    from === null ||
    to === null ||
    from >= to ||
    content.slice(from, to) !== selection.selectedText
  )
    return null;
  return { first: startLine, last: endColumn === 1 ? endLine - 1 : endLine };
}

export function resolveLibraryPromptContext(
  prompt: LibraryPrompt,
  contexts: ChatContextBadge[],
  file:
    | {
        relativePath: string;
        content?: string;
        type: string;
        isBinary?: boolean;
      }
    | undefined,
  draftSessionId: string | null,
  snapshot: PromptDiagnosticSnapshot | null = null,
  projectRoot: string | null = null,
): { context?: ChatContextBadge; unavailable?: string } {
  const selection =
    contexts.find(
      (context) => isPromptSelection(context) && !context.selectionPinned,
    ) ?? contexts.find(isPromptSelection);
  const textFile =
    file &&
    !file.isBinary &&
    typeof file.content === "string" &&
    !["pdf", "image"].includes(file.type)
      ? file
      : undefined;
  const context: ChatContextBadge | undefined = selection
    ? { ...selection, selectionPinned: true }
    : textFile
      ? {
          label: `@${textFile.relativePath}`,
          filePath: textFile.relativePath,
          selectedText: textFile.content!,
          selectionKey: `file:${textFile.relativePath}`,
          proposedDraft: captureProposedDraft(draftSessionId, textFile.content),
        }
      : undefined;
  if (prompt.availability === "selection" && !selection)
    return { unavailable: "Select text first" };
  if (prompt.availability !== "issues") return context ? { context } : {};
  const unavailable = selection
    ? "No issues in this selection"
    : "No issues in this file";
  if (
    !context ||
    !textFile ||
    !snapshot ||
    snapshot.projectRoot !== projectRoot ||
    snapshot.draftSessionId !== draftSessionId ||
    snapshot.filePath !== context.filePath ||
    snapshot.filePath !== textFile.relativePath ||
    snapshot.content !== textFile.content ||
    (selection &&
      isEarlierDraftContext(selection, draftSessionId, textFile.content))
  )
    return { unavailable };
  const range = selection ? selectionLines(selection, snapshot.content) : null;
  if (selection && !range) return { unavailable };
  const issues = snapshot.issues.filter(
    (issue) =>
      !range ||
      (issue.line !== null &&
        issue.line <= range.last &&
        (issue.endLine ?? issue.line) >= range.first),
  );
  if (!issues.length) return { unavailable };
  return {
    context: {
      ...context,
      diagnostics: issues.map(({ line, severity, message }) => ({
        line,
        severity,
        message,
      })),
    },
  };
}
