import { PromptLibrarySettings } from "./prompt-library-settings";
import { Kbd } from "@/components/ui/kbd";
import { useUpdater } from "@/hooks/use-updater";
import { usePiSetupStore } from "@/stores/pi-setup-store";
import { usePiPathSettings } from "@/hooks/use-pi-path-settings";
import {
  findPiModel,
  piModelThinkingLevels,
  resolvePiThinkingLevel,
  piModelLabel,
  piModelValue,
} from "@/lib/pi-models";
import {
  SPELLING_LANGUAGES,
  normalizeSpellingLanguage,
} from "@/lib/spelling/types";
import { ProviderToggle } from "@/components/provider-toggle";
import { SettingsSwitch } from "./settings-switch";
export { SettingsSwitch } from "./settings-switch";
import { useOnboardingStore } from "@/stores/onboarding-store";
import { ConferenceDeadlinePicker } from "./conference-deadline-picker";
import {
  SettingsDropdown,
  SolarizeDropdown,
  EDITOR_COLOR_SCHEME_OPTIONS,
  SOLAR_MODE_LABELS,
  SOLAR_MODE_OPTIONS,
} from "./settings-dropdown";
export {
  SettingsDropdown,
  SolarizeDropdown,
  EDITOR_COLOR_SCHEME_OPTIONS,
} from "./settings-dropdown";
import { LatexInstallationControl } from "@/components/latex-installation";
import { StorageSettings } from "./storage-settings";
import { SettingsGroup, SettingsRow } from "./settings-layout";
import { useAppZoomShortcuts } from "@/hooks/use-keyboard-shortcuts";
import {
  DEFAULT_APP_ZOOM,
  MIN_APP_ZOOM,
  MAX_APP_ZOOM,
  readStoredAppZoom,
  persistAppZoom,
  subscribeAppZoom,
  zoomInApp,
  zoomOutApp,
  resetAppZoom,
} from "@/lib/app-zoom";
import { ButtonGroup } from "@/components/ui/button-group";
import { listen } from "@/lib/desktop/event";
import { CustomModelSettings } from "./custom-model-settings";
import { useClaudeModels, useCodexModels } from "@/lib/use-agent-models";
import { formatCodexModelName, codexEffortLabel } from "@/lib/codex-models";
import {
  BotIcon,
  CatIcon,
  CheckIcon,
  ChevronDownIcon,
  CircleHelpIcon,
  CodeXmlIcon,
  FileCodeIcon,
  ExternalLinkIcon,
  FolderOpenIcon,
  CircleArrowUpIcon,
  HardDriveIcon,
  KeyboardIcon,
  type LucideIcon,
  MinusIcon,
  PlusIcon,
  MonitorIcon,
  MoonIcon,
  PencilLineIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  SearchIcon,
  SettingsIcon,
  ShieldCheckIcon,
  SunIcon,
} from "lucide-react";
import { open } from "@/lib/desktop/dialog";
import { useTheme } from "next-themes";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { broadcastSettingsChanged } from "@/components/settings/solar-mode-effect";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Hint, TooltipProvider } from "@/components/ui/tooltip";
import { resolveAppVersion } from "@/lib/app-version";
import { DEFAULT_AGENT_MD } from "@/lib/default-agent-md";
import { resolveCcfddlCatLabel } from "@/lib/ccfddl";
import { cn } from "@/lib/utils";
import { UI_THEMES, WORKSPACE_MODES } from "@/lib/ui-theme";
import {
  GITHUB_DARK_MARKDOWN_THEME_ID,
  GITHUB_LIGHT_MARKDOWN_THEME_ID,
  type InstalledMarkdownTheme,
  isBuiltInMarkdownTheme,
  listMarkdownThemes,
  markdownThemeFileName,
  markdownThemeLabel,
  resolveMarkdownThemeDirectory,
} from "@/lib/markdown-theme";
import {
  formatKeyboardShortcut,
  formatKeyboardShortcutParts,
  keyboardShortcutFromEvent,
  KEYBOARD_SHORTCUT_ACTIONS,
  KEYBOARD_SHORTCUT_GROUPS,
  type KeyboardShortcutActionId,
  resolveKeyboardShortcut,
  validateKeyboardShortcut,
} from "@/lib/keyboard-shortcuts";
import {
  type CatCcfddlDeadlineSelection,
  type CatCountdownPrecision,
  type CatDisplayMode,
  type CatDisplayTimezone,
  type CatStaticDisplay,
  type CompilerBackend,
  type CompilerEngine,
  type AgentExecutionMode,
  type CodexModelId,
  type CodexReasoningEffort,
  type DefaultAgent,
  type EditorColorScheme,
  type SolarModeLevel,
  useSettingsStore,
} from "@/stores/settings-store";
import {
  claudeModelLabel,
  claudeModelEfforts,
  findClaudeModel,
} from "@/lib/claude-models";
import { useClaudeSetupStore } from "@/stores/claude-setup-store";
import { useCodexSetupStore } from "@/stores/codex-setup-store";

type SettingsSection =
  | "appearance"
  | "cat"
  | "agent"
  | "keyboard"
  | "rendering"
  | "storage"
  | "about";
type ThemeOption = "system" | "light" | "dark";

const EDITOR_FONT_SIZE_MIN = 8;
const EDITOR_FONT_SIZE_MAX = 22;
const EDITOR_FONT_SIZE_OPTIONS = Array.from(
  { length: EDITOR_FONT_SIZE_MAX - EDITOR_FONT_SIZE_MIN + 1 },
  (_, index) => {
    const value = EDITOR_FONT_SIZE_MIN + index;
    return { value, label: `${value}px` };
  },
);

const SECTIONS: Array<{
  id: SettingsSection;
  label: string;
  icon: LucideIcon;
}> = [
  { id: "appearance", label: "Appearance", icon: SunIcon },
  { id: "cat", label: "Cat", icon: CatIcon },
  { id: "agent", label: "Agent", icon: BotIcon },
  { id: "keyboard", label: "Keyboard", icon: KeyboardIcon },
  { id: "rendering", label: "Rendering", icon: CodeXmlIcon },
  { id: "storage", label: "Storage", icon: HardDriveIcon },
  { id: "about", label: "About", icon: SettingsIcon },
];

export const THEME_OPTIONS: Array<{
  value: ThemeOption;
  label: string;
  icon: LucideIcon;
}> = [
  { value: "system", label: "System", icon: MonitorIcon },
  { value: "light", label: "Light", icon: SunIcon },
  { value: "dark", label: "Dark", icon: MoonIcon },
];

const UI_THEME_OPTIONS = UI_THEMES.map(({ id, label }) => ({
  value: id,
  label,
}));

const BUILT_IN_MARKDOWN_THEME_OPTIONS: Array<{
  value: string;
  label: string;
  icon: LucideIcon;
}> = [
  {
    value: GITHUB_LIGHT_MARKDOWN_THEME_ID,
    label: "GitHub Light",
    icon: SunIcon,
  },
  {
    value: GITHUB_DARK_MARKDOWN_THEME_ID,
    label: "GitHub Dark",
    icon: MoonIcon,
  },
];

export const COMPILER_OPTIONS: Array<{
  value: CompilerBackend;
  label: string;
}> = [
  { value: "latexmk", label: "LaTeXmk" },
  { value: "tectonic", label: "Tectonic" },
];

export const COMPILER_ENGINE_OPTIONS: Array<{
  value: CompilerEngine;
  label: string;
}> = [
  { value: "auto", label: "Auto" },
  { value: "pdflatex", label: "pdfLaTeX" },
  { value: "xelatex", label: "XeLaTeX" },
  { value: "lualatex", label: "LuaLaTeX" },
];

export const AGENT_OPTIONS: Array<{
  value: DefaultAgent;
  label: string;
}> = [
  { value: "codex", label: "Codex" },
  { value: "claude", label: "Claude Code" },
  { value: "pi", label: "Pi" },
];

const FALLBACK_CODEX_MODEL_OPTIONS: Array<{
  value: CodexModelId;
  label: string;
}> = [
  { value: "default", label: "Provider default" },
  { value: "gpt-5.5", label: formatCodexModelName("gpt-5.5") },
  { value: "gpt-5.4", label: formatCodexModelName("gpt-5.4") },
  { value: "gpt-5.4-mini", label: formatCodexModelName("gpt-5.4-mini") },
  { value: "gpt-5.3-codex", label: formatCodexModelName("gpt-5.3-codex") },
  {
    value: "gpt-5.3-codex-spark",
    label: formatCodexModelName("gpt-5.3-codex-spark"),
  },
  { value: "gpt-5.2", label: formatCodexModelName("gpt-5.2") },
];

export const FALLBACK_CODEX_REASONING_OPTIONS: Array<{
  value: CodexReasoningEffort;
  label: string;
}> = [
  { value: "low", label: codexEffortLabel("low") },
  { value: "medium", label: codexEffortLabel("medium") },
  { value: "high", label: codexEffortLabel("high") },
  { value: "xhigh", label: codexEffortLabel("xhigh") },
];

const AGENT_MODE_OPTIONS: Array<{
  value: AgentExecutionMode;
  label: string;
  icon?: LucideIcon;
  labelClassName?: string;
}> = [
  {
    value: "default",
    label: "Manual approval",
    icon: ShieldCheckIcon,
  },
  {
    value: "edit",
    label: "Automatic approval",
    icon: PencilLineIcon,
    labelClassName: "text-purple-700 dark:text-purple-300",
  },
];

export const CAT_MODE_OPTIONS: Array<{
  value: CatDisplayMode;
  label: string;
}> = [
  { value: "static", label: "Static" },
  { value: "ccfddl", label: "CCFDDL" },
];

export const CAT_STATIC_OPTIONS: Array<{
  value: CatStaticDisplay;
  label: string;
}> = [
  { value: "bibilabu", label: "Bibilabu" },
  { value: "hakimi", label: "南北绿豆" },
  { value: "custom", label: "Custom" },
];

export const CAT_TIMEZONE_OPTIONS: Array<{
  value: CatDisplayTimezone;
  label: string;
}> = [
  { value: "local", label: "Local" },
  { value: "source", label: "Source" },
  { value: "utc", label: "UTC" },
];

export const CAT_COUNTDOWN_OPTIONS: Array<{
  value: CatCountdownPrecision;
  label: string;
}> = [
  { value: "dh", label: "d/h" },
  { value: "dhm", label: "d/h/m" },
  { value: "dhms", label: "d/h/m/s" },
];

type SearchableSetting = {
  id: string;
  section: SettingsSection;
  label: string;
  valueLabel?: string;
  searchText: string[];
  searchOptions?: SearchableOption[];
};

type SearchableOption = {
  label: string;
  value: string;
};

type SearchMatch = {
  id: string;
  section: SettingsSection;
  label: string;
  valueLabel?: string;
  matchedOptionLabel?: string;
};

function getOptionLabel<T extends string | number>(
  options: Array<{ value: T; label: string }>,
  value: T,
) {
  return (
    options.find((option) => option.value === value)?.label ?? String(value)
  );
}

function getOptionSearchText<T extends string | number>(
  options: Array<{
    value: T;
    label: string;
    icon?: LucideIcon;
    labelClassName?: string;
  }>,
) {
  return options.flatMap((option) => {
    if (typeof option.value === "number" && !Number.isFinite(option.value)) {
      return [option.label];
    }
    return [option.label, String(option.value)];
  });
}

function getSearchOptions<T extends string | number>(
  options: Array<{
    value: T;
    label: string;
    icon?: LucideIcon;
    labelClassName?: string;
  }>,
): SearchableOption[] {
  return options
    .filter(
      (option) =>
        typeof option.value !== "number" || Number.isFinite(option.value),
    )
    .map((option) => ({
      label: option.label,
      value: String(option.value),
    }));
}

