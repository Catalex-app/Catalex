import { createPanelStore } from "@/lib/panel-window-runtime";
import {
  normalizeSpellingLanguage,
  normalizeSpellingWords,
  type SpellingLanguage,
} from "@/lib/spelling/types";
import {
  DEFAULT_WORKSPACE_PREFERENCES,
  normalizeWorkspacePreferencesByProject,
  type ProjectWorkspacePreferences,
} from "@/lib/workspace-mode";
import { synchronizePersistedStore } from "@/lib/persisted-store-sync";
import {
  DEFAULT_MINIMAP_LAYERS,
  normalizeMinimapLayers,
  type MinimapLayer,
  type MinimapLayers,
} from "@/components/workspace/editor/editor-minimap-model";
import { type CustomModel, normalizeCustomModels } from "@/lib/custom-models";
import { persist } from "zustand/middleware";
import {
  migrateStockPromptIcons,
  DEFAULT_PROMPT_LIBRARY,
  normalizePromptLibrary,
  type LibraryPrompt,
} from "@/lib/prompt-library";
import { DEFAULT_AGENT_MD } from "@/lib/default-agent-md";
import {
  DEFAULT_MODE_THEMES,
  normalizeModeThemes,
  type UiThemeId,
  type WorkspaceMode,
} from "@/lib/ui-theme";
import {
  normalizeClaudeModelId,
  type ClaudeEffortLevel,
} from "@/lib/claude-models";
export type { ClaudeEffortLevel } from "@/lib/claude-models";
import {
  GITHUB_DARK_MARKDOWN_THEME_ID,
  GITHUB_LIGHT_MARKDOWN_THEME_ID,
  LEGACY_GITHUB_MARKDOWN_THEME_ID,
} from "@/lib/markdown-theme";
import {
  getDefaultKeyboardShortcut,
  type KeyboardShortcutActionId,
  type KeyboardShortcutOverrides,
  normalizeKeyboardShortcut,
  normalizeKeyboardShortcutOverrides,
} from "@/lib/keyboard-shortcuts";

export type MarkdownMathEngine = "katex" | "mathjax";
export type CompilerBackend = "tectonic" | "latexmk";
export type EditorCommentFilter = "all" | "human" | "agent";
export type ConcreteCompilerEngine = "pdflatex" | "xelatex" | "lualatex";
export type CompilerEngine = "auto" | ConcreteCompilerEngine;
export type ChatProvider = "claude" | "codex" | "pi";
export type DefaultAgent = ChatProvider;
export type ClaudeModelId = string;
export type CodexModelId = string;
export type CodexReasoningEffort = string;
export type AgentExecutionMode = "default" | "edit";
export const INITIAL_CLAUDE_MODEL: ClaudeModelId = "default";
export const INITIAL_CODEX_MODEL: CodexModelId = "default";
export type EditorColorScheme =
  | "default"
  | "ocean"
  | "forest"
  | "sunset"
  | "mono";
export type SolarModeLevel = 0 | 1 | 2 | 3 | 4;
export type CatDisplayMode = "static" | "ccfddl";
export type CatStaticDisplay = "bibilabu" | "hakimi" | "custom";
export type CatDisplayTimezone = "local" | "source" | "utc";
export type CatCountdownPrecision = "dh" | "dhm" | "dhms";

export interface CatCcfddlDeadlineSelection {
  id: string;
  title: string;
  displayTitle: string;
  deadline: string;
  deadlineIso: string;
  sourceTimezone: string;
}

export interface RootCompilerChoice {
  backend: CompilerBackend;
  engine: ConcreteCompilerEngine;
  autoEngine?: boolean;
}