function ShortcutRecorder({
  actionId,
  binding,
  error,
  isRecording,
  label,
  onCancel,
  onCapture,
  onStart,
}: {
  actionId: KeyboardShortcutActionId;
  binding: string | null;
  error: string | null;
  isRecording: boolean;
  label: string;
  onCancel: () => void;
  onCapture: (
    actionId: KeyboardShortcutActionId,
    binding: string | null,
  ) => void;
  onStart: (actionId: KeyboardShortcutActionId) => void;
}) {
  const shortcutParts = formatKeyboardShortcutParts(binding);
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (!isRecording) return;
    event.preventDefault();
    event.stopPropagation();

    if (event.key === "Escape") {
      onCancel();
      return;
    }
    if (
      (event.key === "Backspace" || event.key === "Delete") &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.shiftKey
    ) {
      onCapture(actionId, null);
      return;
    }

    const nextBinding = keyboardShortcutFromEvent(event.nativeEvent);
    if (nextBinding) onCapture(actionId, nextBinding);
  };

  return (
    <div className="ml-auto flex min-w-0 flex-col items-end gap-1">
      <button
        type="button"
        aria-label={
          isRecording
            ? `Recording ${label} shortcut`
            : `Change ${label} shortcut`
        }
        aria-pressed={isRecording}
        className={cn(
          "flex min-h-8 min-w-32 items-center justify-center gap-1 rounded-lg border px-2 transition-colors",
          isRecording
            ? "border-ring bg-background ring-2 ring-ring/20"
            : "border-border/70 bg-background/70 hover:bg-background",
        )}
        data-shortcut-action={actionId}
        onBlur={() => {
          if (isRecording) onCancel();
        }}
        onClick={() => (isRecording ? onCancel() : onStart(actionId))}
        onKeyDown={handleKeyDown}
      >
        {isRecording ? (
          <span className="font-sans text-muted-foreground text-xs">
            Press shortcut…
          </span>
        ) : shortcutParts.length > 0 ? (
          shortcutParts.map((part, index) => (
            <Kbd key={`${part}-${index}`}>{part}</Kbd>
          ))
        ) : (
          <span className="font-sans text-muted-foreground text-xs">
            Unassigned
          </span>
        )}
      </button>
      {isRecording && error ? (
        <span className="max-w-64 text-right font-sans text-destructive text-xs">
          {error}
        </span>
      ) : null}
    </div>
  );
}

export function EditorFontSizeDropdown({
  value,
  onValueChange,
}: {
  value: number;
  onValueChange: (value: number) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          aria-expanded={open}
          aria-haspopup="listbox"
          className="h-8 rounded-lg bg-muted/70 px-2 font-mono font-normal text-foreground text-sm hover:bg-muted dark:bg-muted/55 dark:hover:bg-muted/70"
          type="button"
          variant="ghost"
        >
          <span>{value}px</span>
          <ChevronDownIcon className="size-3 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="z-[9999] w-24 rounded-lg p-1">
        <div className="max-h-36 overflow-y-auto" role="listbox">
          {EDITOR_FONT_SIZE_OPTIONS.map((option) => (
            <button
              aria-selected={option.value === value}
              className="flex h-7 w-full items-center justify-between rounded-md px-2 font-mono text-sm hover:bg-muted"
              key={option.value}
              onClick={() => {
                onValueChange(option.value);
                setOpen(false);
              }}
              ref={
                option.value === value
                  ? (node) => {
                      node?.scrollIntoView({ block: "center" });
                    }
                  : undefined
              }
              role="option"
              type="button"
            >
              <span>{option.label}</span>
              {option.value === value ? (
                <CheckIcon className="size-3 text-muted-foreground" />
              ) : null}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function HighlightedMatch({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;

  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const parts: ReactNode[] = [];
  let cursor = 0;
  let matchIndex = lowerText.indexOf(lowerQuery);

  while (matchIndex !== -1) {
    if (matchIndex > cursor) {
      parts.push(text.slice(cursor, matchIndex));
    }
    const matchEnd = matchIndex + query.length;
    parts.push(
      <span className="font-medium text-sidebar-foreground" key={matchIndex}>
        {text.slice(matchIndex, matchEnd)}
      </span>,
    );
    cursor = matchEnd;
    matchIndex = lowerText.indexOf(lowerQuery, cursor);
  }

  if (cursor < text.length) {
    parts.push(text.slice(cursor));
  }

  return <>{parts}</>;
}

function SectionButton({
  section,
  active,
  searchQuery,
  matches,
  onClick,
  onMatchClick,
}: {
  section: (typeof SECTIONS)[number];
  active: boolean;
  searchQuery: string;
  matches?: Array<{
    id: string;
    label: string;
    valueLabel?: string;
    matchedOptionLabel?: string;
  }>;
  onClick: () => void;
  onMatchClick?: (id: string) => void;
}) {
  const Icon = section.icon;
  return (
    <div>
      <button
        type="button"
        className={cn(
          "flex h-9 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-sm transition-colors",
          active
            ? "bg-sidebar-accent text-sidebar-accent-foreground"
            : "text-foreground hover:bg-sidebar-accent/60",
        )}
        onClick={onClick}
      >
        <Icon className="size-4 shrink-0" />
        <span className="truncate">
          <HighlightedMatch text={section.label} query={searchQuery} />
        </span>
      </button>
      {searchQuery && matches && matches.length > 0 ? (
        <div className="mt-1 space-y-0.5 pl-6">
          {matches.map((match) => (
            <button
              type="button"
              key={match.id}
              className="flex min-h-7 w-full min-w-0 items-center gap-1 rounded-md px-2 text-left text-muted-foreground text-xs transition-colors hover:bg-sidebar-accent/60 hover:text-sidebar-foreground"
              onClick={() => onMatchClick?.(match.id)}
            >
              <span className="min-w-0 shrink-0 truncate">
                <HighlightedMatch text={match.label} query={searchQuery} />
              </span>
              {match.matchedOptionLabel || match.valueLabel ? (
                <span className="min-w-0 truncate text-muted-foreground/75">
                  <span aria-hidden="true">· </span>
                  {match.matchedOptionLabel ? (
                    <HighlightedMatch
                      text={match.matchedOptionLabel}
                      query={searchQuery}
                    />
                  ) : null}
                  {match.matchedOptionLabel && match.valueLabel ? (
                    <span aria-hidden="true"> / </span>
                  ) : null}
                  {match.valueLabel ? (
                    <HighlightedMatch
                      text={match.valueLabel}
                      query={searchQuery}
                    />
                  ) : null}
                </span>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function formatDeadlinePreview(
  selection: CatCcfddlDeadlineSelection | null,
  timezone: CatDisplayTimezone,
) {
  if (!selection) return "No deadline selected";
  if (timezone === "source") {
    return `${selection.deadline} ${selection.sourceTimezone}`;
  }

  const date = new Date(selection.deadlineIso);
  const formatter = new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: timezone === "utc" ? "UTC" : undefined,
    timeZoneName: "short",
  });
  return formatter.format(date);
}

function resolveStaticCatText(
  display: CatStaticDisplay,
  customText: string,
): string {
  if (display === "hakimi") return "南北绿豆";
  if (display === "custom") return customText.trim() || "Bibilabu";
  return "Bibilabu";
}

export function AppZoomControl() {
  const zoom = useSyncExternalStore(subscribeAppZoom, readStoredAppZoom);
  const [draft, setDraft] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const changeZoom = async (action: () => Promise<number>) => {
    setPending(true);
    setError(null);
    try {
      await action();
    } catch {
      setError("Could not change app zoom. Try again.");
    } finally {
      setPending(false);
      setDraft(null);
    }
  };
  const commitDraft = () => {
    if (draft === null || pending) return;
    const value = Number(draft.trim().replace(/%$/, ""));
    if (!draft.trim() || !Number.isFinite(value)) {
      setDraft(null);
      return;
    }
    void changeZoom(() => persistAppZoom(value / 100));
  };
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="sm"
          disabled={pending || zoom === DEFAULT_APP_ZOOM}
          aria-label="Reset app zoom"
          onClick={() => void changeZoom(resetAppZoom)}
        >
          Reset
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Zoom out app"
          disabled={pending || zoom <= MIN_APP_ZOOM}
          onClick={() => void changeZoom(zoomOutApp)}
        >
          <MinusIcon className="size-4" />
        </Button>
        <div className="flex h-8 items-center rounded-md border border-input bg-background focus-within:ring-1 focus-within:ring-ring">
          <Hint content="App zoom (50%–300%)">
            <input
              aria-label="App zoom level"
              inputMode="decimal"
              className="h-full w-12 bg-transparent pl-1 text-right text-sm tabular-nums outline-none"
              value={draft ?? String(Math.round(zoom * 100))}
              disabled={pending}
              onFocus={(event) => event.currentTarget.select()}
              onChange={(event) => setDraft(event.target.value)}
              onBlur={commitDraft}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  event.currentTarget.blur();
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  setDraft(null);
                }
              }}
            />
          </Hint>
          <span aria-hidden="true" className="pr-2 pl-0.5 text-sm">
            %
          </span>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Zoom in app"
          disabled={pending || zoom >= MAX_APP_ZOOM}
          onClick={() => void changeZoom(zoomInApp)}
        >
          <PlusIcon className="size-4" />
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-destructive text-xs">
          {error}
        </p>
      )}
    </div>
  );
}

export function SettingsWindow() {
  useAppZoomShortcuts();
  const [activeSection, setActiveSection] = useState<SettingsSection>(() => {
    const section = new URLSearchParams(window.location.search).get("section");
    return section === "agent" || section === "storage" || section === "about"
      ? section
      : "appearance";
  });
  const {
    status: updateStatus,
    checking: checkingUpdate,
    checkForUpdate,
    installUpdate,
    skipUpdate,
    openRelease,
  } = useUpdater();
  const [agentProvider, setAgentProvider] = useState<DefaultAgent>(() => {
    const provider = new URLSearchParams(window.location.search).get(
      "provider",
    );
    return provider === "claude" || provider === "codex" || provider === "pi"
      ? provider
      : useSettingsStore.getState().defaultAgent;
  });
  const selectAgentProvider = (provider: DefaultAgent) => {
    setAgentProvider(provider);
  };
  useEffect(() => {
    const unlisten = listen<string>("settings-navigate", ({ payload }) => {
      if (payload === "storage" || payload === "about") {
        setActiveSection(payload);
        setSearchQuery("");
        setPendingScrollRowId(null);
      }
      if (
        payload === "agent" ||
        payload === "claude" ||
        payload === "codex" ||
        payload === "pi"
      ) {
        if (payload !== "agent") setAgentProvider(payload);
        setActiveSection("agent");
        setSearchQuery("");
        setPendingScrollRowId("agent-provider-tabs");
      }
    });
    if (new URLSearchParams(window.location.search).get("section") === "agent")
      setPendingScrollRowId("agent-provider-tabs");
    return () => {
      void unlisten.then((stop) => stop());
    };
  }, []);
  const [version, setVersion] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const { theme, setTheme } = useTheme();
  const modeThemes = useSettingsStore((s) => s.modeThemes);
  const setModeTheme = useSettingsStore((s) => s.setModeTheme);
  const defaultAutoCompile = useSettingsStore((s) => s.defaultAutoCompile);
  const setDefaultAutoCompile = useSettingsStore(
    (s) => s.setDefaultAutoCompile,
  );
  const compilerBackend = useSettingsStore((s) => s.compilerBackend);
  const setCompilerBackend = useSettingsStore((s) => s.setCompilerBackend);
  const compilerEngine = useSettingsStore((s) => s.compilerEngine);
  const setCompilerEngine = useSettingsStore((s) => s.setCompilerEngine);
  const enabledProviders = useSettingsStore((s) => s.enabledProviders);
  const defaultAgent = useSettingsStore((s) => s.defaultAgent);
  const setDefaultAgent = useSettingsStore((s) => s.setDefaultAgent);
  const defaultClaudeModel = useSettingsStore((s) => s.defaultClaudeModel);
  const setDefaultClaudeModel = useSettingsStore(
    (s) => s.setDefaultClaudeModel,
  );
  const defaultClaudeEffortLevel = useSettingsStore(
    (s) => s.defaultClaudeEffortLevel,
  );
  const setDefaultClaudeEffortLevel = useSettingsStore(
    (s) => s.setDefaultClaudeEffortLevel,
  );
  const defaultCodexModel = useSettingsStore((s) => s.defaultCodexModel);
  const setDefaultCodexModel = useSettingsStore((s) => s.setDefaultCodexModel);
  const defaultCodexReasoningEffort = useSettingsStore(
    (s) => s.defaultCodexReasoningEffort,
  );
  const setDefaultCodexReasoningEffort = useSettingsStore(
    (s) => s.setDefaultCodexReasoningEffort,
  );
  const pi = usePiSetupStore();
  const piPathSettings = usePiPathSettings();
  const piBinaryPath = useSettingsStore((s) => s.piBinaryPath);
  const piConfigDirectory = useSettingsStore((s) => s.piConfigDirectory);
  const piBinaryPaths = useSettingsStore((s) => s.piBinaryPaths);
  const piConfigDirectories = useSettingsStore((s) => s.piConfigDirectories);

  const defaultPiModel = useSettingsStore((s) => s.defaultPiModel);
  const setDefaultPiModel = useSettingsStore((s) => s.setDefaultPiModel);
  const defaultPiReasoningEffort = useSettingsStore(
    (s) => s.defaultPiReasoningEffort,
  );
  const setDefaultPiReasoningEffort = useSettingsStore(
    (s) => s.setDefaultPiReasoningEffort,
  );
  const piModelOptions = useMemo(
    () =>
      pi.models.map((model) => ({
        value: piModelValue(model),
        label: piModelLabel(piModelValue(model), pi.models),
      })),
    [pi.models],
  );
  const piModelInfo = findPiModel(pi.models, defaultPiModel);
  const piEffortOptions = piModelInfo?.reasoning
    ? piModelThinkingLevels(piModelInfo)
    : [];
  const piEffort = resolvePiThinkingLevel(
    piModelInfo,
    defaultPiReasoningEffort,
  );
  useEffect(() => {
    if (piEffort !== undefined && piEffort !== defaultPiReasoningEffort) {
      setDefaultPiReasoningEffort(piEffort);
    }
  }, [piEffort, defaultPiReasoningEffort, setDefaultPiReasoningEffort]);
  const discoveredClaudeModels = useClaudeModels();
  const claudeModelsStatus = useClaudeSetupStore((s) => s.modelsStatus);
  const claudeModelsError = useClaudeSetupStore((s) => s.modelsError);
  const checkClaudeStatus = useClaudeSetupStore((s) => s.checkStatus);
  const refreshClaudeModels = useClaudeSetupStore((s) => s.refreshModels);
  const defaultClaudeModelInfo = findClaudeModel(
    discoveredClaudeModels,
    defaultClaudeModel,
  );
  const claudeModelOptions = useMemo(() => {
    const options = discoveredClaudeModels.map((model) => ({
      value:
        model === defaultClaudeModelInfo ? defaultClaudeModel : model.value,
      label: claudeModelLabel(model.value, discoveredClaudeModels),
    }));
    if (!options.some((option) => option.value === defaultClaudeModel)) {
      options.push({
        value: defaultClaudeModel,
        label: claudeModelLabel(defaultClaudeModel),
      });
    }
    return options;
  }, [discoveredClaudeModels, defaultClaudeModelInfo, defaultClaudeModel]);
  const claudeEffortOptions = useMemo(
    () =>
      claudeModelEfforts(defaultClaudeModelInfo).map((value) => ({
        value,
        label:
          value === "xhigh"
            ? "Extra High"
            : value[0].toUpperCase() + value.slice(1),
      })),
    [defaultClaudeModelInfo],
  );
  useEffect(() => {
    if (
      defaultClaudeModelInfo &&
      claudeEffortOptions.length &&
      !claudeEffortOptions.some(
        (option) => option.value === defaultClaudeEffortLevel,
      )
    ) {
      setDefaultClaudeEffortLevel(
        claudeEffortOptions.find((option) => option.value === "medium")
          ?.value ?? claudeEffortOptions[0].value,
      );
    }
  }, [
    defaultClaudeModelInfo,
    claudeEffortOptions,
    defaultClaudeEffortLevel,
    setDefaultClaudeEffortLevel,
  ]);
  const discoveredCodexModels = useCodexModels();
  const checkCodexStatus = useCodexSetupStore((s) => s.checkStatus);
  const codexModelOptions = useMemo(() => {
    if (discoveredCodexModels.length === 0) {
      return FALLBACK_CODEX_MODEL_OPTIONS;
    }
    const options = discoveredCodexModels.map((model) => ({
      value: model.model,
      label: model.display_name || formatCodexModelName(model.model),
    }));
    return options;
  }, [discoveredCodexModels]);
  const defaultCodexModelInfo = discoveredCodexModels.find(
    (model) => model.model === defaultCodexModel,
  );
  useEffect(() => {
    const efforts = defaultCodexModelInfo?.supported_reasoning_efforts;
    if (
      efforts?.length &&
      !efforts.some((effort) => effort.value === defaultCodexReasoningEffort)
    ) {
      setDefaultCodexReasoningEffort(
        defaultCodexModelInfo?.default_reasoning_effort || efforts[0].value,
      );
    }
  }, [
    defaultCodexModelInfo,
    defaultCodexReasoningEffort,
    setDefaultCodexReasoningEffort,
  ]);
  const codexReasoningOptions = useMemo(() => {
    const efforts = defaultCodexModelInfo?.supported_reasoning_efforts;
    if (!efforts?.length) return FALLBACK_CODEX_REASONING_OPTIONS;
    const options = efforts.map((effort) => ({
      value: effort.value,
      label: codexEffortLabel(effort.value),
    }));
    if (
      !options.some((option) => option.value === defaultCodexReasoningEffort)
    ) {
      options.push({
        value: defaultCodexReasoningEffort,
        label: codexEffortLabel(defaultCodexReasoningEffort),
      });
    }
    return options;
  }, [defaultCodexModelInfo, defaultCodexReasoningEffort]);
  const defaultAgentExecutionMode = useSettingsStore(
    (s) => s.defaultAgentExecutionMode,
  );
  const setDefaultAgentExecutionMode = useSettingsStore(
    (s) => s.setDefaultAgentExecutionMode,
  );
  const globalAgentPrompt = useSettingsStore((s) => s.globalAgentPrompt);
  const setGlobalAgentPrompt = useSettingsStore((s) => s.setGlobalAgentPrompt);
  const [globalPromptDraft, setGlobalPromptDraft] = useState<string | null>(
    null,
  );
  const globalPromptInput = useRef<HTMLTextAreaElement>(null);
  const editorColorScheme = useSettingsStore((s) => s.editorColorScheme);
  const setEditorColorScheme = useSettingsStore((s) => s.setEditorColorScheme);
  const editorFontSize = useSettingsStore((s) => s.editorFontSize);
  const spellCheck = useSettingsStore((s) => s.spellCheck);
  const spellingLanguage = useSettingsStore((s) => s.spellingLanguage);
  const showEditorMinimap = useSettingsStore((s) => s.showEditorMinimap);
  const setShowEditorMinimap = useSettingsStore((s) => s.setShowEditorMinimap);
  const setEditorFontSize = useSettingsStore((s) => s.setEditorFontSize);
  const markdownLoadTyporaThemes = useSettingsStore(
    (s) => s.markdownLoadTyporaThemes,
  );
  const setMarkdownLoadTyporaThemes = useSettingsStore(
    (s) => s.setMarkdownLoadTyporaThemes,
  );
  const markdownThemeDirectory = useSettingsStore(
    (s) => s.markdownThemeDirectory,
  );
  const setMarkdownThemeDirectory = useSettingsStore(
    (s) => s.setMarkdownThemeDirectory,
  );
  const markdownSeparateLightDarkThemes = useSettingsStore(
    (s) => s.markdownSeparateLightDarkThemes,
  );
  const setMarkdownSeparateLightDarkThemes = useSettingsStore(
    (s) => s.setMarkdownSeparateLightDarkThemes,
  );
  const markdownPreviewTheme = useSettingsStore((s) => s.markdownPreviewTheme);
  const setMarkdownPreviewTheme = useSettingsStore(
    (s) => s.setMarkdownPreviewTheme,
  );
  const markdownPreviewLightTheme = useSettingsStore(
    (s) => s.markdownPreviewLightTheme,
  );
  const setMarkdownPreviewLightTheme = useSettingsStore(
    (s) => s.setMarkdownPreviewLightTheme,
  );
  const markdownPreviewDarkTheme = useSettingsStore(
    (s) => s.markdownPreviewDarkTheme,
  );
  const setMarkdownPreviewDarkTheme = useSettingsStore(
    (s) => s.setMarkdownPreviewDarkTheme,
  );
  const showTooltips = useSettingsStore((s) => s.showTooltips);
  const tooltipHoverDelay = useSettingsStore((s) => s.tooltipHoverDelay);
  const setShowTooltips = useSettingsStore((s) => s.setShowTooltips);
  const setTooltipHoverDelay = useSettingsStore((s) => s.setTooltipHoverDelay);
  const solarModeLevel = useSettingsStore((s) => s.solarModeLevel);
  const setSolarModeLevel = useSettingsStore((s) => s.setSolarModeLevel);
  const catDisplayMode = useSettingsStore((s) => s.catDisplayMode);
  const setCatDisplayMode = useSettingsStore((s) => s.setCatDisplayMode);
  const catStaticDisplay = useSettingsStore((s) => s.catStaticDisplay);
  const setCatStaticDisplay = useSettingsStore((s) => s.setCatStaticDisplay);
  const catCustomText = useSettingsStore((s) => s.catCustomText);
  const setCatCustomText = useSettingsStore((s) => s.setCatCustomText);
  const catSelectedCcfddlDeadline = useSettingsStore(
    (s) => s.catSelectedCcfddlDeadline,
  );
  const setCatSelectedCcfddlDeadline = useSettingsStore(
    (s) => s.setCatSelectedCcfddlDeadline,
  );
  const catDisplayTimezone = useSettingsStore((s) => s.catDisplayTimezone);
  const setCatDisplayTimezone = useSettingsStore(
    (s) => s.setCatDisplayTimezone,
  );
  const catCountdownPrecision = useSettingsStore(
    (s) => s.catCountdownPrecision,
  );
  const setCatCountdownPrecision = useSettingsStore(
    (s) => s.setCatCountdownPrecision,
  );
  const keyboardShortcutOverrides = useSettingsStore(
    (s) => s.keyboardShortcutOverrides,
  );
  const setKeyboardShortcut = useSettingsStore((s) => s.setKeyboardShortcut);
  const resetKeyboardShortcut = useSettingsStore(
    (s) => s.resetKeyboardShortcut,
  );
  const resetKeyboardShortcuts = useSettingsStore(
    (s) => s.resetKeyboardShortcuts,
  );
  const [recordingShortcut, setRecordingShortcut] =
    useState<KeyboardShortcutActionId | null>(null);
  const [shortcutError, setShortcutError] = useState<string | null>(null);
  const [pendingScrollRowId, setPendingScrollRowId] = useState<string | null>(
    null,
  );
  const [installedMarkdownThemes, setInstalledMarkdownThemes] = useState<
    InstalledMarkdownTheme[]
  >([]);
  const [resolvedMarkdownThemeDirectory, setResolvedMarkdownThemeDirectory] =
    useState<string | null>(null);
  const [markdownThemeDirectoryDraft, setMarkdownThemeDirectoryDraft] =
    useState("");
  const [markdownThemeFolderStatus, setMarkdownThemeFolderStatus] = useState<
    "loading" | "ready" | "not-found" | "error"
  >("loading");
  const markdownThemeDirectoryInputRef = useRef<HTMLInputElement>(null);
  const contentScrollRef = useRef<HTMLDivElement>(null);
  const normalizedSearchQuery = searchQuery.trim().toLowerCase();
  useEffect(() => {
    void usePiSetupStore.getState().checkStatus();
    checkCodexStatus().catch(() => {});
    checkClaudeStatus().catch(() => {});
  }, [checkCodexStatus, checkClaudeStatus]);

  useEffect(() => {
    let cancelled = false;
    setInstalledMarkdownThemes([]);
    setResolvedMarkdownThemeDirectory(null);
    if (!markdownLoadTyporaThemes) {
      setMarkdownThemeFolderStatus("not-found");
      return;
    }
    setMarkdownThemeFolderStatus("loading");
    resolveMarkdownThemeDirectory(markdownThemeDirectory)
      .then(async (directory) => {
        if (cancelled) return;
        if (!directory) {
          setMarkdownThemeFolderStatus("not-found");
          return;
        }
        setResolvedMarkdownThemeDirectory(directory);
        const themes = await listMarkdownThemes(directory);
        if (cancelled) return;
        setInstalledMarkdownThemes(themes);
        setMarkdownThemeFolderStatus("ready");
      })
      .catch(() => {
        if (cancelled) return;
        setInstalledMarkdownThemes([]);
        setMarkdownThemeFolderStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, [markdownLoadTyporaThemes, markdownThemeDirectory]);

  useEffect(() => {
    if (document.activeElement === markdownThemeDirectoryInputRef.current) {
      return;
    }
    setMarkdownThemeDirectoryDraft(
      markdownThemeDirectory ?? resolvedMarkdownThemeDirectory ?? "",
    );
  }, [markdownThemeDirectory, resolvedMarkdownThemeDirectory]);

  useEffect(() => {
    if (
      discoveredClaudeModels.length > 0 &&
      !findClaudeModel(discoveredClaudeModels, defaultClaudeModel)
    ) {
      setDefaultClaudeModel(
        discoveredClaudeModels.find((model) => model.value === "default")
          ?.value ?? discoveredClaudeModels[0].value,
      );
    }
  }, [defaultClaudeModel, discoveredClaudeModels, setDefaultClaudeModel]);

  useEffect(() => {
    if (
      discoveredCodexModels.length > 0 &&
      !discoveredCodexModels.some((model) => model.model === defaultCodexModel)
    ) {
      setDefaultCodexModel(
        discoveredCodexModels.find((model) => model.is_default)?.model ??
          discoveredCodexModels[0].model,
      );
    }
  }, [defaultCodexModel, discoveredCodexModels, setDefaultCodexModel]);

  useEffect(() => {
    if (
      defaultCodexModelInfo &&
      !defaultCodexModelInfo.supported_reasoning_efforts.some(
        (effort) => effort.value === defaultCodexReasoningEffort,
      )
    ) {
      setDefaultCodexReasoningEffort(
        defaultCodexModelInfo.default_reasoning_effort,
      );
    }
  }, [
    defaultCodexModelInfo,
    defaultCodexReasoningEffort,
    setDefaultCodexReasoningEffort,
  ]);
  const resolvedTheme: ThemeOption =
    theme === "light" || theme === "dark" ? theme : "system";
  const effectiveMarkdownPreviewTheme =
    markdownLoadTyporaThemes || isBuiltInMarkdownTheme(markdownPreviewTheme)
      ? markdownPreviewTheme
      : GITHUB_LIGHT_MARKDOWN_THEME_ID;
  const effectiveMarkdownPreviewLightTheme =
    markdownLoadTyporaThemes ||
    isBuiltInMarkdownTheme(markdownPreviewLightTheme)
      ? markdownPreviewLightTheme
      : GITHUB_LIGHT_MARKDOWN_THEME_ID;
  const effectiveMarkdownPreviewDarkTheme =
    markdownLoadTyporaThemes || isBuiltInMarkdownTheme(markdownPreviewDarkTheme)
      ? markdownPreviewDarkTheme
      : GITHUB_DARK_MARKDOWN_THEME_ID;
  const markdownThemeOptions = useMemo(() => {
    const options: Array<{
      value: string;
      label: string;
      icon?: LucideIcon;
    }> = [
      ...BUILT_IN_MARKDOWN_THEME_OPTIONS,
      ...installedMarkdownThemes.map((theme) => ({
        value: theme.path,
        label: theme.label,
        icon: FileCodeIcon,
      })),
    ];
    const configuredThemes = markdownLoadTyporaThemes
      ? [
          markdownPreviewTheme,
          markdownPreviewLightTheme,
          markdownPreviewDarkTheme,
        ]
      : [];
    for (const configuredTheme of configuredThemes) {
      if (
        isBuiltInMarkdownTheme(configuredTheme) ||
        options.some((option) => option.value === configuredTheme)
      ) {
        continue;
      }
      options.push({
        value: configuredTheme,
        label: `${markdownThemeLabel(markdownThemeFileName(configuredTheme))} (unavailable)`,
        icon: FileCodeIcon,
      });
    }
    return options;
  }, [
    installedMarkdownThemes,
    markdownLoadTyporaThemes,
    markdownPreviewDarkTheme,
    markdownPreviewLightTheme,
    markdownPreviewTheme,
  ]);
  const markdownThemeValueLabel = getOptionLabel(
    markdownThemeOptions,
    effectiveMarkdownPreviewTheme,
  );
  const markdownLightThemeValueLabel = getOptionLabel(
    markdownThemeOptions,
    effectiveMarkdownPreviewLightTheme,
  );
  const markdownDarkThemeValueLabel = getOptionLabel(
    markdownThemeOptions,
    effectiveMarkdownPreviewDarkTheme,
  );
  const catPreview =
    catDisplayMode === "ccfddl"
      ? resolveCcfddlCatLabel({
          mode: "ccfddl",
          selectedEntry: catSelectedCcfddlDeadline,
          countdownPrecision: catCountdownPrecision,
        }).replace("\n", " · ")
      : resolveStaticCatText(catStaticDisplay, catCustomText);
  const searchableSettings = useMemo(() => {
    const conferenceValue = catSelectedCcfddlDeadline
      ? `${catSelectedCcfddlDeadline.displayTitle} · ${catSelectedCcfddlDeadline.deadline} ${catSelectedCcfddlDeadline.sourceTimezone}`
      : undefined;
    const settings: SearchableSetting[] = [
      {
        id: "appearance-theme",
        section: "appearance",
        label: "Appearance",
        valueLabel: getOptionLabel(THEME_OPTIONS, resolvedTheme),
        searchText: [
          "Appearance",
          "Light Dark System",
          getOptionLabel(THEME_OPTIONS, resolvedTheme),
          ...getOptionSearchText(THEME_OPTIONS),
        ],
        searchOptions: getSearchOptions(THEME_OPTIONS),
      },
      {
        id: "appearance-app-zoom",
        section: "appearance",
        label: "App Zoom",
        searchText: ["App Zoom", "Scale interface size zoom in out reset"],
      },
      {
        id: "appearance-show-tooltips",
        section: "appearance",
        label: "Show Tooltips",
        searchText: ["Show tooltips", "Hints hover help visibility"],
      },
      {
        id: "appearance-tooltip-delay",
        section: "appearance",
        label: "Hover Delay",
        searchText: ["Tooltip hover delay", "400 ms immediate"],
      },
      ...WORKSPACE_MODES.map(({ id, label }) => ({
        id: `appearance-mode-theme-${id}`,
        section: "appearance" as const,
        label: `${label} Theme`,
        valueLabel: getOptionLabel(UI_THEME_OPTIONS, modeThemes[id]),
        searchText: [
          `${label} Theme`,
          "Workspace Themes Style",
          ...getOptionSearchText(UI_THEME_OPTIONS),
        ],
        searchOptions: getSearchOptions(UI_THEME_OPTIONS),
      })),
      {
        id: "appearance-solarize",
        section: "appearance",
        label: "Solarize",
        valueLabel: SOLAR_MODE_LABELS[solarModeLevel],
        searchText: [
          "Solarize",
          SOLAR_MODE_LABELS[solarModeLevel],
          ...getOptionSearchText(SOLAR_MODE_OPTIONS),
        ],
        searchOptions: getSearchOptions(SOLAR_MODE_OPTIONS),
      },
      {
        id: "appearance-editor-color-scheme",
        section: "appearance",
        label: "Editor Color Scheme",
        valueLabel: getOptionLabel(
          EDITOR_COLOR_SCHEME_OPTIONS,
          editorColorScheme,
        ),
        searchText: [
          "Editor Color Scheme",
          getOptionLabel(EDITOR_COLOR_SCHEME_OPTIONS, editorColorScheme),
          ...getOptionSearchText(EDITOR_COLOR_SCHEME_OPTIONS),
        ],
        searchOptions: getSearchOptions(EDITOR_COLOR_SCHEME_OPTIONS),
      },
      {
        id: "appearance-editor-spellcheck",
        section: "appearance",
        label: "Spell Check",
        valueLabel: spellCheck ? "On" : "Off",
        searchText: ["Spell Check", "Spelling", "Dictionary"],
      },
      {
        id: "appearance-editor-spelling-language",
        section: "appearance",
        label: "Spelling Language",
        valueLabel: getOptionLabel(SPELLING_LANGUAGES, spellingLanguage),
        searchText: [
          "Spelling Language",
          "Dictionary",
          ...getOptionSearchText(SPELLING_LANGUAGES),
        ],
        searchOptions: getSearchOptions(SPELLING_LANGUAGES),
      },
      {
        id: "appearance-editor-minimap",
        section: "appearance",
        label: "Show Minimap",
        valueLabel: showEditorMinimap ? "On" : "Off",
        searchText: [
          "Show Minimap",
          "Editor navigation scrollbar",
          showEditorMinimap ? "On" : "Off",
        ],
      },
      {
        id: "appearance-editor-font-size",
        section: "appearance",
        label: "Editor Font Size",
        valueLabel: `${editorFontSize}px`,
        searchText: [
          "Editor Font Size",
          `${editorFontSize}px`,
          ...getOptionSearchText(EDITOR_FONT_SIZE_OPTIONS),
        ],
        searchOptions: getSearchOptions(EDITOR_FONT_SIZE_OPTIONS),
      },
      {
        id: "rendering-markdown-load-typora-themes",
        section: "rendering",
        label: "Load Typora Themes",
        valueLabel: markdownLoadTyporaThemes ? "On" : "Off",
        searchText: [
          "Load Typora Themes",
          "Markdown Preview CSS Themes",
          markdownLoadTyporaThemes ? "On" : "Off",
        ],
      },
      ...(markdownLoadTyporaThemes
        ? [
            {
              id: "rendering-markdown-theme-folder",
              section: "rendering" as const,
              label: "Typora Theme Folder",
              valueLabel: resolvedMarkdownThemeDirectory ?? undefined,
              searchText: [
                "Typora Theme Folder",
                "Markdown Preview CSS Themes",
                markdownThemeDirectory ? "Custom folder" : "Default folder",
                resolvedMarkdownThemeDirectory ?? "",
              ],
            },
          ]
        : []),
      {
        id: "rendering-markdown-separate-themes",
        section: "rendering",
        label: "Separate Light and Dark Themes",
        valueLabel: markdownSeparateLightDarkThemes ? "On" : "Off",
        searchText: [
          "Separate Light and Dark Themes",
          "Markdown Preview Theme Mode",
          markdownSeparateLightDarkThemes ? "On" : "Off",
        ],
      },
      ...(markdownSeparateLightDarkThemes
        ? [
            {
              id: "rendering-markdown-light-theme",
              section: "rendering" as const,
              label: "Light Markdown Theme",
              valueLabel: markdownLightThemeValueLabel,
              searchText: [
                "Light Markdown Theme",
                "Markdown Preview Theme",
                "Typora CSS",
                markdownLightThemeValueLabel,
                ...getOptionSearchText(markdownThemeOptions),
              ],
              searchOptions: getSearchOptions(markdownThemeOptions),
            },
            {
              id: "rendering-markdown-dark-theme",
              section: "rendering" as const,
              label: "Dark Markdown Theme",
              valueLabel: markdownDarkThemeValueLabel,
              searchText: [
                "Dark Markdown Theme",
                "Markdown Preview Theme",
                "Typora CSS",
                markdownDarkThemeValueLabel,
                ...getOptionSearchText(markdownThemeOptions),
              ],
              searchOptions: getSearchOptions(markdownThemeOptions),
            },
          ]
        : [
            {
              id: "rendering-markdown-theme",
              section: "rendering" as const,
              label: "Markdown Theme",
              valueLabel: markdownThemeValueLabel,
              searchText: [
                "Markdown Theme",
                "Markdown Preview Theme",
                "Typora CSS",
                markdownThemeValueLabel,
                ...getOptionSearchText(markdownThemeOptions),
              ],
              searchOptions: getSearchOptions(markdownThemeOptions),
            },
          ]),
      {
        id: "cat-display",
        section: "cat",
        label: "Display",
        valueLabel: getOptionLabel(CAT_MODE_OPTIONS, catDisplayMode),
        searchText: [
          "Display",
          "Cat Display",
          getOptionLabel(CAT_MODE_OPTIONS, catDisplayMode),
          ...getOptionSearchText(CAT_MODE_OPTIONS),
        ],
        searchOptions: getSearchOptions(CAT_MODE_OPTIONS),
      },
      {
        id: "cat-preview",
        section: "cat",
        label: "Preview",
        valueLabel: catPreview,
        searchText: ["Preview", catPreview],
      },
      {
        id: "agent-default-agent",
        section: "agent",
        label: "Default Agent",
        valueLabel: getOptionLabel(AGENT_OPTIONS, defaultAgent),
        searchText: [
          "Default Agent",
          getOptionLabel(AGENT_OPTIONS, defaultAgent),
          ...getOptionSearchText(AGENT_OPTIONS),
        ],
        searchOptions: getSearchOptions(AGENT_OPTIONS),
      },
      {
        id: "agent-custom-models",
        section: "agent",
        label: "Legacy models",
        searchText: [
          "legacy models",
          "custom models",
          "add model",
          "model ID",
          "Claude",
          "Codex",
        ],
      },
      {
        id: "agent-claude-model",
        section: "agent",
        label: "Claude Model",
        valueLabel: getOptionLabel(claudeModelOptions, defaultClaudeModel),
        searchText: [
          "Claude Model",
          getOptionLabel(claudeModelOptions, defaultClaudeModel),
          ...getOptionSearchText(claudeModelOptions),
        ],
        searchOptions: getSearchOptions(claudeModelOptions),
      },
      {
        id: "agent-claude-effort",
        section: "agent",
        label: "Claude Effort",
        valueLabel: getOptionLabel(
          claudeEffortOptions,
          defaultClaudeEffortLevel,
        ),
        searchText: [
          "Claude Effort",
          getOptionLabel(claudeEffortOptions, defaultClaudeEffortLevel),
          ...getOptionSearchText(claudeEffortOptions),
        ],
        searchOptions: getSearchOptions(claudeEffortOptions),
      },
      {
        id: "agent-pi-executable",
        section: "agent",
        label: "Pi executable",
        valueLabel: piBinaryPath || "Select…",
        searchText: [
          "pi",
          "installation",
          "path",
          "executable",
          "binary",
          "browse",
        ],
      },
      {
        id: "agent-pi-config",
        section: "agent",
        label: "Pi config folder",
        valueLabel: piConfigDirectory || "Select…",
        searchText: ["pi", "config", "folder", "directory", "path", "browse"],
      },
      {
        id: "agent-pi-model",
        section: "agent",
        label: "Pi Model",
        valueLabel: piModelLabel(defaultPiModel, pi.models),
        searchText: [
          "pi",
          "model",
          "local",
          ...getOptionSearchText(piModelOptions),
        ],
        searchOptions: getSearchOptions(piModelOptions),
      },
      {
        id: "agent-codex-model",
        section: "agent",
        label: "Codex Model",
        valueLabel: getOptionLabel(codexModelOptions, defaultCodexModel),
        searchText: [
          "Codex Model",
          getOptionLabel(codexModelOptions, defaultCodexModel),
          ...getOptionSearchText(codexModelOptions),
        ],
        searchOptions: getSearchOptions(codexModelOptions),
      },
      {
        id: "agent-codex-reasoning",
        section: "agent",
        label: "Codex Reasoning",
        valueLabel: getOptionLabel(
          codexReasoningOptions,
          defaultCodexReasoningEffort,
        ),
        searchText: [
          "Codex Reasoning",
          getOptionLabel(codexReasoningOptions, defaultCodexReasoningEffort),
          ...getOptionSearchText(codexReasoningOptions),
        ],
        searchOptions: getSearchOptions(codexReasoningOptions),
      },
      {
        id: "agent-default-mode",
        section: "agent",
        label: "Default",
        valueLabel: getOptionLabel(
          AGENT_MODE_OPTIONS,
          defaultAgentExecutionMode,
        ),
        searchText: [
          "Default",
          getOptionLabel(AGENT_MODE_OPTIONS, defaultAgentExecutionMode),
          ...getOptionSearchText(AGENT_MODE_OPTIONS),
        ],
        searchOptions: getSearchOptions(AGENT_MODE_OPTIONS),
      },
      {
        id: "agent-global-instructions",
        section: "agent",
        label: "Global Instructions",
        valueLabel: globalAgentPrompt.trim() ? "Set" : "Empty",
        searchText: ["Global Instructions", "System Prompt", "Agent Prompt"],
      },
      {
        id: "agent-prompt-library",
        section: "agent",
        label: "Prompt Library",
        valueLabel: "Manage",
        searchText: [
          "Prompt Library",
          "Saved prompts",
          "Predefined prompts",
          "Proofread",
        ],
      },
      {
        id: "auto-compile",
        section: "rendering",
        label: "Auto compile",
        valueLabel: defaultAutoCompile ? "On" : "Off",
        searchText: [
          "Auto compile",
          "Automatic recompilation",
          "New projects",
          "Default",
        ],
      },
      {
        id: "compiler-backend",
        section: "rendering",
        label: "Backend",
        valueLabel: getOptionLabel(COMPILER_OPTIONS, compilerBackend),
        searchText: [
          "Backend",
          "Compiler Backend",
          getOptionLabel(COMPILER_OPTIONS, compilerBackend),
          ...getOptionSearchText(COMPILER_OPTIONS),
        ],
        searchOptions: getSearchOptions(COMPILER_OPTIONS),
      },
      {
        id: "compiler-engine",
        section: "rendering",
        label: "Engine",
        valueLabel: getOptionLabel(COMPILER_ENGINE_OPTIONS, compilerEngine),
        searchText: [
          "Engine",
          "LaTeX Engine",
          getOptionLabel(COMPILER_ENGINE_OPTIONS, compilerEngine),
          ...getOptionSearchText(COMPILER_ENGINE_OPTIONS),
        ],
        searchOptions: getSearchOptions(COMPILER_ENGINE_OPTIONS),
      },
      ...KEYBOARD_SHORTCUT_ACTIONS.map((action) => {
        const binding = resolveKeyboardShortcut(
          keyboardShortcutOverrides,
          action.id,
        );
        const valueLabel = binding
          ? formatKeyboardShortcut(binding)
          : "Unassigned";
        return {
          id: `keyboard-${action.id}`,
          section: "keyboard" as const,
          label: action.label,
          valueLabel,
          searchText: [
            action.label,
            action.description,
            action.group,
            "Keyboard Hotkey Shortcut",
            valueLabel,
          ],
        };
      }),
      {
        id: "storage-projects",
        section: "storage",
        label: "Stored projects",
        searchText: [
          "Storage",
          "disk",
          "history",
          "cache",
          "project",
          "sessions",
          "cleanup",
          "space",
        ],
      },
      {
        id: "about-version",
        section: "about",
        label: "Version",
        valueLabel: version || "Unknown",
        searchText: ["Version", version || "Unknown"],
      },
      {
        id: "about-updates",
        section: "about",
        label: "Updates",
        searchText: [
          "Updates",
          "Check for updates",
          "Download",
          "GitHub",
          "Manual installation",
          "Install update",
          "Skip this version",
        ],
      },
      {
        id: "about-update-channel",
        section: "about",
        label: "Update Channel",
        valueLabel: "GitHub Releases",
        searchText: ["Update Channel", "GitHub Releases"],
      },
    ];

    if (catDisplayMode === "ccfddl") {
      settings.splice(
        5,
        0,
        {
          id: "cat-conference-deadline",
          section: "cat",
          label: "Conference Deadline",
          valueLabel: conferenceValue,
          searchText: [
            "Conference Deadline",
            catSelectedCcfddlDeadline?.displayTitle ?? "",
            catSelectedCcfddlDeadline?.deadline ?? "",
            catSelectedCcfddlDeadline?.sourceTimezone ?? "",
          ],
        },
        {
          id: "cat-time-zone",
          section: "cat",
          label: "Time Zone",
          valueLabel: getOptionLabel(CAT_TIMEZONE_OPTIONS, catDisplayTimezone),
          searchText: [
            "Time Zone",
            getOptionLabel(CAT_TIMEZONE_OPTIONS, catDisplayTimezone),
            ...getOptionSearchText(CAT_TIMEZONE_OPTIONS),
          ],
          searchOptions: getSearchOptions(CAT_TIMEZONE_OPTIONS),
        },
        {
          id: "cat-countdown",
          section: "cat",
          label: "Countdown",
          valueLabel: getOptionLabel(
            CAT_COUNTDOWN_OPTIONS,
            catCountdownPrecision,
          ),
          searchText: [
            "Countdown",
            getOptionLabel(CAT_COUNTDOWN_OPTIONS, catCountdownPrecision),
            ...getOptionSearchText(CAT_COUNTDOWN_OPTIONS),
          ],
          searchOptions: getSearchOptions(CAT_COUNTDOWN_OPTIONS),
        },
      );
    } else {
      settings.splice(5, 0, {
        id: "cat-static-text",
        section: "cat",
        label: "Static Text",
        valueLabel: getOptionLabel(CAT_STATIC_OPTIONS, catStaticDisplay),
        searchText: [
          "Static Text",
          getOptionLabel(CAT_STATIC_OPTIONS, catStaticDisplay),
          ...getOptionSearchText(CAT_STATIC_OPTIONS),
        ],
        searchOptions: getSearchOptions(CAT_STATIC_OPTIONS),
      });
      if (catStaticDisplay === "custom") {
        settings.splice(6, 0, {
          id: "cat-custom-text",
          section: "cat",
          label: "Custom Text",
          valueLabel: catCustomText,
          searchText: ["Custom Text", catCustomText],
        });
      }
    }

    return settings;
  }, [
    catCountdownPrecision,
    catCustomText,
    catDisplayMode,
    catDisplayTimezone,
    catPreview,
    catSelectedCcfddlDeadline,
    catStaticDisplay,
    defaultAutoCompile,
    compilerBackend,
    compilerEngine,
    codexModelOptions,
    codexReasoningOptions,
    defaultPiModel,
    pi.models,
    piBinaryPath,
    piConfigDirectory,
    piModelOptions,
    claudeModelOptions,
    claudeEffortOptions,
    defaultAgent,
    defaultClaudeEffortLevel,
    defaultClaudeModel,
    defaultCodexModel,
    defaultCodexReasoningEffort,
    defaultAgentExecutionMode,
    globalAgentPrompt,
    keyboardShortcutOverrides,
    editorColorScheme,
    editorFontSize,
    spellCheck,
    spellingLanguage,
    showEditorMinimap,
    markdownDarkThemeValueLabel,
    markdownLightThemeValueLabel,
    markdownLoadTyporaThemes,
    markdownSeparateLightDarkThemes,
    markdownThemeDirectory,
    markdownThemeOptions,
    markdownThemeValueLabel,
    modeThemes,
    resolvedMarkdownThemeDirectory,
    resolvedTheme,
    solarModeLevel,
    version,
  ]);
  const searchMatchesBySection = useMemo(() => {
    if (!normalizedSearchQuery)
      return new Map<SettingsSection, SearchMatch[]>();

    const matchesBySection = new Map<SettingsSection, SearchMatch[]>();
    for (const setting of searchableSettings) {
      if (
        !setting.searchText.some((text) =>
          text.toLowerCase().includes(normalizedSearchQuery),
        )
      ) {
        continue;
      }
      const labelOrSelectedValueMatches =
        setting.label.toLowerCase().includes(normalizedSearchQuery) ||
        setting.valueLabel?.toLowerCase().includes(normalizedSearchQuery);
      const matchedOption = labelOrSelectedValueMatches
        ? undefined
        : setting.searchOptions?.find(
            (option) =>
              option.label !== setting.valueLabel &&
              (option.label.toLowerCase().includes(normalizedSearchQuery) ||
                option.value.toLowerCase().includes(normalizedSearchQuery)),
          );
      const sectionMatches = matchesBySection.get(setting.section) ?? [];
      sectionMatches.push({
        id: setting.id,
        section: setting.section,
        label: setting.label,
        valueLabel: setting.valueLabel,
        matchedOptionLabel: matchedOption?.label,
      });
      matchesBySection.set(setting.section, sectionMatches);
    }

    return matchesBySection;
  }, [normalizedSearchQuery, searchableSettings]);

  useEffect(() => {
    resolveAppVersion().then(setVersion);
  }, []);

  useEffect(() => {
    setRecordingShortcut(null);
    setShortcutError(null);
  }, [activeSection]);

  useEffect(() => {
    if (!pendingScrollRowId) return;

    const frameId = requestAnimationFrame(() => {
      const row = contentScrollRef.current?.querySelector<HTMLElement>(
        `[data-settings-row-id="${pendingScrollRowId}"]`,
      );
      row?.scrollIntoView({
        block:
          pendingScrollRowId === "agent-custom-models" ||
          pendingScrollRowId === "agent-provider-tabs"
            ? "start"
            : "center",
      });
      setPendingScrollRowId(null);
    });

    return () => cancelAnimationFrame(frameId);
  }, [pendingScrollRowId, activeSection]);

  const handleSolarModeChange = (level: SolarModeLevel) => {
    setSolarModeLevel(level);
    broadcastSettingsChanged();
  };
  const handleEditorFontSizeChange = (fontSize: number) => {
    setEditorFontSize(fontSize);
    broadcastSettingsChanged();
  };
  const handleEditorColorSchemeChange = (scheme: EditorColorScheme) => {
    setEditorColorScheme(scheme);
    broadcastSettingsChanged();
  };
  const resetMarkdownPreviewThemes = () => {
    setMarkdownPreviewTheme(GITHUB_LIGHT_MARKDOWN_THEME_ID);
    setMarkdownPreviewLightTheme(GITHUB_LIGHT_MARKDOWN_THEME_ID);
    setMarkdownPreviewDarkTheme(GITHUB_DARK_MARKDOWN_THEME_ID);
  };
  const handleChooseMarkdownThemeDirectory = async () => {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "Choose Typora Theme Folder",
      defaultPath:
        markdownThemeDirectory ?? resolvedMarkdownThemeDirectory ?? undefined,
    });
    if (typeof selected !== "string") return;
    setMarkdownThemeDirectoryDraft(selected);
    setMarkdownThemeDirectory(selected);
    resetMarkdownPreviewThemes();
    broadcastSettingsChanged();
  };
  const handleClearMarkdownThemeDirectory = () => {
    setMarkdownThemeDirectoryDraft("");
    setMarkdownThemeDirectory(null);
    resetMarkdownPreviewThemes();
    broadcastSettingsChanged();
  };
  const handleLoadTyporaThemesChange = (enabled: boolean) => {
    setMarkdownLoadTyporaThemes(enabled);
    broadcastSettingsChanged();
  };
  const commitMarkdownThemeDirectoryDraft = () => {
    const nextDirectory = markdownThemeDirectoryDraft.trim();
    const currentDirectory =
      markdownThemeDirectory ?? resolvedMarkdownThemeDirectory ?? "";
    if (nextDirectory === currentDirectory) return;
    setMarkdownThemeDirectory(nextDirectory || null);
    resetMarkdownPreviewThemes();
    broadcastSettingsChanged();
  };
  const handleSeparateMarkdownThemesChange = (enabled: boolean) => {
    setMarkdownSeparateLightDarkThemes(enabled);
    broadcastSettingsChanged();
  };
  const saveGlobalAgentPrompt = () => {
    if (globalPromptDraft === null) return;
    // Preserve unrelated settings saved in another window while editing.
    void useSettingsStore.persist.rehydrate();
    setGlobalAgentPrompt(globalPromptDraft);
    setGlobalPromptDraft(null);
    broadcastSettingsChanged();
  };
  const handleShortcutCapture = (
    actionId: KeyboardShortcutActionId,
    binding: string | null,
  ) => {
    if (binding !== null) {
      const validationError = validateKeyboardShortcut(binding);
      if (validationError) {
        setShortcutError(validationError);
        return;
      }
      const conflictingAction = KEYBOARD_SHORTCUT_ACTIONS.find(
        (action) =>
          action.id !== actionId &&
          resolveKeyboardShortcut(keyboardShortcutOverrides, action.id) ===
            binding,
      );
      if (conflictingAction) {
        setShortcutError(`Already used by ${conflictingAction.label}.`);
        return;
      }
    }

    setKeyboardShortcut(actionId, binding);
    setRecordingShortcut(null);
    setShortcutError(null);
    broadcastSettingsChanged();
  };
  const handleShortcutReset = (actionId: KeyboardShortcutActionId) => {
    resetKeyboardShortcut(actionId);
    if (recordingShortcut === actionId) setRecordingShortcut(null);
    setShortcutError(null);
    broadcastSettingsChanged();
  };
  const handleShortcutResetAll = () => {
    resetKeyboardShortcuts();
    setRecordingShortcut(null);
    setShortcutError(null);
    broadcastSettingsChanged();
  };
  const handleCatDisplayModeChange = (mode: CatDisplayMode) => {
    setCatDisplayMode(mode);
    broadcastSettingsChanged();
  };
  const handleCatStaticDisplayChange = (display: CatStaticDisplay) => {
    setCatStaticDisplay(display);
    broadcastSettingsChanged();
  };
  const handleCatCustomTextChange = (text: string) => {
    setCatCustomText(text);
    broadcastSettingsChanged();
  };
  const handleCatDisplayTimezoneChange = (timezone: CatDisplayTimezone) => {
    setCatDisplayTimezone(timezone);
    broadcastSettingsChanged();
  };
  const handleCatCountdownPrecisionChange = (
    precision: CatCountdownPrecision,
  ) => {
    setCatCountdownPrecision(precision);
    broadcastSettingsChanged();
  };
  const handleSearchMatchClick = (setting: SearchMatch) => {
    if (setting.id.startsWith("agent-claude-")) selectAgentProvider("claude");
    if (setting.id.startsWith("agent-codex-")) selectAgentProvider("codex");
    if (setting.id.startsWith("agent-pi-")) selectAgentProvider("pi");
    setActiveSection(setting.section);
    setPendingScrollRowId(setting.id);
  };

  return (
    <TooltipProvider>
      <div className="grid h-screen min-h-0 grid-cols-[200px_minmax(0,1fr)] bg-background text-foreground">
        <aside className="min-h-0">
          <div
            className="h-12 w-full"
            data-window-drag-region
            aria-hidden="true"
          />
          <div className="px-3 pb-3">
            <label className="flex h-8 w-full items-center gap-2 rounded-lg border border-border/70 bg-background px-2.5 text-muted-foreground transition-colors focus-within:border-ring">
              <SearchIcon className="size-3.5 shrink-0" />
              <input
                type="search"
                aria-label="Search settings"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder="Search settings"
                className="min-w-0 flex-1 bg-transparent text-foreground text-sm outline-none placeholder:text-muted-foreground"
              />
            </label>
          </div>
          <div className="pb-3">
            <nav className="space-y-1.5 px-3">
              {SECTIONS.map((section) => {
                const matches = searchMatchesBySection.get(section.id) ?? [];
                if (normalizedSearchQuery && matches.length === 0) {
                  return null;
                }
                return (
                  <SectionButton
                    key={section.id}
                    section={section}
                    active={activeSection === section.id}
                    searchQuery={normalizedSearchQuery}
                    matches={matches}
                    onClick={() => setActiveSection(section.id)}
                    onMatchClick={(id) => {
                      const setting = matches.find((match) => match.id === id);
                      if (setting) handleSearchMatchClick(setting);
                    }}
                  />
                );
              })}
            </nav>
          </div>
        </aside>

        <main className="flex min-h-0 flex-col pb-2">
          <div className="flex h-10 shrink-0 items-center gap-3 pr-2 pl-2">
            <h1 className="truncate font-semibold text-sm">Settings</h1>
            <div
              data-window-drag-region
              className="min-w-0 flex-1 self-stretch"
            />
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => {
                useOnboardingStore.setState({ completed: false, step: 0 });
                if (window.catalex) {
                  void window.catalex.invoke("rerun_setup");
                } else {
                  window.location.assign(window.location.pathname);
                }
              }}
            >
              Rerun setup
            </Button>
          </div>

          <div className="min-h-0 flex-1 pr-2">
            <div
              ref={contentScrollRef}
              className="app-scrollbar h-full min-h-0 overflow-auto rounded-panel border border-border/70 bg-muted/30"
            >
              <div className="mx-auto w-full max-w-4xl px-5 pt-1 pb-3">
                {activeSection === "appearance" && (
                  <section>
                    <div>
                      <SettingsGroup title="General">
                        <SettingsRow id="appearance-theme" title="Appearance">
                          <SettingsDropdown
                            ariaLabel="Appearance"
                            value={resolvedTheme}
                            options={THEME_OPTIONS}
                            onChange={(value) => setTheme(value)}
                          />
                        </SettingsRow>
                        <SettingsRow id="appearance-app-zoom" title="App Zoom">
                          <AppZoomControl />
                        </SettingsRow>
                        <SettingsRow id="appearance-solarize" title="Solarize">
                          <SolarizeDropdown
                            value={solarModeLevel}
                            onValueChange={handleSolarModeChange}
                          />
                        </SettingsRow>
                      </SettingsGroup>
                      <SettingsGroup title="Editor">
                        <SettingsRow
                          id="appearance-editor-spellcheck"
                          title="Spell Check"
                        >
                          <SettingsSwitch
                            checked={spellCheck}
                            label="Spell Check"
                            onCheckedChange={(enabled) => {
                              useSettingsStore
                                .getState()
                                .setSpellCheck(enabled);
                              broadcastSettingsChanged();
                            }}
                          />
                        </SettingsRow>
                        <SettingsRow
                          id="appearance-editor-spelling-language"
                          title="Spelling Language"
                        >
                          <SettingsDropdown
                            ariaLabel="Spelling language"
                            value={spellingLanguage}
                            options={SPELLING_LANGUAGES}
                            onChange={(value) => {
                              useSettingsStore
                                .getState()
                                .setSpellingLanguage(
                                  normalizeSpellingLanguage(value),
                                );
                              broadcastSettingsChanged();
                            }}
                          />
                        </SettingsRow>
                        <SettingsRow
                          id="appearance-editor-minimap"
                          title="Show Minimap"
                        >
                          <SettingsSwitch
                            checked={showEditorMinimap}
                            label="Show minimap"
                            onCheckedChange={(enabled) => {
                              setShowEditorMinimap(enabled);
                              broadcastSettingsChanged();
                            }}
                          />
                        </SettingsRow>
                        <SettingsRow
                          id="appearance-editor-color-scheme"
                          title="Editor Color Scheme"
                        >
                          <SettingsDropdown
                            value={editorColorScheme}
                            options={EDITOR_COLOR_SCHEME_OPTIONS}
                            onChange={handleEditorColorSchemeChange}
                          />
                        </SettingsRow>
                        <SettingsRow
                          id="appearance-editor-font-size"
                          title="Editor Font Size"
                        >
                          <EditorFontSizeDropdown
                            value={editorFontSize}
                            onValueChange={handleEditorFontSizeChange}
                          />
                        </SettingsRow>
                      </SettingsGroup>
                      <SettingsGroup title="Workspace Themes">
                        {WORKSPACE_MODES.map(({ id, label }) => (
                          <SettingsRow
                            key={id}
                            id={`appearance-mode-theme-${id}`}
                            title={`${label} Theme`}
                          >
                            <SettingsDropdown
                              ariaLabel={`${label} theme`}
                              value={modeThemes[id]}
                              options={UI_THEME_OPTIONS}
                              onChange={(value) => {
                                setModeTheme(id, value);
                                broadcastSettingsChanged();
                              }}
                            />
                          </SettingsRow>
                        ))}
                      </SettingsGroup>
                      <SettingsGroup title="Tooltips">
                        <SettingsRow
                          id="appearance-show-tooltips"
                          title="Show Tooltips"
                        >
                          <SettingsSwitch
                            checked={showTooltips}
                            label="Show tooltips"
                            onCheckedChange={(enabled) => {
                              setShowTooltips(enabled);
                              broadcastSettingsChanged();
                            }}
                          />
                        </SettingsRow>
                        <SettingsRow
                          id="appearance-tooltip-delay"
                          title="Hover Delay"
                        >
                          <div className="flex items-center gap-3">
                            <span className="text-muted-foreground text-xs">
                              {tooltipHoverDelay ? "400 ms" : "Immediate"}
                            </span>
                            <SettingsSwitch
                              checked={tooltipHoverDelay}
                              label="Tooltip hover delay"
                              onCheckedChange={(enabled) => {
                                setTooltipHoverDelay(enabled);
                                broadcastSettingsChanged();
                              }}
                            />
                          </div>
                        </SettingsRow>
                      </SettingsGroup>
                    </div>
                  </section>
                )}

                {activeSection === "cat" && (
                  <section>
                    <div>
                      <SettingsRow id="cat-display" title="Display">
                        <SettingsDropdown
                          value={catDisplayMode}
                          options={CAT_MODE_OPTIONS}
                          onChange={handleCatDisplayModeChange}
                        />
                      </SettingsRow>
                      {catDisplayMode === "ccfddl" ? (
                        <>
                          <SettingsRow
                            id="cat-conference-deadline"
                            title="Conference Deadline"
                          >
                            <ConferenceDeadlinePicker
                              onChange={broadcastSettingsChanged}
                            />
                          </SettingsRow>
                          <SettingsRow id="cat-time-zone" title="Time Zone">
                            <div className="ml-auto flex min-w-0 flex-col items-end gap-1">
                              <SettingsDropdown
                                value={catDisplayTimezone}
                                options={CAT_TIMEZONE_OPTIONS}
                                onChange={handleCatDisplayTimezoneChange}
                              />
                              <span className="max-w-sm truncate text-muted-foreground text-xs">
                                {formatDeadlinePreview(
                                  catSelectedCcfddlDeadline,
                                  catDisplayTimezone,
                                )}
                              </span>
                            </div>
                          </SettingsRow>
                          <SettingsRow id="cat-countdown" title="Countdown">
                            <SettingsDropdown
                              value={catCountdownPrecision}
                              options={CAT_COUNTDOWN_OPTIONS}
                              onChange={handleCatCountdownPrecisionChange}
                            />
                          </SettingsRow>
                        </>
                      ) : (
                        <>
                          <SettingsRow id="cat-static-text" title="Static Text">
                            <SettingsDropdown
                              value={catStaticDisplay}
                              options={CAT_STATIC_OPTIONS}
                              onChange={handleCatStaticDisplayChange}
                            />
                          </SettingsRow>
                          {catStaticDisplay === "custom" ? (
                            <SettingsRow
                              id="cat-custom-text"
                              title="Custom Text"
                            >
                              <Input
                                aria-label="Custom cat text"
                                className="ml-auto h-8 max-w-xs bg-background text-sm"
                                maxLength={28}
                                onChange={(event) =>
                                  handleCatCustomTextChange(event.target.value)
                                }
                                value={catCustomText}
                              />
                            </SettingsRow>
                          ) : null}
                        </>
                      )}
                      <SettingsRow id="cat-preview" title="Preview">
                        <span className="ml-auto truncate">{catPreview}</span>
                      </SettingsRow>
                    </div>
                  </section>
                )}

                {activeSection === "agent" && (
                  <section>
                    <div>
                      <section
                        aria-label="Agent configuration"
                        data-settings-row-id="agent-provider-tabs"
                      >
                        <SettingsGroup title="Agent Configuration">
                          <div className="flex justify-start pt-3 pb-4">
                            <ButtonGroup
                              role="tablist"
                              aria-label="Agent provider"
                              className="flex h-8 w-fit min-w-64 items-center"
                            >
                              {(["codex", "claude", "pi"] as const).map(
                                (provider) => (
                                  <button
                                    key={provider}
                                    type="button"
                                    role="tab"
                                    id={`agent-tab-${provider}`}
                                    aria-controls="agent-provider-panel"
                                    aria-selected={agentProvider === provider}
                                    tabIndex={
                                      agentProvider === provider ? 0 : -1
                                    }
                                    className={cn(
                                      "flex h-6 flex-1 items-center justify-center whitespace-nowrap rounded-md px-2 font-medium text-xs transition-colors focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-ring",
                                      agentProvider === provider
                                        ? "bg-background text-foreground shadow-sm"
                                        : "text-muted-foreground hover:bg-background/70 hover:text-foreground",
                                    )}
                                    onClick={() =>
                                      selectAgentProvider(provider)
                                    }
                                    onKeyDown={(event) => {
                                      if (
                                        ![
                                          "ArrowLeft",
                                          "ArrowRight",
                                          "Home",
                                          "End",
                                        ].includes(event.key)
                                      )
                                        return;
                                      event.preventDefault();
                                      const providers = [
                                        "codex",
                                        "claude",
                                        "pi",
                                      ] as const;
                                      const next =
                                        event.key === "Home"
                                          ? providers[0]
                                          : event.key === "End"
                                            ? providers[2]
                                            : providers[
                                                (providers.indexOf(provider) +
                                                  (event.key === "ArrowLeft"
                                                    ? 2
                                                    : 1)) %
                                                  providers.length
                                              ];
                                      selectAgentProvider(next);
                                      document
                                        .getElementById(`agent-tab-${next}`)
                                        ?.focus();
                                    }}
                                  >
                                    <span>
                                      {getOptionLabel(AGENT_OPTIONS, provider)}
                                    </span>
                                    <span
                                      aria-hidden={enabledProviders[provider]}
                                      className={cn(
                                        "inline-flex shrink-0 overflow-hidden transition-[width,opacity] duration-[180ms] ease-out motion-reduce:transition-none",
                                        enabledProviders[provider]
                                          ? "w-0 opacity-0"
                                          : "w-7 opacity-100",
                                      )}
                                    >
                                      <span className="ml-1.5 shrink-0 rounded bg-muted px-1 py-0.5 font-medium text-[9px] text-muted-foreground leading-none">
                                        Off
                                      </span>
                                    </span>
                                  </button>
                                ),
                              )}
                            </ButtonGroup>
                          </div>
                          <div
                            role="tabpanel"
                            id="agent-provider-panel"
                            aria-labelledby={`agent-tab-${agentProvider}`}
                          >
                            <ProviderToggle provider={agentProvider} />
                            <div
                              hidden={!enabledProviders[agentProvider]}
                              className="border-border/45 border-t"
                            >
                              <SettingsRow
                                id="agent-default-agent"
                                title={`Use ${getOptionLabel(AGENT_OPTIONS, agentProvider)} by default`}
                              >
                                <SettingsSwitch
                                  label={`Use ${getOptionLabel(AGENT_OPTIONS, agentProvider)} by default`}
                                  checked={defaultAgent === agentProvider}
                                  onCheckedChange={(checked) => {
                                    setDefaultAgent(
                                      checked
                                        ? agentProvider
                                        : ((
                                            ["codex", "claude", "pi"] as const
                                          ).find(
                                            (provider) =>
                                              provider !== agentProvider &&
                                              enabledProviders[provider],
                                          ) ?? agentProvider),
                                    );
                                    broadcastSettingsChanged();
                                  }}
                                />
                              </SettingsRow>
                              {agentProvider === "claude" && (
                                <>
                                  <SettingsRow
                                    id="agent-claude-model"
                                    title="Default model"
                                  >
                                    <SettingsDropdown
                                      value={defaultClaudeModel}
                                      options={claudeModelOptions}
                                      disabled={
                                        discoveredClaudeModels.length === 0
                                      }
                                      onChange={setDefaultClaudeModel}
                                    />
                                  </SettingsRow>
                                  {claudeModelsStatus !== "ready" && (
                                    <div
                                      className="px-4 pb-3 text-muted-foreground text-xs"
                                      role={
                                        claudeModelsStatus === "error"
                                          ? "alert"
                                          : "status"
                                      }
                                    >
                                      {claudeModelsStatus === "error"
                                        ? claudeModelsError
                                        : "Loading Claude models…"}
                                      {claudeModelsStatus === "error" && (
                                        <button
                                          type="button"
                                          className="ml-2 underline"
                                          onClick={() =>
                                            void refreshClaudeModels()
                                          }
                                        >
                                          Retry
                                        </button>
                                      )}
                                    </div>
                                  )}
                                  {claudeEffortOptions.length > 0 && (
                                    <SettingsRow
                                      id="agent-claude-effort"
                                      title="Effort"
                                    >
                                      <SettingsDropdown
                                        value={defaultClaudeEffortLevel}
                                        options={claudeEffortOptions}
                                        disabled={
                                          discoveredClaudeModels.length === 0
                                        }
                                        onChange={setDefaultClaudeEffortLevel}
                                      />
                                    </SettingsRow>
                                  )}
                                </>
                              )}
                              {agentProvider === "codex" && (
                                <>
                                  <SettingsRow
                                    id="agent-codex-model"
                                    title="Default model"
                                  >
                                    <SettingsDropdown
                                      value={defaultCodexModel}
                                      options={codexModelOptions}
                                      onChange={setDefaultCodexModel}
                                    />
                                  </SettingsRow>
                                  <SettingsRow
                                    id="agent-codex-reasoning"
                                    title="Reasoning"
                                  >
                                    <SettingsDropdown
                                      value={defaultCodexReasoningEffort}
                                      options={codexReasoningOptions}
                                      onChange={setDefaultCodexReasoningEffort}
                                    />
                                  </SettingsRow>
                                </>
                              )}
                              {agentProvider === "pi" && (
                                <>
                                  {piPathSettings.map((field) => (
                                    <SettingsRow
                                      key={field.id}
                                      id={field.id}
                                      title={field.title}
                                    >
                                      <SettingsDropdown {...field.dropdown} />
                                    </SettingsRow>
                                  ))}
                                  <SettingsRow title="Verification">
                                    <div className="flex items-center gap-2 text-muted-foreground text-xs">
                                      <span
                                        role="status"
                                        aria-label="Pi verification"
                                        className="inline-flex items-center gap-1.5"
                                      >
                                        {pi.status === "ready" && (
                                          <CheckIcon className="size-3.5 text-green-600 dark:text-green-400" />
                                        )}
                                        {pi.status === "checking"
                                          ? "Verifying…"
                                          : pi.status === "ready" && pi.version
                                            ? `Verified · v${pi.version}`
                                            : "Not verified"}
                                      </span>
                                      <Button
                                        variant="ghost"
                                        size="icon"
                                        className="mr-1.25 size-6 rounded-full"
                                        aria-label="Refresh Pi verification"
                                        title="Refresh verification"
                                        disabled={
                                          pi.status === "checking" ||
                                          pi.modelsStatus === "loading" ||
                                          piBinaryPaths?.length === 0 ||
                                          piConfigDirectories?.length === 0
                                        }
                                        onClick={() => void pi.checkStatus()}
                                      >
                                        <RefreshCwIcon
                                          className={
                                            pi.status === "checking"
                                              ? "size-3 animate-spin"
                                              : "size-3"
                                          }
                                        />
                                      </Button>
                                    </div>
                                  </SettingsRow>
                                  {(pi.error || pi.modelsError) && (
                                    <p
                                      role="alert"
                                      className="px-4 pb-3 text-destructive text-xs"
                                    >
                                      {pi.error ?? pi.modelsError}
                                    </p>
                                  )}
                                  <SettingsRow
                                    id="agent-pi-model"
                                    title="Default model"
                                  >
                                    <SettingsDropdown
                                      value={defaultPiModel}
                                      options={piModelOptions}
                                      onChange={setDefaultPiModel}
                                      disabled={pi.modelsStatus !== "ready"}
                                    />
                                  </SettingsRow>
                                  {piEffortOptions.length > 0 && (
                                    <SettingsRow
                                      id="agent-pi-reasoning"
                                      title="Reasoning"
                                    >
                                      <SettingsDropdown
                                        value={
                                          piEffort ?? defaultPiReasoningEffort
                                        }
                                        options={piEffortOptions.map(
                                          (value) => ({
                                            value,
                                            label: codexEffortLabel(value),
                                          }),
                                        )}
                                        onChange={setDefaultPiReasoningEffort}
                                      />
                                    </SettingsRow>
                                  )}
                                </>
                              )}
                              {agentProvider !== "pi" && (
                                <div
                                  data-settings-row-id="agent-custom-models"
                                  className="grid grid-cols-[minmax(6rem,0.36fr)_minmax(0,1fr)] gap-x-4 border-border/45 border-t"
                                >
                                  <div className="pt-3 text-muted-foreground text-sm">
                                    Legacy models
                                  </div>
                                  <CustomModelSettings
                                    key={agentProvider}
                                    provider={agentProvider}
                                  />
                                </div>
                              )}
                            </div>
                          </div>
                        </SettingsGroup>
                      </section>
                      {!enabledProviders.claude &&
                      !enabledProviders.codex &&
                      !enabledProviders.pi ? (
                        <p
                          role="status"
                          className="border-border/45 border-t py-6 text-muted-foreground text-sm"
                        >
                          No agent is enabled.
                        </p>
                      ) : (
                        <>
                          <SettingsGroup title="Approval mode">
                            <SettingsRow
                              id="agent-default-mode"
                              title="Default"
                            >
                              <SettingsDropdown
                                value={defaultAgentExecutionMode}
                                options={AGENT_MODE_OPTIONS}
                                onChange={setDefaultAgentExecutionMode}
                              />
                            </SettingsRow>
                          </SettingsGroup>
                          <SettingsGroup
                            title="Global Instructions"
                            titleAction={
                              <div className="flex flex-1 items-center gap-1.5 pl-1.5">
                                <Hint content="Applied when a new chat starts.">
                                  <Button
                                    variant="ghost"
                                    size="icon-xs"
                                    className="size-5 rounded-full text-muted-foreground"
                                    aria-label="About global instructions"
                                  >
                                    <CircleHelpIcon className="size-3.5" />
                                  </Button>
                                </Hint>
                                <div className="ml-auto flex items-center gap-2">
                                  {globalPromptDraft !== null ? (
                                    <>
                                      <Button
                                        size="sm"
                                        variant="ghost"
                                        className="h-7 text-xs"
                                        onClick={() =>
                                          setGlobalPromptDraft(DEFAULT_AGENT_MD)
                                        }
                                      >
                                        Reset
                                      </Button>
                                      <Button
                                        size="sm"
                                        className="h-7 text-xs"
                                        aria-label="Save global instructions"
                                        onClick={saveGlobalAgentPrompt}
                                      >
                                        Save
                                      </Button>
                                    </>
                                  ) : (
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      className="h-7 text-xs"
                                      aria-label="Edit global instructions"
                                      onClick={() => {
                                        setGlobalPromptDraft(globalAgentPrompt);
                                        globalPromptInput.current?.focus();
                                      }}
                                    >
                                      Edit
                                    </Button>
                                  )}
                                </div>
                              </div>
                            }
                          >
                            <div
                              data-settings-row-id="agent-global-instructions"
                              className="scroll-mt-4 pt-2"
                            >
                              <Textarea
                                ref={globalPromptInput}
                                aria-label="Global agent instructions"
                                className={cn(
                                  "max-h-96 min-h-36 resize-y font-mono text-xs shadow-none",
                                  globalPromptDraft === null
                                    ? "border-border/45 bg-transparent focus-visible:border-border/45 focus-visible:ring-0 dark:bg-transparent"
                                    : "bg-background focus:border-foreground focus-visible:border-foreground",
                                )}
                                readOnly={globalPromptDraft === null}
                                value={globalPromptDraft ?? globalAgentPrompt}
                                onChange={(event) => {
                                  if (globalPromptDraft !== null)
                                    setGlobalPromptDraft(event.target.value);
                                }}
                              />
                            </div>
                          </SettingsGroup>
                        </>
                      )}
                      <PromptLibrarySettings />
                    </div>
                  </section>
                )}

                {activeSection === "keyboard" && (
                  <section>
                    <div className="flex items-start justify-between gap-4 border-border/45 border-b py-3">
                      <div>
                        <h2 className="font-semibold text-sm">
                          Keyboard Shortcuts
                        </h2>
                        <p className="mt-0.5 max-w-xl text-muted-foreground text-xs">
                          Select a shortcut, then press a new key combination.
                          Press Escape to cancel or Backspace to unassign it.
                        </p>
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-7 shrink-0 gap-1.5 rounded-lg px-2 text-xs"
                        disabled={
                          Object.keys(keyboardShortcutOverrides).length === 0
                        }
                        onClick={handleShortcutResetAll}
                      >
                        <RotateCcwIcon className="size-3" />
                        Reset All
                      </Button>
                    </div>
                    {KEYBOARD_SHORTCUT_GROUPS.map((group) => (
                      <SettingsGroup key={group} title={group}>
                        {KEYBOARD_SHORTCUT_ACTIONS.filter(
                          (action) => action.group === group,
                        ).map((action) => {
                          const isCustomized =
                            Object.prototype.hasOwnProperty.call(
                              keyboardShortcutOverrides,
                              action.id,
                            );
                          return (
                            <SettingsRow
                              id={`keyboard-${action.id}`}
                              key={action.id}
                              title={action.label}
                              titleAction={
                                isCustomized ? (
                                  <Hint
                                    content={`Reset to ${formatKeyboardShortcut(action.defaultBinding)}`}
                                  >
                                    <Button
                                      type="button"
                                      variant="ghost"
                                      size="icon"
                                      className="size-7 rounded-lg text-muted-foreground"
                                      aria-label={`Reset ${action.label} shortcut`}
                                      onClick={() =>
                                        handleShortcutReset(action.id)
                                      }
                                    >
                                      <RotateCcwIcon className="size-3.5" />
                                    </Button>
                                  </Hint>
                                ) : undefined
                              }
                            >
                              <ShortcutRecorder
                                actionId={action.id}
                                binding={resolveKeyboardShortcut(
                                  keyboardShortcutOverrides,
                                  action.id,
                                )}
                                error={
                                  recordingShortcut === action.id
                                    ? shortcutError
                                    : null
                                }
                                isRecording={recordingShortcut === action.id}
                                label={action.label}
                                onCancel={() => {
                                  setRecordingShortcut(null);
                                  setShortcutError(null);
                                }}
                                onCapture={handleShortcutCapture}
                                onStart={(actionId) => {
                                  setRecordingShortcut(actionId);
                                  setShortcutError(null);
                                }}
                              />
                            </SettingsRow>
                          );
                        })}
                      </SettingsGroup>
                    ))}
                  </section>
                )}

                {activeSection === "rendering" && (
                  <section>
                    <div>
                      <SettingsGroup title="LaTeX defaults">
                        <SettingsRow
                          id="auto-compile"
                          title="Auto compile for new projects"
                        >
                          <SettingsSwitch
                            checked={defaultAutoCompile}
                            label="Auto compile for new projects"
                            onCheckedChange={setDefaultAutoCompile}
                          />
                        </SettingsRow>
                        <SettingsRow id="compiler-backend" title="Backend">
                          <SettingsDropdown
                            value={compilerBackend}
                            options={COMPILER_OPTIONS}
                            onChange={setCompilerBackend}
                          />
                        </SettingsRow>
                        <LatexInstallationControl />
                        <SettingsRow id="compiler-engine" title="Engine">
                          <SettingsDropdown
                            value={compilerEngine}
                            options={COMPILER_ENGINE_OPTIONS}
                            onChange={setCompilerEngine}
                          />
                        </SettingsRow>
                      </SettingsGroup>
                      <SettingsGroup title="Markdown">
                        <SettingsRow
                          id="rendering-markdown-load-typora-themes"
                          title="Load Typora Themes"
                        >
                          <SettingsSwitch
                            checked={markdownLoadTyporaThemes}
                            label="Load Typora themes"
                            onCheckedChange={handleLoadTyporaThemesChange}
                          />
                        </SettingsRow>
                        {markdownLoadTyporaThemes ? (
                          <SettingsRow
                            id="rendering-markdown-theme-folder"
                            title="Typora Theme Folder"
                            titleAction={
                              <Hint content="Reset to the default Typora theme folder">
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon"
                                  className="size-7 rounded-lg text-muted-foreground"
                                  aria-label="Reset Typora theme folder"
                                  disabled={!markdownThemeDirectory}
                                  onClick={handleClearMarkdownThemeDirectory}
                                >
                                  <RotateCcwIcon className="size-3.5" />
                                </Button>
                              </Hint>
                            }
                            contentClassName="justify-stretch"
                          >
                            <div className="relative ml-auto w-full max-w-md">
                              <Hint
                                content={
                                  markdownThemeDirectoryDraft || undefined
                                }
                              >
                                <Input
                                  ref={markdownThemeDirectoryInputRef}
                                  aria-label="Typora theme folder"
                                  aria-invalid={
                                    markdownThemeFolderStatus === "error"
                                  }
                                  className="h-8 rounded-lg bg-background pr-9 font-mono text-xs"
                                  placeholder={
                                    markdownThemeFolderStatus === "loading"
                                      ? "Finding Typora theme folder…"
                                      : markdownThemeFolderStatus === "error"
                                        ? "Folder unavailable"
                                        : ""
                                  }
                                  value={markdownThemeDirectoryDraft}
                                  onBlur={commitMarkdownThemeDirectoryDraft}
                                  onChange={(event) =>
                                    setMarkdownThemeDirectoryDraft(
                                      event.target.value,
                                    )
                                  }
                                  onKeyDown={(event) => {
                                    if (event.key === "Enter") {
                                      event.currentTarget.blur();
                                    }
                                    if (event.key === "Escape") {
                                      setMarkdownThemeDirectoryDraft(
                                        markdownThemeDirectory ??
                                          resolvedMarkdownThemeDirectory ??
                                          "",
                                      );
                                      event.currentTarget.blur();
                                    }
                                  }}
                                />
                              </Hint>
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                className="absolute top-1 right-1 size-6 rounded-md text-muted-foreground"
                                aria-label="Choose Typora theme folder"
                                onClick={() =>
                                  void handleChooseMarkdownThemeDirectory()
                                }
                              >
                                <FolderOpenIcon className="size-3.5" />
                              </Button>
                            </div>
                          </SettingsRow>
                        ) : null}
                        <SettingsRow
                          id="rendering-markdown-separate-themes"
                          title="Separate Light and Dark Themes"
                        >
                          <SettingsSwitch
                            checked={markdownSeparateLightDarkThemes}
                            label="Separate light and dark Markdown themes"
                            onCheckedChange={handleSeparateMarkdownThemesChange}
                          />
                        </SettingsRow>
                        {markdownSeparateLightDarkThemes ? (
                          <>
                            <SettingsRow
                              id="rendering-markdown-light-theme"
                              title="Light Theme"
                            >
                              <SettingsDropdown
                                value={effectiveMarkdownPreviewLightTheme}
                                options={markdownThemeOptions}
                                onChange={(value) => {
                                  setMarkdownPreviewLightTheme(value);
                                  broadcastSettingsChanged();
                                }}
                              />
                            </SettingsRow>
                            <SettingsRow
                              id="rendering-markdown-dark-theme"
                              title="Dark Theme"
                            >
                              <SettingsDropdown
                                value={effectiveMarkdownPreviewDarkTheme}
                                options={markdownThemeOptions}
                                onChange={(value) => {
                                  setMarkdownPreviewDarkTheme(value);
                                  broadcastSettingsChanged();
                                }}
                              />
                            </SettingsRow>
                          </>
                        ) : (
                          <SettingsRow
                            id="rendering-markdown-theme"
                            title="Theme"
                          >
                            <SettingsDropdown
                              value={effectiveMarkdownPreviewTheme}
                              options={markdownThemeOptions}
                              onChange={(value) => {
                                setMarkdownPreviewTheme(value);
                                broadcastSettingsChanged();
                              }}
                            />
                          </SettingsRow>
                        )}
                      </SettingsGroup>
                    </div>
                  </section>
                )}

                {activeSection === "storage" && <StorageSettings />}
                {activeSection === "about" && (
                  <section className="space-y-4">
                    <div>
                      <SettingsRow id="about-version" title="Version">
                        <span>{version || "Unknown"}</span>
                      </SettingsRow>
                      <SettingsRow
                        id="about-update-channel"
                        title="Update Channel"
                      >
                        <span>GitHub Releases</span>
                      </SettingsRow>
                    </div>
                    <div
                      data-settings-row-id="about-updates"
                      className="scroll-mt-4"
                    >
                      <SettingsGroup
                        title="Updates"
                        titleAction={
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-xs"
                            aria-label="Check for updates"
                            aria-busy={checkingUpdate}
                            disabled={
                              checkingUpdate ||
                              updateStatus.state === "downloading" ||
                              updateStatus.state === "installing" ||
                              updateStatus.state === "ready"
                            }
                            onClick={() => void checkForUpdate()}
                          >
                            <RefreshCwIcon
                              className={cn(
                                "size-3.5",
                                checkingUpdate && "animate-spin",
                              )}
                            />
                          </Button>
                        }
                      >
                        <div className="py-3">
                          <div className="flex flex-wrap items-center justify-between gap-3">
                            <div
                              role="status"
                              className="min-w-0 break-words text-sm"
                            >
                              {updateStatus.state === "available"
                                ? `${updateStatus.version} available`
                                : updateStatus.state === "skipped"
                                  ? `Skipped ${updateStatus.version}`
                                  : updateStatus.state === "up-to-date"
                                    ? "Catalex is up to date."
                                    : updateStatus.state === "error" ||
                                        updateStatus.state === "unavailable"
                                      ? updateStatus.message
                                      : updateStatus.state === "downloading"
                                        ? `Downloading… ${updateStatus.percent}%`
                                        : updateStatus.state === "installing"
                                          ? "Installing…"
                                          : updateStatus.state === "ready"
                                            ? "Restarting…"
                                            : "Checking for updates…"}
                            </div>
                            {updateStatus.state === "skipped" && (
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="h-7 gap-1.5 px-2 font-normal text-xs"
                                onClick={() => void openRelease()}
                              >
                                <ExternalLinkIcon className="size-3.5" />
                                View release
                              </Button>
                            )}
                            {updateStatus.state === "available" && (
                              <div className="flex shrink-0 items-center gap-2">
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  className="h-7 px-2 font-normal text-xs"
                                  onClick={skipUpdate}
                                >
                                  Skip this version
                                </Button>
                                <Button
                                  type="button"
                                  size="sm"
                                  className="h-7 gap-2 bg-[#d96b17] px-2 text-white text-xs hover:bg-[#c55d10]"
                                  onClick={() => void installUpdate()}
                                >
                                  <CircleArrowUpIcon className="size-4" />
                                  Install update
                                </Button>
                              </div>
                            )}
                          </div>
                        </div>
                      </SettingsGroup>
                    </div>
                  </section>
                )}
              </div>
            </div>
          </div>
        </main>
      </div>
    </TooltipProvider>
  );
}