export interface SettingsState {
  skippedUpdateVersions: string[];
  skipUpdateVersion: (version: string) => void;
  showAnswerCompletionTime: boolean;
  toggleAnswerTimeDisplay: () => void;
  workspacePreferencesByProject: Record<string, ProjectWorkspacePreferences>;
  getWorkspacePreferences: (
    projectRoot: string | null,
  ) => ProjectWorkspacePreferences;
  setWorkspacePreferences: (
    projectRoot: string,
    preferences: ProjectWorkspacePreferences,
  ) => void;
  scrollSyncByProject: Record<string, Record<string, boolean>>;
  setFileScrollSync: (
    projectRoot: string,
    fileId: string,
    enabled: boolean,
  ) => void;
  modeThemes: Record<WorkspaceMode, UiThemeId>;
  setModeTheme: (mode: WorkspaceMode, theme: UiThemeId) => void;
  customModels: CustomModel[];
  addCustomModel: (model: CustomModel) => void;
  removeCustomModel: (provider: ChatProvider, id: string) => void;
  defaultAutoCompile: boolean;
  setDefaultAutoCompile: (enabled: boolean) => void;
  autoCompileByProject: Record<string, boolean>;
  getProjectAutoCompile: (projectRoot: string | null) => boolean;
  initializeProjectAutoCompile: (projectRoot: string) => boolean;
  setProjectAutoCompile: (projectRoot: string, enabled: boolean) => void;
  compilerBackend: CompilerBackend;
  compilerEngine: CompilerEngine;
  latexInstallation: string | null;
  compilerChoicesByRoot: Record<string, RootCompilerChoice>;
  enabledProviders: Record<ChatProvider, boolean>;
  setProviderEnabled: (provider: ChatProvider, enabled: boolean) => void;
  defaultAgent: DefaultAgent;
  defaultClaudeModel: ClaudeModelId;
  defaultClaudeEffortLevel: ClaudeEffortLevel;
  piBinaryPaths: string[] | null;
  piConfigDirectories: string[] | null;
  piBinaryPath: string;
  piConfigDirectory: string;
  defaultPiModel: string;
  defaultPiReasoningEffort: string;
  defaultCodexModel: CodexModelId;
  defaultCodexReasoningEffort: CodexReasoningEffort;
  defaultAgentExecutionMode: AgentExecutionMode;
  globalAgentPrompt: string;
  promptLibrary: LibraryPrompt[];
  /** Shared by all chat modes; retain the original persisted key. */
  keepMiniPromptsOpen: boolean;
  setKeepMiniPromptsOpen: (pinned: boolean) => void;
  saveLibraryPrompt: (prompt: LibraryPrompt) => void;
  deleteLibraryPrompt: (id: string) => void;
  moveLibraryPrompt: (
    id: string,
    direction: -1 | 1,
    visibleIds?: string[],
  ) => void;
  editorColorScheme: EditorColorScheme;
  editorFontSize: number;
  spellCheck: boolean;
  spellingLanguage: SpellingLanguage;
  spellingWords: string[];
  setSpellCheck: (enabled: boolean) => void;
  setSpellingLanguage: (language: SpellingLanguage) => void;
  learnSpellingWord: (word: string) => void;
  removeSpellingWord: (word: string) => void;
  showEditorMinimap: boolean;
  setShowEditorMinimap: (visible: boolean) => void;
  editorMinimapLayers: MinimapLayers;
  setEditorMinimapLayer: (layer: MinimapLayer, visible: boolean) => void;
  displayComments: boolean;
  showPdfComments: boolean;
  pdfCommentFullWidth: boolean;
  setPdfCommentFullWidth: (full: boolean) => void;
  setDisplayComments: (visible: boolean) => void;
  setShowPdfComments: (visible: boolean) => void;
  editorProblemsPanelOpenByProject: Record<string, boolean>;
  editorCommentsPanelOpenByProject: Record<string, boolean>;
  editorCommentFilterByProject: Record<string, EditorCommentFilter>;
  markdownLoadTyporaThemes: boolean;
  defaultMarkdownMathEngine: MarkdownMathEngine;
  markdownMathEnginesByFile: Record<string, MarkdownMathEngine>;
  recentMarkdownThemePaths: string[]; // Most recent first, used for eviction.
  recentMarkdownThemeOrder: string[]; // Stable display order.
  recordRecentMarkdownTheme: (path: string) => void;
  markdownThemeDirectory: string | null;
  markdownSeparateLightDarkThemes: boolean;
  markdownPreviewTheme: string;
  markdownPreviewLightTheme: string;
  markdownPreviewDarkTheme: string;
  showTooltips: boolean;
  tooltipHoverDelay: boolean;
  setShowTooltips: (enabled: boolean) => void;
  setTooltipHoverDelay: (enabled: boolean) => void;
  solarModeLevel: SolarModeLevel;
  catDisplayMode: CatDisplayMode;
  catStaticDisplay: CatStaticDisplay;
  catCustomText: string;
  catSelectedCcfddlDeadline: CatCcfddlDeadlineSelection | null;
  catDisplayTimezone: CatDisplayTimezone;
  catCountdownPrecision: CatCountdownPrecision;
  keyboardShortcutOverrides: KeyboardShortcutOverrides;
  setCompilerBackend: (backend: CompilerBackend) => void;
  setLatexInstallation: (path: string | null) => void;
  setCompilerEngine: (engine: CompilerEngine) => void;
  getCompilerChoiceForRoot: (
    projectRoot: string,
    rootFileId: string,
  ) => RootCompilerChoice | undefined;
  initializeCompilerChoiceForRoot: (
    projectRoot: string,
    rootFileId: string,
    detectedEngine?: ConcreteCompilerEngine | null,
  ) => RootCompilerChoice;
  setCompilerChoiceForRoot: (
    projectRoot: string,
    rootFileId: string,
    choice: RootCompilerChoice,
  ) => void;
  setDefaultAgent: (agent: DefaultAgent) => void;
  setDefaultClaudeModel: (model: ClaudeModelId) => void;
  setDefaultClaudeEffortLevel: (level: ClaudeEffortLevel) => void;
  removePiBinaryPath: (path: string) => void;
  removePiConfigDirectory: (path: string) => void;
  setPiBinaryPath: (path: string) => void;
  setPiConfigDirectory: (path: string) => void;
  setDefaultPiModel: (model: string) => void;
  setDefaultPiReasoningEffort: (level: string) => void;
  setDefaultCodexModel: (model: CodexModelId) => void;
  setDefaultCodexReasoningEffort: (level: CodexReasoningEffort) => void;
  setDefaultAgentExecutionMode: (mode: AgentExecutionMode) => void;
  setGlobalAgentPrompt: (prompt: string) => void;
  resetGlobalAgentPrompt: () => void;
  setEditorColorScheme: (scheme: EditorColorScheme) => void;
  setEditorFontSize: (fontSize: number) => void;
  setEditorProblemsPanelOpen: (projectKey: string, open: boolean) => void;
  setEditorCommentsPanelOpen: (projectKey: string, open: boolean) => void;
  setEditorInfoBar: (
    projectKey: string,
    bar: "problems" | "comments" | null,
  ) => void;
  setEditorCommentFilter: (
    projectKey: string,
    filter: EditorCommentFilter,
  ) => void;
  setMarkdownLoadTyporaThemes: (enabled: boolean) => void;
  setDefaultMarkdownMathEngine: (engine: MarkdownMathEngine) => void;
  getMarkdownMathEngineForFile: (
    projectRoot: string | null,
    fileId: string | null,
  ) => MarkdownMathEngine;
  setMarkdownMathEngineForFile: (
    projectRoot: string,
    fileId: string,
    engine: MarkdownMathEngine,
  ) => void;
  setMarkdownThemeDirectory: (directory: string | null) => void;
  setMarkdownSeparateLightDarkThemes: (enabled: boolean) => void;
  setMarkdownPreviewTheme: (theme: string) => void;
  setMarkdownPreviewLightTheme: (theme: string) => void;
  setMarkdownPreviewDarkTheme: (theme: string) => void;
  setSolarModeLevel: (level: SolarModeLevel) => void;
  setCatDisplayMode: (mode: CatDisplayMode) => void;
  setCatStaticDisplay: (display: CatStaticDisplay) => void;
  setCatCustomText: (text: string) => void;
  setCatSelectedCcfddlDeadline: (
    deadline: CatCcfddlDeadlineSelection | null,
  ) => void;
  setCatDisplayTimezone: (timezone: CatDisplayTimezone) => void;
  setCatCountdownPrecision: (precision: CatCountdownPrecision) => void;
  setKeyboardShortcut: (
    actionId: KeyboardShortcutActionId,
    binding: string | null,
  ) => void;
  resetKeyboardShortcut: (actionId: KeyboardShortcutActionId) => void;
  resetKeyboardShortcuts: () => void;
}

function normalizeEditorFontSize(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 14;
  return Math.min(22, Math.max(8, Math.round(value)));
}

function normalizeSolarModeLevel(value: unknown, legacySolarMode?: unknown) {
  if (value === 1 || value === 2 || value === 3 || value === 4) return value;
  return legacySolarMode === true ? 2 : 0;
}

function normalizeDefaultAgent(value: unknown): DefaultAgent {
  return value === "claude" || value === "pi" ? value : "codex";
}

function normalizeConcreteCompilerEngine(
  value: unknown,
  fallback: ConcreteCompilerEngine = "xelatex",
): ConcreteCompilerEngine {
  if (value === "pdflatex" || value === "lualatex") return value;
  if (value === "xelatex") return value;
  return fallback;
}

function normalizeCompilerEngine(value: unknown): CompilerEngine {
  if (value == null) return "auto";
  if (value === "auto") return value;
  if (value === "pdflatex" || value === "lualatex") return value;
  return "xelatex";
}

function getProjectFileKey(projectRoot: string, rootFileId: string): string {
  return JSON.stringify([projectRoot, rootFileId]);
}

function normalizeRootCompilerChoice(
  value: unknown,
): RootCompilerChoice | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<RootCompilerChoice>;
  const backend: CompilerBackend =
    candidate.backend === "tectonic" ? "tectonic" : "latexmk";
  const engine = normalizeConcreteCompilerEngine(candidate.engine);
  return {
    backend,
    engine,
  };
}

function normalizeCompilerChoicesByRoot(
  value: unknown,
): Record<string, RootCompilerChoice> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, RootCompilerChoice> = {};
  for (const [key, choice] of Object.entries(value)) {
    const normalized = normalizeRootCompilerChoice(choice);
    if (normalized) result[key] = normalized;
  }
  return result;
}

function normalizeRecentMarkdownThemes(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value.filter(
        (path): path is string => typeof path === "string" && path.length > 0,
      ),
    ),
  ].slice(0, 5);
}

function normalizeRecentMarkdownThemeOrder(
  order: unknown,
  recent: unknown,
): string[] {
  const paths = normalizeRecentMarkdownThemes(recent);
  const kept = normalizeRecentMarkdownThemes(order).filter((path) =>
    paths.includes(path),
  );
  return [...kept, ...paths.filter((path) => !kept.includes(path))];
}

function normalizeMarkdownMathEngines(
  value: unknown,
): Record<string, MarkdownMathEngine> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      ([, engine]) => engine === "katex" || engine === "mathjax",
    ),
  );
}

function normalizeBooleanMap(value: unknown): Record<string, boolean> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(([, enabled]) => typeof enabled === "boolean"),
  );
}

function normalizeScrollSyncByProject(
  value: unknown,
): Record<string, Record<string, boolean>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).map(([root, files]) => [
      root,
      normalizeBooleanMap(files),
    ]),
  );
}

function buildInitialCompilerChoice(
  backend: CompilerBackend,
  engine: CompilerEngine,
  detectedEngine?: ConcreteCompilerEngine | null,
): RootCompilerChoice {
  if (backend === "tectonic") {
    return {
      backend: "tectonic",
      engine: detectedEngine ?? "xelatex",
    };
  }

  return {
    backend: "latexmk",
    engine: engine === "auto" ? (detectedEngine ?? "pdflatex") : engine,
  };
}

function normalizeClaudeModel(value: unknown): ClaudeModelId {
  return normalizeClaudeModelId(value) ?? INITIAL_CLAUDE_MODEL;
}

function normalizeClaudeEffortLevel(value: unknown): ClaudeEffortLevel {
  if (
    value === "low" ||
    value === "high" ||
    value === "xhigh" ||
    value === "max"
  )
    return value;
  return "medium";
}

function normalizeCodexModel(value: unknown): CodexModelId {
  return typeof value === "string" && value.trim()
    ? value.trim()
    : INITIAL_CODEX_MODEL;
}

function normalizeCodexReasoningEffort(value: unknown): CodexReasoningEffort {
  return typeof value === "string" && value.trim() ? value.trim() : "medium";
}

function normalizeAgentExecutionMode(
  value: unknown,
  fallback: AgentExecutionMode = "default",
): AgentExecutionMode {
  if (value === "edit") return value;
  if (value === "plan") return "default";
  return fallback;
}

function normalizeGlobalAgentPrompt(value: unknown): string {
  return typeof value === "string" ? value : DEFAULT_AGENT_MD;
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function normalizeOptionalPath(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeMarkdownTheme(value: unknown, fallback: string): string {
  const normalized = normalizeOptionalPath(value);
  if (!normalized || normalized === LEGACY_GITHUB_MARKDOWN_THEME_ID) {
    return fallback;
  }
  return normalized;
}

export function normalizeCatCustomText(value: unknown): string {
  if (typeof value !== "string") return "";
  return Array.from(value.trim()).slice(0, 28).join("");
}

function normalizeCatDisplayMode(value: unknown): CatDisplayMode {
  return value === "static" ? "static" : "ccfddl";
}

function normalizeCatStaticDisplay(value: unknown): CatStaticDisplay {
  if (value === "hakimi" || value === "custom") return value;
  return "bibilabu";
}

function normalizeCatDisplayTimezone(value: unknown): CatDisplayTimezone {
  if (value === "source" || value === "utc") return value;
  return "local";
}

function normalizeCatCountdownPrecision(value: unknown): CatCountdownPrecision {
  if (value === "dh" || value === "dhms") return value;
  return "dhm";
}

function normalizeCatSelectedCcfddlDeadline(
  value: unknown,
): CatCcfddlDeadlineSelection | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<CatCcfddlDeadlineSelection>;
  if (
    typeof candidate.id !== "string" ||
    typeof candidate.title !== "string" ||
    typeof candidate.displayTitle !== "string" ||
    typeof candidate.deadline !== "string" ||
    typeof candidate.deadlineIso !== "string" ||
    typeof candidate.sourceTimezone !== "string"
  ) {
    return null;
  }

  return {
    id: candidate.id,
    title: candidate.title,
    displayTitle: candidate.displayTitle,
    deadline: candidate.deadline,
    deadlineIso: candidate.deadlineIso,
    sourceTimezone: candidate.sourceTimezone,
  };
}

function normalizePiPaths(value: unknown, selected: unknown): string[] | null {
  const paths = Array.isArray(value)
    ? value
        .filter(
          (path): path is string => typeof path === "string" && !!path.trim(),
        )
        .map((path) => path.trim())
    : [];
  if (typeof selected === "string" && selected.trim())
    paths.push(selected.trim());
  return paths.length || Array.isArray(value) ? [...new Set(paths)] : null;
}

export function migrateSettingsState(persistedState: unknown, version = 0) {
  const persisted = persistedState as
    | {
        customModels?: unknown;
        compilerBackend?: "tectonic" | "texlive" | "latexmk";
        compilerEngine?: CompilerEngine;
        autoCompile?: unknown;
        defaultAutoCompile?: unknown;
        autoCompileByProject?: unknown;
        scrollSyncByProject?: unknown;
        modeThemes?: unknown;
        workspaceModesByProject?: unknown;
        workspacePreferencesByProject?: unknown;
        compilerChoicesByRoot?: unknown;
        defaultAgent?: DefaultAgent;
        defaultClaudeModel?: ClaudeModelId;
        defaultClaudeEffortLevel?: ClaudeEffortLevel;
        piBinaryPaths?: unknown;
        piConfigDirectories?: unknown;
        piBinaryPath?: string;
        piConfigDirectory?: string;
        defaultPiModel?: string;
        defaultPiReasoningEffort?: string;
        defaultCodexModel?: CodexModelId;
        defaultCodexReasoningEffort?: CodexReasoningEffort;
        defaultAgentExecutionMode?: AgentExecutionMode | "plan";
        defaultDuetExecutionMode?: AgentExecutionMode | "plan";
        defaultVibeExecutionMode?: AgentExecutionMode | "plan";
        globalAgentPrompt?: string;
        promptLibrary?: unknown;
        keepMiniPromptsOpen?: unknown;
        useGlobalAgentPrompt?: boolean;
        useProjectAgentPrompt?: unknown;
        useClaudeAgentPrompt?: unknown;
        editorColorScheme?: EditorColorScheme;
        editorColorTheme?: string;
        editorFontSize?: number;
        spellCheck?: unknown;
        spellingLanguage?: unknown;
        spellingWords?: unknown;
        showEditorMinimap?: boolean;
        editorMinimapLayers?: Partial<MinimapLayers>;
        displayComments?: boolean;
        showPdfComments?: boolean;
        pdfCommentFullWidth?: boolean;
        editorProblemsPanelOpenByProject?: Record<string, boolean>;
        editorCommentsPanelOpenByProject?: Record<string, boolean>;
        editorCommentFilterByProject?: Record<string, EditorCommentFilter>;
        markdownLoadTyporaThemes?: boolean;
        defaultMarkdownMathEngine?: unknown;
        markdownMathEnginesByFile?: unknown;
        recentMarkdownThemePaths?: unknown;
        recentMarkdownThemeOrder?: unknown;
        markdownThemeDirectory?: string | null;
        markdownPreviewThemePath?: string | null;
        markdownSeparateLightDarkThemes?: boolean;
        markdownPreviewTheme?: string;
        markdownPreviewLightTheme?: string;
        markdownPreviewDarkTheme?: string;
        showTooltips?: unknown;
        tooltipHoverDelay?: unknown;
        solarMode?: boolean;
        solarModeLevel?: number;
        catDisplayMode?: CatDisplayMode;
        catStaticDisplay?: CatStaticDisplay;
        catCustomText?: string;
        catSelectedCcfddlDeadline?: CatCcfddlDeadlineSelection | null;
        catDisplayTimezone?: CatDisplayTimezone;
        catCountdownPrecision?: CatCountdownPrecision;
        keyboardShortcutOverrides?: unknown;
      }
    | undefined;
  const compilerBackend =
    persisted?.compilerBackend === "tectonic" ? "tectonic" : "latexmk";
  const defaultAgent = normalizeDefaultAgent(persisted?.defaultAgent);
  const editorColorScheme =
    persisted?.editorColorScheme === "ocean" ||
    persisted?.editorColorScheme === "forest" ||
    persisted?.editorColorScheme === "sunset" ||
    persisted?.editorColorScheme === "mono"
      ? persisted.editorColorScheme
      : "default";
  const editorFontSize = normalizeEditorFontSize(persisted?.editorFontSize);
  const solarModeLevel = normalizeSolarModeLevel(
    persisted?.solarModeLevel,
    persisted?.solarMode,
  );
  const legacyMarkdownTheme = normalizeOptionalPath(
    persisted?.markdownPreviewThemePath,
  );
  const promptLibrary = normalizePromptLibrary(persisted?.promptLibrary);

  const {
    workspaceModesByProject: _legacyWorkspaceModes,
    defaultDuetExecutionMode: _legacyDuetMode,
    defaultVibeExecutionMode: _legacyVibeMode,
    autoCompile: _legacyAutoCompile,
    useGlobalAgentPrompt: _legacyGlobalPrompt,
    useProjectAgentPrompt: _legacyProjectPrompt,
    useClaudeAgentPrompt: _legacyClaudePrompt,
    ...retainedSettings
  } = persisted ?? {};

  return {
    ...retainedSettings,
    workspacePreferencesByProject: normalizeWorkspacePreferencesByProject(
      persisted?.workspacePreferencesByProject,
      persisted?.workspaceModesByProject,
    ),
    scrollSyncByProject: normalizeScrollSyncByProject(
      persisted?.scrollSyncByProject,
    ),
    modeThemes: normalizeModeThemes(persisted?.modeThemes),
    compilerBackend,
    compilerEngine: normalizeCompilerEngine(persisted?.compilerEngine),
    defaultAutoCompile: normalizeBoolean(
      persisted?.defaultAutoCompile,
      normalizeBoolean(persisted?.autoCompile, true),
    ),
    autoCompileByProject: normalizeBooleanMap(persisted?.autoCompileByProject),
    compilerChoicesByRoot: normalizeCompilerChoicesByRoot(
      persisted?.compilerChoicesByRoot,
    ),
    defaultAgent,
    customModels: normalizeCustomModels(persisted?.customModels),
    defaultClaudeModel: normalizeClaudeModel(persisted?.defaultClaudeModel),
    defaultClaudeEffortLevel: normalizeClaudeEffortLevel(
      persisted?.defaultClaudeEffortLevel,
    ),
    piBinaryPaths: normalizePiPaths(
      persisted?.piBinaryPaths,
      persisted?.piBinaryPath,
    ),
    piConfigDirectories: normalizePiPaths(
      persisted?.piConfigDirectories,
      persisted?.piConfigDirectory,
    ),
    piBinaryPath:
      typeof persisted?.piBinaryPath === "string"
        ? persisted.piBinaryPath.trim()
        : "",
    piConfigDirectory:
      typeof persisted?.piConfigDirectory === "string"
        ? persisted.piConfigDirectory.trim()
        : "",
    defaultPiModel:
      typeof persisted?.defaultPiModel === "string" &&
      persisted.defaultPiModel.trim() !== "default"
        ? persisted.defaultPiModel.trim()
        : "",
    defaultPiReasoningEffort:
      typeof persisted?.defaultPiReasoningEffort === "string"
        ? persisted.defaultPiReasoningEffort
        : "medium",
    defaultCodexModel: normalizeCodexModel(persisted?.defaultCodexModel),
    defaultCodexReasoningEffort: normalizeCodexReasoningEffort(
      persisted?.defaultCodexReasoningEffort,
    ),
    defaultAgentExecutionMode: normalizeAgentExecutionMode(
      persisted?.defaultAgentExecutionMode ??
        persisted?.defaultDuetExecutionMode,
    ),
    globalAgentPrompt: normalizeGlobalAgentPrompt(persisted?.globalAgentPrompt),
    promptLibrary:
      version < 27 ? migrateStockPromptIcons(promptLibrary) : promptLibrary,
    keepMiniPromptsOpen: normalizeBoolean(
      persisted?.keepMiniPromptsOpen,
      false,
    ),
    editorColorScheme,
    editorFontSize,
    spellCheck: normalizeBoolean(persisted?.spellCheck, true),
    spellingLanguage: normalizeSpellingLanguage(persisted?.spellingLanguage),
    spellingWords: normalizeSpellingWords(persisted?.spellingWords),
    showEditorMinimap: normalizeBoolean(persisted?.showEditorMinimap, true),
    editorMinimapLayers: normalizeMinimapLayers(persisted?.editorMinimapLayers),
    displayComments: normalizeBoolean(persisted?.displayComments, true),
    showPdfComments: normalizeBoolean(persisted?.showPdfComments, true),
    pdfCommentFullWidth: normalizeBoolean(
      persisted?.pdfCommentFullWidth,
      false,
    ),
    editorProblemsPanelOpenByProject: Object.fromEntries(
      Object.entries(persisted?.editorProblemsPanelOpenByProject ?? {}).filter(
        ([, value]) => typeof value === "boolean",
      ),
    ),
    editorCommentsPanelOpenByProject: Object.fromEntries(
      Object.entries(persisted?.editorCommentsPanelOpenByProject ?? {}).filter(
        ([, value]) => typeof value === "boolean",
      ),
    ),
    editorCommentFilterByProject: Object.fromEntries(
      Object.entries(persisted?.editorCommentFilterByProject ?? {}).filter(
        ([, value]) => ["all", "human", "agent"].includes(value),
      ),
    ),
    markdownLoadTyporaThemes: normalizeBoolean(
      persisted?.markdownLoadTyporaThemes,
      true,
    ),
    recentMarkdownThemePaths: normalizeRecentMarkdownThemes(
      persisted?.recentMarkdownThemePaths,
    ),
    recentMarkdownThemeOrder: normalizeRecentMarkdownThemeOrder(
      persisted?.recentMarkdownThemeOrder,
      persisted?.recentMarkdownThemePaths,
    ),
    defaultMarkdownMathEngine:
      persisted?.defaultMarkdownMathEngine === "mathjax" ? "mathjax" : "katex",
    markdownMathEnginesByFile: normalizeMarkdownMathEngines(
      persisted?.markdownMathEnginesByFile,
    ),
    markdownThemeDirectory: normalizeOptionalPath(
      persisted?.markdownThemeDirectory,
    ),
    markdownSeparateLightDarkThemes: normalizeBoolean(
      persisted?.markdownSeparateLightDarkThemes,
      true,
    ),
    markdownPreviewTheme: normalizeMarkdownTheme(
      persisted?.markdownPreviewTheme ?? legacyMarkdownTheme,
      GITHUB_LIGHT_MARKDOWN_THEME_ID,
    ),
    markdownPreviewLightTheme: normalizeMarkdownTheme(
      persisted?.markdownPreviewLightTheme ?? legacyMarkdownTheme,
      GITHUB_LIGHT_MARKDOWN_THEME_ID,
    ),
    markdownPreviewDarkTheme: normalizeMarkdownTheme(
      persisted?.markdownPreviewDarkTheme ?? legacyMarkdownTheme,
      GITHUB_DARK_MARKDOWN_THEME_ID,
    ),
    showTooltips: normalizeBoolean(persisted?.showTooltips, true),
    tooltipHoverDelay: normalizeBoolean(persisted?.tooltipHoverDelay, true),
    solarModeLevel,
    catDisplayMode: normalizeCatDisplayMode(persisted?.catDisplayMode),
    catStaticDisplay: normalizeCatStaticDisplay(persisted?.catStaticDisplay),
    catCustomText: normalizeCatCustomText(persisted?.catCustomText),
    catSelectedCcfddlDeadline: normalizeCatSelectedCcfddlDeadline(
      persisted?.catSelectedCcfddlDeadline,
    ),
    catDisplayTimezone: normalizeCatDisplayTimezone(
      persisted?.catDisplayTimezone,
    ),
    catCountdownPrecision: normalizeCatCountdownPrecision(
      persisted?.catCountdownPrecision,
    ),
    keyboardShortcutOverrides: normalizeKeyboardShortcutOverrides(
      persisted?.keyboardShortcutOverrides,
    ),
  };
}

const create = createPanelStore("settings");
export const useSettingsStore = create<SettingsState>()(
  persist(
    (set, get) => ({
      skippedUpdateVersions: [],
      skipUpdateVersion: (version) =>
        set((state) =>
          state.skippedUpdateVersions.includes(version)
            ? state
            : {
                skippedUpdateVersions: [
                  ...state.skippedUpdateVersions,
                  version,
                ],
              },
        ),
      showAnswerCompletionTime: false,
      toggleAnswerTimeDisplay: () =>
        set((state) => ({
          showAnswerCompletionTime: !state.showAnswerCompletionTime,
        })),
      workspacePreferencesByProject: {},
      getWorkspacePreferences: (projectRoot) =>
        (projectRoot && get().workspacePreferencesByProject[projectRoot]) ||
        DEFAULT_WORKSPACE_PREFERENCES,
      setWorkspacePreferences: (projectRoot, preferences) =>
        set((state) => ({
          workspacePreferencesByProject: {
            ...state.workspacePreferencesByProject,
            [projectRoot]: { ...preferences },
          },
        })),
      scrollSyncByProject: {},
      setFileScrollSync: (projectRoot, fileId, enabled) =>
        set((state) => ({
          scrollSyncByProject: {
            ...state.scrollSyncByProject,
            [projectRoot]: {
              ...state.scrollSyncByProject[projectRoot],
              [fileId]: enabled,
            },
          },
        })),
      modeThemes: { ...DEFAULT_MODE_THEMES },
      setModeTheme: (mode, theme) =>
        set((state) => ({
          modeThemes: normalizeModeThemes({
            ...state.modeThemes,
            [mode]: theme,
          }),
        })),
      defaultAutoCompile: true,
      setDefaultAutoCompile: (enabled) => set({ defaultAutoCompile: enabled }),
      autoCompileByProject: {},
      getProjectAutoCompile: (projectRoot) =>
        (projectRoot ? get().autoCompileByProject[projectRoot] : undefined) ??
        get().defaultAutoCompile,
      initializeProjectAutoCompile: (projectRoot) => {
        const existing = get().autoCompileByProject[projectRoot];
        if (existing !== undefined) return existing;
        const enabled = get().defaultAutoCompile;
        set((state) => ({
          autoCompileByProject: {
            ...state.autoCompileByProject,
            [projectRoot]: enabled,
          },
        }));
        return enabled;
      },
      setProjectAutoCompile: (projectRoot, enabled) =>
        set((state) => ({
          autoCompileByProject: {
            ...state.autoCompileByProject,
            [projectRoot]: enabled,
          },
        })),
      compilerBackend: "latexmk",
      compilerEngine: "auto",
      latexInstallation: null,
      compilerChoicesByRoot: {},
      customModels: [],
      addCustomModel: (model) =>
        set((state) => ({
          customModels: normalizeCustomModels([...state.customModels, model]),
        })),
      removeCustomModel: (provider, id) =>
        set((state) => ({
          customModels: state.customModels.filter(
            (model) => model.provider !== provider || model.id !== id,
          ),
        })),
      enabledProviders: { claude: true, codex: true, pi: false },
      setProviderEnabled: (provider, enabled) =>
        set((state) => ({
          enabledProviders: { ...state.enabledProviders, [provider]: enabled },
        })),
      defaultAgent: "codex",
      defaultClaudeModel: INITIAL_CLAUDE_MODEL,
      defaultClaudeEffortLevel: "medium",
      piBinaryPaths: null,
      piConfigDirectories: null,
      piBinaryPath: "",
      piConfigDirectory: "",
      defaultPiModel: "",
      defaultPiReasoningEffort: "medium",
      defaultCodexModel: INITIAL_CODEX_MODEL,
      defaultCodexReasoningEffort: "medium",
      defaultAgentExecutionMode: "default",
      globalAgentPrompt: DEFAULT_AGENT_MD,
      promptLibrary: normalizePromptLibrary(undefined),
      keepMiniPromptsOpen: false,
      setKeepMiniPromptsOpen: (pinned) => set({ keepMiniPromptsOpen: pinned }),
      editorColorScheme: "default",
      editorFontSize: 14,
      spellCheck: true,
      spellingLanguage: "en-US",
      spellingWords: [],
      setSpellCheck: (enabled) => set({ spellCheck: enabled }),
      setSpellingLanguage: (language) =>
        set({ spellingLanguage: normalizeSpellingLanguage(language) }),
      learnSpellingWord: (word) =>
        set((state) => ({
          spellingWords: normalizeSpellingWords([...state.spellingWords, word]),
        })),
      removeSpellingWord: (word) =>
        set((state) => ({
          spellingWords: state.spellingWords.filter((entry) => entry !== word),
        })),
      showEditorMinimap: true,
      setShowEditorMinimap: (visible) => set({ showEditorMinimap: visible }),
      editorMinimapLayers: DEFAULT_MINIMAP_LAYERS,
      setEditorMinimapLayer: (layer, visible) =>
        set((state) => ({
          editorMinimapLayers: {
            ...state.editorMinimapLayers,
            [layer]: visible,
          },
        })),
      displayComments: true,
      showPdfComments: true,
      pdfCommentFullWidth: false,
      setPdfCommentFullWidth: (pdfCommentFullWidth) =>
        set({ pdfCommentFullWidth }),
      setDisplayComments: (displayComments) => set({ displayComments }),
      setShowPdfComments: (showPdfComments) => set({ showPdfComments }),
      editorProblemsPanelOpenByProject: {},
      editorCommentsPanelOpenByProject: {},
      editorCommentFilterByProject: {},
      markdownLoadTyporaThemes: true,
      defaultMarkdownMathEngine: "katex",
      markdownMathEnginesByFile: {},
      recentMarkdownThemePaths: [],
      recentMarkdownThemeOrder: [],
      recordRecentMarkdownTheme: (path) => {
        if (!path || get().recentMarkdownThemePaths[0] === path) return;
        set((state) => {
          const recentMarkdownThemePaths = normalizeRecentMarkdownThemes([
            path,
            ...state.recentMarkdownThemePaths,
          ]);
          return {
            recentMarkdownThemePaths,
            recentMarkdownThemeOrder: normalizeRecentMarkdownThemeOrder(
              state.recentMarkdownThemeOrder,
              recentMarkdownThemePaths,
            ),
          };
        });
      },
      markdownThemeDirectory: null,
      markdownSeparateLightDarkThemes: true,
      markdownPreviewTheme: GITHUB_LIGHT_MARKDOWN_THEME_ID,
      markdownPreviewLightTheme: GITHUB_LIGHT_MARKDOWN_THEME_ID,
      markdownPreviewDarkTheme: GITHUB_DARK_MARKDOWN_THEME_ID,
      showTooltips: true,
      tooltipHoverDelay: true,
      setShowTooltips: (showTooltips) => set({ showTooltips }),
      setTooltipHoverDelay: (tooltipHoverDelay) => set({ tooltipHoverDelay }),
      solarModeLevel: 0,
      catDisplayMode: "ccfddl",
      catStaticDisplay: "bibilabu",
      catCustomText: "",
      catSelectedCcfddlDeadline: null,
      catDisplayTimezone: "local",
      catCountdownPrecision: "dhm",
      keyboardShortcutOverrides: {},
      setLatexInstallation: (path) => set({ latexInstallation: path }),
      setCompilerBackend: (backend) => set({ compilerBackend: backend }),
      setCompilerEngine: (engine) =>
        set({ compilerEngine: normalizeCompilerEngine(engine) }),
      getCompilerChoiceForRoot: (projectRoot, rootFileId) =>
        get().compilerChoicesByRoot[getProjectFileKey(projectRoot, rootFileId)],
      initializeCompilerChoiceForRoot: (
        projectRoot,
        rootFileId,
        detectedEngine,
      ) => {
        const key = getProjectFileKey(projectRoot, rootFileId);
        const existing = get().compilerChoicesByRoot[key];
        if (existing) return existing;

        const state = get();
        const choice = buildInitialCompilerChoice(
          state.compilerBackend,
          state.compilerEngine,
          detectedEngine,
        );
        set((current) => ({
          compilerChoicesByRoot: {
            ...current.compilerChoicesByRoot,
            [key]: choice,
          },
        }));
        return choice;
      },
      setCompilerChoiceForRoot: (projectRoot, rootFileId, choice) => {
        const key = getProjectFileKey(projectRoot, rootFileId);
        const normalized = normalizeRootCompilerChoice(choice);
        if (!normalized) return;
        set((current) => ({
          compilerChoicesByRoot: {
            ...current.compilerChoicesByRoot,
            [key]: normalized,
          },
        }));
      },
      setDefaultAgent: (agent) =>
        set({ defaultAgent: normalizeDefaultAgent(agent) }),
      setDefaultClaudeModel: (model) =>
        set({ defaultClaudeModel: normalizeClaudeModel(model) }),
      setDefaultClaudeEffortLevel: (level) =>
        set({ defaultClaudeEffortLevel: normalizeClaudeEffortLevel(level) }),
      setPiBinaryPath: (path) =>
        set((state) => ({
          piBinaryPath: path.trim(),
          piBinaryPaths: path.trim()
            ? [...new Set([...(state.piBinaryPaths ?? []), path.trim()])]
            : null,
        })),
      setPiConfigDirectory: (path) =>
        set((state) => ({
          piConfigDirectory: path.trim(),
          piConfigDirectories: path.trim()
            ? [...new Set([...(state.piConfigDirectories ?? []), path.trim()])]
            : null,
        })),
      removePiBinaryPath: (path) =>
        set((state) => {
          const paths = (state.piBinaryPaths ?? []).filter(
            (entry) => entry !== path,
          );
          return {
            piBinaryPaths: paths,
            piBinaryPath:
              state.piBinaryPath === path
                ? (paths[0] ?? "")
                : state.piBinaryPath,
          };
        }),
      removePiConfigDirectory: (path) =>
        set((state) => {
          const paths = (state.piConfigDirectories ?? []).filter(
            (entry) => entry !== path,
          );
          return {
            piConfigDirectories: paths,
            piConfigDirectory:
              state.piConfigDirectory === path
                ? (paths[0] ?? "")
                : state.piConfigDirectory,
          };
        }),
      setDefaultPiModel: (model) => set({ defaultPiModel: model }),
      setDefaultPiReasoningEffort: (level) =>
        set({ defaultPiReasoningEffort: level }),
      setDefaultCodexModel: (model) =>
        set({ defaultCodexModel: normalizeCodexModel(model) }),
      setDefaultCodexReasoningEffort: (level) =>
        set({
          defaultCodexReasoningEffort: normalizeCodexReasoningEffort(level),
        }),
      setDefaultAgentExecutionMode: (mode) =>
        set({ defaultAgentExecutionMode: normalizeAgentExecutionMode(mode) }),
      saveLibraryPrompt: (prompt) =>
        set((state) => ({
          promptLibrary: normalizePromptLibrary(
            state.promptLibrary.some((item) => item.id === prompt.id)
              ? state.promptLibrary.map((item) =>
                  item.id === prompt.id ? prompt : item,
                )
              : [...state.promptLibrary, prompt],
          ),
        })),
      deleteLibraryPrompt: (id) =>
        set((state) => ({
          promptLibrary: state.promptLibrary.filter((item) => item.id !== id),
        })),
      moveLibraryPrompt: (id, direction, visibleIds) =>
        set((state) => {
          const prompts = [...state.promptLibrary];
          // Include restored stock rows and move past hidden custom entries
          // without deleting or rewriting their saved content.
          for (const visibleId of visibleIds ?? []) {
            if (prompts.some((item) => item.id === visibleId)) continue;
            const stock = DEFAULT_PROMPT_LIBRARY.find(
              (item) => item.id === visibleId,
            );
            if (stock) prompts.push({ ...stock });
          }
          const indexes = prompts.flatMap((item, index) =>
            !visibleIds || visibleIds.includes(item.id) ? [index] : [],
          );
          const index = indexes.findIndex(
            (position) => prompts[position].id === id,
          );
          const next = index + direction;
          if (index < 0 || next < 0 || next >= indexes.length) return state;
          const from = indexes[index];
          const to = indexes[next];
          [prompts[from], prompts[to]] = [prompts[to], prompts[from]];
          return { promptLibrary: prompts };
        }),
      setGlobalAgentPrompt: (prompt) =>
        set({ globalAgentPrompt: normalizeGlobalAgentPrompt(prompt) }),
      resetGlobalAgentPrompt: () =>
        set({ globalAgentPrompt: DEFAULT_AGENT_MD }),
      setEditorColorScheme: (scheme) => set({ editorColorScheme: scheme }),
      setEditorFontSize: (fontSize) =>
        set({ editorFontSize: normalizeEditorFontSize(fontSize) }),
      setEditorProblemsPanelOpen: (projectKey, open) =>
        set((state) => ({
          editorProblemsPanelOpenByProject: {
            ...state.editorProblemsPanelOpenByProject,
            [projectKey]: open,
          },
        })),
      setEditorCommentsPanelOpen: (projectKey, open) =>
        set((state) => ({
          editorCommentsPanelOpenByProject: {
            ...state.editorCommentsPanelOpenByProject,
            [projectKey]: open,
          },
        })),
      setEditorInfoBar: (projectKey, bar) =>
        set((state) => ({
          editorProblemsPanelOpenByProject: {
            ...state.editorProblemsPanelOpenByProject,
            [projectKey]: bar === "problems",
          },
          editorCommentsPanelOpenByProject: {
            ...state.editorCommentsPanelOpenByProject,
            [projectKey]: bar === "comments",
          },
        })),
      setEditorCommentFilter: (projectKey, filter) =>
        set((state) => ({
          editorCommentFilterByProject: {
            ...state.editorCommentFilterByProject,
            [projectKey]: filter,
          },
        })),
      setMarkdownLoadTyporaThemes: (enabled) =>
        set({ markdownLoadTyporaThemes: Boolean(enabled) }),
      setDefaultMarkdownMathEngine: (engine) =>
        set({
          defaultMarkdownMathEngine: engine === "mathjax" ? "mathjax" : "katex",
        }),
      getMarkdownMathEngineForFile: (projectRoot, fileId) =>
        projectRoot && fileId
          ? (get().markdownMathEnginesByFile[
              getProjectFileKey(projectRoot, fileId)
            ] ?? get().defaultMarkdownMathEngine)
          : get().defaultMarkdownMathEngine,
      setMarkdownMathEngineForFile: (projectRoot, fileId, engine) => {
        if (!projectRoot || !fileId) return;
        set((current) => ({
          markdownMathEnginesByFile: {
            ...current.markdownMathEnginesByFile,
            [getProjectFileKey(projectRoot, fileId)]:
              engine === "mathjax" ? "mathjax" : "katex",
          },
        }));
      },
      setMarkdownThemeDirectory: (directory) =>
        set({ markdownThemeDirectory: normalizeOptionalPath(directory) }),
      setMarkdownSeparateLightDarkThemes: (enabled) =>
        set({ markdownSeparateLightDarkThemes: Boolean(enabled) }),
      setMarkdownPreviewTheme: (theme) =>
        set({
          markdownPreviewTheme: normalizeMarkdownTheme(
            theme,
            GITHUB_LIGHT_MARKDOWN_THEME_ID,
          ),
        }),
      setMarkdownPreviewLightTheme: (theme) =>
        set({
          markdownPreviewLightTheme: normalizeMarkdownTheme(
            theme,
            GITHUB_LIGHT_MARKDOWN_THEME_ID,
          ),
        }),
      setMarkdownPreviewDarkTheme: (theme) =>
        set({
          markdownPreviewDarkTheme: normalizeMarkdownTheme(
            theme,
            GITHUB_DARK_MARKDOWN_THEME_ID,
          ),
        }),
      setSolarModeLevel: (level) => set({ solarModeLevel: level }),
      setCatDisplayMode: (mode) =>
        set({ catDisplayMode: normalizeCatDisplayMode(mode) }),
      setCatStaticDisplay: (display) =>
        set({ catStaticDisplay: normalizeCatStaticDisplay(display) }),
      setCatCustomText: (text) =>
        set({ catCustomText: normalizeCatCustomText(text) }),
      setCatSelectedCcfddlDeadline: (deadline) =>
        set({
          catSelectedCcfddlDeadline:
            normalizeCatSelectedCcfddlDeadline(deadline),
        }),
      setCatDisplayTimezone: (timezone) =>
        set({ catDisplayTimezone: normalizeCatDisplayTimezone(timezone) }),
      setCatCountdownPrecision: (precision) =>
        set({
          catCountdownPrecision: normalizeCatCountdownPrecision(precision),
        }),
      setKeyboardShortcut: (actionId, binding) => {
        const normalized =
          binding === null ? null : normalizeKeyboardShortcut(binding);
        if (binding !== null && !normalized) return;
        set((current) => {
          const next = { ...current.keyboardShortcutOverrides };
          if (normalized === getDefaultKeyboardShortcut(actionId)) {
            delete next[actionId];
          } else {
            next[actionId] = normalized;
          }
          return { keyboardShortcutOverrides: next };
        });
      },
      resetKeyboardShortcut: (actionId) =>
        set((current) => {
          const next = { ...current.keyboardShortcutOverrides };
          delete next[actionId];
          return { keyboardShortcutOverrides: next };
        }),
      resetKeyboardShortcuts: () => set({ keyboardShortcutOverrides: {} }),
    }),
    {
      name: "catalex-settings",
      version: 27,
      migrate: migrateSettingsState,
      merge: (persisted, current) => {
        const saved = persisted as
          | (Partial<SettingsState> & { skippedUpdateVersion?: unknown })
          | undefined;
        const skippedVersions = Array.isArray(saved?.skippedUpdateVersions)
          ? saved.skippedUpdateVersions
          : [saved?.skippedUpdateVersion];
        return {
          ...current,
          ...saved,
          recentMarkdownThemePaths: normalizeRecentMarkdownThemes(
            saved?.recentMarkdownThemePaths,
          ),
          recentMarkdownThemeOrder: normalizeRecentMarkdownThemeOrder(
            saved?.recentMarkdownThemeOrder,
            saved?.recentMarkdownThemePaths,
          ),
          defaultMarkdownMathEngine:
            saved?.defaultMarkdownMathEngine === "mathjax"
              ? "mathjax"
              : "katex",
          markdownMathEnginesByFile: normalizeMarkdownMathEngines(
            saved?.markdownMathEnginesByFile,
          ),
          promptLibrary: normalizePromptLibrary(saved?.promptLibrary),
          keepMiniPromptsOpen: normalizeBoolean(
            saved?.keepMiniPromptsOpen,
            false,
          ),
          skippedUpdateVersions: [
            ...new Set(
              skippedVersions.filter(
                (version): version is string =>
                  typeof version === "string" && version.length > 0,
              ),
            ),
          ],
          piBinaryPaths: normalizePiPaths(
            saved?.piBinaryPaths,
            saved?.piBinaryPath,
          ),
          piConfigDirectories: normalizePiPaths(
            saved?.piConfigDirectories,
            saved?.piConfigDirectory,
          ),
          showAnswerCompletionTime: normalizeBoolean(
            saved?.showAnswerCompletionTime,
            false,
          ),
          defaultAutoCompile: normalizeBoolean(saved?.defaultAutoCompile, true),
          autoCompileByProject: normalizeBooleanMap(
            saved?.autoCompileByProject,
          ),
          compilerChoicesByRoot: normalizeCompilerChoicesByRoot(
            saved?.compilerChoicesByRoot,
          ),
          spellCheck: normalizeBoolean(saved?.spellCheck, true),
          spellingLanguage: normalizeSpellingLanguage(saved?.spellingLanguage),
          spellingWords: normalizeSpellingWords(saved?.spellingWords),
          showEditorMinimap: normalizeBoolean(saved?.showEditorMinimap, true),
          editorMinimapLayers: normalizeMinimapLayers(
            saved?.editorMinimapLayers,
          ),
          enabledProviders: {
            claude: normalizeBoolean(saved?.enabledProviders?.claude, true),
            codex: normalizeBoolean(saved?.enabledProviders?.codex, true),
            pi: normalizeBoolean(saved?.enabledProviders?.pi, false),
          },
          workspacePreferencesByProject: normalizeWorkspacePreferencesByProject(
            saved?.workspacePreferencesByProject,
          ),
          scrollSyncByProject: normalizeScrollSyncByProject(
            saved?.scrollSyncByProject,
          ),
          modeThemes: normalizeModeThemes(saved?.modeThemes),
          defaultAgentExecutionMode: normalizeAgentExecutionMode(
            saved?.defaultAgentExecutionMode,
          ),
          showTooltips: normalizeBoolean(saved?.showTooltips, true),
          tooltipHoverDelay: normalizeBoolean(saved?.tooltipHoverDelay, true),
        };
      },
    },
  ),
);

synchronizePersistedStore(useSettingsStore);
