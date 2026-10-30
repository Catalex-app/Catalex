import { HARNESSES } from "@/lib/agent-harness";
import { PRODUCT_NAME } from "../../../branding";
import { isComposingKey, consumeKey } from "@/lib/keyboard-events";
import { usePopupExit } from "@/components/ui/use-popup-exit";
import { ButtonGroup } from "@/components/ui/button-group";
import {
  type FC,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { invoke } from "@/lib/desktop/core";
import {
  CommandIcon,
  GlobeIcon,
  TerminalIcon,
  FileCodeIcon,
  ZapIcon,
  XIcon,
  SearchIcon,
  FlaskConicalIcon,
  ChevronRightIcon,
  ChevronLeftIcon,
  LeafIcon,
  PackageIcon,
  PlugIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useSettingsStore } from "@/stores/settings-store";
import type { ChatProvider } from "@/stores/agent-chat-store";

export interface SlashCommand {
  id: string;
  name: string;
  full_command: string;
  scope: string;
  skill_scope?: string;
  namespace: string | null;
  file_path: string;
  content: string;
  description: string | null;
  allowed_tools: string[];
  has_bash_commands: boolean;
  has_file_references: boolean;
  accepts_arguments: boolean;
}

interface SlashCommandPickerProps {
  projectPath: string | null;
  provider: ChatProvider;
  query: string;
  anchorRef: RefObject<HTMLDivElement | null>;
  onSelect: (command: SlashCommand) => void;
  onClose: () => void;
}

const compactCommand: SlashCommand = {
  id: "native-compact",
  name: "compact",
  full_command: "/compact",
  scope: "native",
  namespace: null,
  file_path: "",
  content: "",
  description: "Compact context; optional text is sent afterward.",
  allowed_tools: [],
  has_bash_commands: false,
  has_file_references: false,
  accepts_arguments: true,
};

type Tab =
  | "all"
  | "catalex"
  | "command"
  | "local-skills"
  | "global-skills"
  | "plugin-skills"
  | "built-in-skills";

function normalizePath(path: string | null | undefined): string {
  return (path ?? "").replace(/\\/g, "/");
}

function isWithinPath(path: string, root: string | null): boolean {
  if (!root) return false;
  const normalizedPath = normalizePath(path);
  const normalizedRoot = normalizePath(root).replace(/\/+$/, "");
  return (
    normalizedPath === normalizedRoot ||
    normalizedPath.startsWith(`${normalizedRoot}/`)
  );
}

function isBuiltInCodexSkill(path: string): boolean {
  const normalized = normalizePath(path);
  return (
    normalized.includes("/.codex/plugins/") ||
    normalized.includes("/.codex/skills/.system/") ||
    normalized.includes("/.codex/skills/codex-primary-runtime/")
  );
}

function isCatalexSkill(path: string): boolean {
  return normalizePath(path).startsWith("catalex://built-in-skills/");
}

export function commandSyntaxForProvider(
  command: Pick<SlashCommand, "full_command" | "scope">,
  provider: ChatProvider,
): string {
  if (provider === "pi" && command.scope === "skill")
    return `/skill:${command.full_command.replace(/^\/+/, "")}`;
  if (provider === "codex" && command.scope === "skill") {
    return `$${command.full_command.replace(/^\/+/, "")}`;
  }
  return command.full_command;
}

function isPluginSkill(path: string, provider: ChatProvider): boolean {
  const normalized = normalizePath(path);
  return provider === "claude" && normalized.includes("/.claude/plugins/");
}

function isGlobalSkill(path: string, provider: ChatProvider): boolean {
  const normalized = normalizePath(path);
  return provider === "pi"
    ? normalized.includes("/.pi/agent/skills/")
    : provider === "codex"
      ? normalized.includes("/.codex/skills/")
      : normalized.includes("/.claude/skills/");
}

function commandTabForScope(
  command: SlashCommand,
  provider: ChatProvider,
  projectPath: string | null,
): Tab {
  if (command.scope === "default" || command.scope === "native")
    return "catalex";
  if (command.scope === "project" || command.scope === "user") return "command";
  if (command.scope !== "skill") return "all";

  const normalizedFilePath = normalizePath(command.file_path);
  const localSkillsRoot = projectPath
    ? normalizePath(
        `${projectPath}/${provider === "pi" ? ".pi" : provider === "codex" ? ".codex" : ".claude"}/skills`,
      )
    : null;

  if (isWithinPath(normalizedFilePath, localSkillsRoot)) return "local-skills";
  if (isPluginSkill(normalizedFilePath, provider)) return "plugin-skills";
  if (isCatalexSkill(normalizedFilePath)) {
    return "catalex";
  }
  if (provider === "pi") {
    return command.skill_scope === "project" ? "local-skills" : "global-skills";
  }
  if (provider === "codex" && isBuiltInCodexSkill(normalizedFilePath)) {
    return "built-in-skills";
  }
  if (isGlobalSkill(normalizedFilePath, provider)) return "global-skills";
  return "built-in-skills";
}

function availableTabsForProvider(provider: ChatProvider): Tab[] {
  return provider === "pi"
    ? ["all", "catalex", "global-skills", "local-skills"]
    : provider === "codex"
      ? ["all", "catalex", "global-skills", "local-skills", "built-in-skills"]
      : [
          "all",
          "catalex",
          "command",
          "global-skills",
          "local-skills",
          "plugin-skills",
        ];
}

function tabLabel(tab: Tab): string {
  switch (tab) {
    case "all":
      return "All";
    case "catalex":
      return PRODUCT_NAME;
    case "command":
      return "Command";
    case "global-skills":
      return "Global Skills";
    case "local-skills":
      return "Local Skills";
    case "plugin-skills":
      return "Plugin Skills";
    case "built-in-skills":
      return "Built in Skills";
  }
}

function tabIcon(tab: Tab) {
  switch (tab) {
    case "all":
      return <ZapIcon className="size-3.5 shrink-0" />;
    case "catalex":
      return <LeafIcon className="size-3.5 shrink-0" />;
    case "command":
      return <CommandIcon className="size-3.5 shrink-0" />;
    case "global-skills":
      return <GlobeIcon className="size-3.5 shrink-0" />;
    case "local-skills":
      return <FlaskConicalIcon className="size-3.5 shrink-0" />;
    case "plugin-skills":
      return <PlugIcon className="size-3.5 shrink-0" />;
    case "built-in-skills":
      return <PackageIcon className="size-3.5 shrink-0" />;
  }
}

function getCommandIcon(
  command: SlashCommand,
  provider: ChatProvider,
  projectPath: string | null,
) {
  const classifiedTab = commandTabForScope(command, provider, projectPath);

  if (classifiedTab === "catalex")
    return <LeafIcon className="size-3.5 shrink-0 text-muted-foreground" />;
  if (classifiedTab === "command")
    return <CommandIcon className="size-3.5 shrink-0 text-muted-foreground" />;
  if (classifiedTab === "global-skills")
    return <GlobeIcon className="size-3.5 shrink-0 text-muted-foreground" />;
  if (classifiedTab === "local-skills")
    return (
      <FlaskConicalIcon className="size-3.5 shrink-0 text-muted-foreground" />
    );
  if (classifiedTab === "plugin-skills")
    return <PlugIcon className="size-3.5 shrink-0 text-muted-foreground" />;
  if (classifiedTab === "built-in-skills")
    return <PackageIcon className="size-3.5 shrink-0 text-muted-foreground" />;

  if (command.has_bash_commands)
    return <TerminalIcon className="size-3.5 shrink-0 text-muted-foreground" />;
  if (command.has_file_references)
    return <FileCodeIcon className="size-3.5 shrink-0 text-muted-foreground" />;
  return <ZapIcon className="size-3.5 shrink-0 text-muted-foreground" />;
}

// ─── Fuzzy matching (fzf/fzy-inspired) ───

const SCORE_GAP_LEADING = -0.005;
const SCORE_GAP_TRAILING = -0.005;
const SCORE_GAP_INNER = -0.01;
const SCORE_MATCH_CONSECUTIVE = 1.0;
const SCORE_MATCH_SLASH = 0.9;
const SCORE_MATCH_WORD = 0.8;
const SCORE_MATCH_CAPITAL = 0.7;
const SCORE_MATCH_DOT = 0.6;
const SCORE_MAX_LEADING_GAP = -0.05;

function _isWordBoundary(prev: string, curr: string): boolean {
  return (
    prev === "-" ||
    prev === "_" ||
    prev === " " ||
    prev === "/" ||
    prev === "." ||
    (prev === prev.toLowerCase() && curr === curr.toUpperCase())
  );
}

function bonusFor(prev: string, curr: string): number {
  if (prev === "/") return SCORE_MATCH_SLASH;
  if (prev === "-" || prev === "_" || prev === " ") return SCORE_MATCH_WORD;
  if (prev === ".") return SCORE_MATCH_DOT;
  if (prev === prev.toLowerCase() && curr === curr.toUpperCase())
    return SCORE_MATCH_CAPITAL;
  return 0;
}

/** Score query against candidate. Returns -Infinity if no match. */
function fuzzyScore(query: string, candidate: string): number {
  const n = query.length;
  const m = candidate.length;

  if (n === 0) return 0;
  if (n > m) return -Infinity;

  const qLower = query.toLowerCase();
  const cLower = candidate.toLowerCase();

  // Quick check: all query chars exist in candidate in order
  let qi = 0;
  for (let ci = 0; ci < m && qi < n; ci++) {
    if (qLower[qi] === cLower[ci]) qi++;
  }
  if (qi < n) return -Infinity;

  // Score matrix (simplified fzy)
  // D[i][j] = best score ending with query[i] matching candidate[j] consecutively
  // M[i][j] = best score for query[0..i] matching within candidate[0..j]
  const D: number[][] = [];
  const M: number[][] = [];
  for (let i = 0; i < n; i++) {
    D.push(new Array(m).fill(-Infinity));
    M.push(new Array(m).fill(-Infinity));
  }

  for (let i = 0; i < n; i++) {
    let prevScore = -Infinity;
    const gapScore = i === n - 1 ? SCORE_GAP_TRAILING : SCORE_GAP_INNER;

    for (let j = 0; j < m; j++) {
      if (qLower[i] === cLower[j]) {
        let score = 0;

        if (i === 0) {
          // First char of query
          score =
            j === 0
              ? SCORE_MATCH_CONSECUTIVE // start of string
              : Math.max(SCORE_MAX_LEADING_GAP, SCORE_GAP_LEADING * j) +
                bonusFor(candidate[j - 1], candidate[j]);
        } else if (j > 0) {
          // Consecutive match bonus
          const consecutive = D[i - 1][j - 1] + SCORE_MATCH_CONSECUTIVE;
          // Non-consecutive: gap penalty from best previous match
          const boundary =
            M[i - 1][j - 1] + bonusFor(candidate[j - 1], candidate[j]);
          score = Math.max(consecutive, boundary);
        }

        D[i][j] = score;
        M[i][j] = Math.max(score, prevScore + gapScore);
      } else {
        D[i][j] = -Infinity;
        M[i][j] = prevScore + gapScore;
      }

      prevScore = M[i][j];
    }
  }

  return M[n - 1][m - 1];
}

/** Levenshtein distance between two strings. */
function levenshtein(a: string, b: string): number {
  const n = a.length;
  const m = b.length;
  const dp: number[] = Array.from({ length: m + 1 }, (_, i) => i);

  for (let i = 1; i <= n; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= m; j++) {
      const tmp = dp[j];
      if (a[i - 1] === b[j - 1]) {
        dp[j] = prev;
      } else {
        dp[j] = 1 + Math.min(prev, dp[j], dp[j - 1]);
      }
      prev = tmp;
    }
  }

  return dp[m];
}

/**
 * Typo-tolerant score: find the best-matching substring of candidate
 * within a window around the query length, then compute edit distance.
 * Handles "bioarxiv" → "biorxiv-database" (matches the "biorxiv" part).
 */
function typoScore(query: string, candidate: string): number {
  const q = query.toLowerCase();
  const c = candidate.toLowerCase();
  const maxDist = Math.max(1, Math.floor(q.length / 3));

  // Slide a window of varying size over the candidate to find the closest substring
  let bestDist = Infinity;
  const minWin = Math.max(1, q.length - maxDist);
  const maxWin = q.length + maxDist;

  for (let winLen = minWin; winLen <= maxWin && winLen <= c.length; winLen++) {
    for (let start = 0; start + winLen <= c.length; start++) {
      const sub = c.slice(start, start + winLen);
      const dist = levenshtein(q, sub);
      if (dist < bestDist) {
        bestDist = dist;
        if (dist === 0) break;
      }
    }
    if (bestDist === 0) break;
  }

  if (bestDist > maxDist) return -Infinity;
  // Score: always below fuzzy matches, closer distance = higher score
  return -0.5 - bestDist * 0.5;
}

/** Score a command against the query, checking multiple fields. */
function scoreCommand(cmd: SlashCommand, q: string): number {
  const cmdKey = cmd.full_command.slice(1); // strip leading /

  // 1. Fuzzy subsequence matching on command key and name (short strings, reliable)
  const cmdScore = fuzzyScore(q, cmdKey);
  const nameScore = fuzzyScore(q, cmd.name);

  // 2. Description: only substring (contains) match to avoid false positives on long text
  let descScore = -Infinity;
  if (cmd.description?.toLowerCase().includes(q.toLowerCase())) {
    descScore = q.length * 0.3; // modest score for description-only match
  }

  const fuzzy = Math.max(cmdScore, nameScore, descScore);
  if (fuzzy > -Infinity) return fuzzy;

  // 3. Typo-tolerant fallback on command key / name (handles bioarxiv → biorxiv)
  const typo = Math.max(typoScore(q, cmdKey), typoScore(q, cmd.name));

  return typo;
}

function filterAndSort(list: SlashCommand[], q: string): SlashCommand[] {
  if (!q) return list;

  const scored: { cmd: SlashCommand; score: number }[] = [];

  for (const cmd of list) {
    const score = scoreCommand(cmd, q);
    if (score > -Infinity) {
      scored.push({ cmd, score });
    }
  }

  scored.sort((a, b) => b.score - a.score);

  return scored.map((s) => s.cmd);
}

/** Render SKILL.md body as lightweight styled content */
function SkillPreview({ content }: { content: string }) {
  // Strip frontmatter
  let body = content;
  if (body.startsWith("---")) {
    const endIdx = body.indexOf("---", 3);
    if (endIdx !== -1) {
      body = body.slice(endIdx + 3).trim();
    }
  }

  return (
    <div className="prose prose-sm prose-invert max-w-none text-muted-foreground text-xs leading-relaxed">
      {body.split("\n").map((line, i) => {
        const trimmed = line.trimEnd();
        if (trimmed.startsWith("# ")) {
          return (
            <h3
              key={i}
              className="mt-3 mb-1 font-semibold text-foreground text-sm"
            >
              {trimmed.slice(2)}
            </h3>
          );
        }
        if (trimmed.startsWith("## ")) {
          return (
            <h4
              key={i}
              className="mt-2.5 mb-0.5 font-semibold text-foreground text-xs"
            >
              {trimmed.slice(3)}
            </h4>
          );
        }
        if (trimmed.startsWith("### ")) {
          return (
            <h5
              key={i}
              className="mt-2 mb-0.5 font-medium text-foreground text-xs"
            >
              {trimmed.slice(4)}
            </h5>
          );
        }
        if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
          return (
            <div
              key={i}
              className="pl-3 before:mr-1.5 before:text-muted-foreground/50 before:content-['·']"
            >
              {trimmed.slice(2)}
            </div>
          );
        }
        if (trimmed.startsWith("```")) {
          return (
            <div
              key={i}
              className="font-mono text-[10px] text-muted-foreground/70"
            >
              {trimmed}
            </div>
          );
        }
        if (trimmed === "") {
          return <div key={i} className="h-1.5" />;
        }
        return <div key={i}>{trimmed}</div>;
      })}
    </div>
  );
}

export const SlashCommandPicker: FC<SlashCommandPickerProps> = ({
  projectPath,
  provider,
  query,
  anchorRef,
  onSelect,
  onClose,
}) => {
  const [commands, setCommands] = useState<SlashCommand[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [activeTab, setActiveTab] = useState<Tab>("all");
  const [showPreview, setShowPreview] = useState(false);
  const popupElementRef = useRef<HTMLDivElement>(null);
  const slashPopupRef = usePopupExit(popupElementRef);
  const listRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{
    left: number;
    right: number;
    bottom: number;
  }>({ left: 0, right: 0, bottom: 0 });

  const isSearching = query.length > 0;
  const availableTabs = useMemo(
    () => availableTabsForProvider(provider),
    [provider],
  );
  const tabsScrollRef = useRef<HTMLDivElement>(null);

  // Compute fixed position from anchor element
  useLayoutEffect(() => {
    if (!anchorRef.current) return;
    const rect = anchorRef.current.getBoundingClientRect();
    setPos({
      left: rect.left + 12,
      right: Math.max(window.innerWidth - rect.right + 12, 12),
      bottom: window.innerHeight - rect.top,
    });
  }, [anchorRef]);

  const handleTabsWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    const container = tabsScrollRef.current;
    if (!container) return;
    if (container.scrollWidth <= container.clientWidth) return;

    const delta =
      Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
    if (delta === 0) return;

    e.preventDefault();
    container.scrollLeft += delta;
  }, []);

  const piBinaryPath = useSettingsStore((s) => s.piBinaryPath);
  const piConfigDirectory = useSettingsStore((s) => s.piConfigDirectory);

  // Load the commands for the selected installation and configuration.
  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setCommands([]);
    invoke<SlashCommand[]>("slash_commands_list", {
      projectPath: projectPath ?? undefined,
      provider,
      ...(provider === "pi"
        ? {
            piConfig: {
              binaryPath: piBinaryPath,
              configDirectory: piConfigDirectory,
            },
          }
        : {}),
    })
      .then((cmds) => {
        if (cancelled) return;
        setCommands([
          ...(HARNESSES[provider].compact ? [compactCommand] : []),
          ...cmds.filter((cmd) => cmd.full_command !== "/compact"),
        ]);
        setIsLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setCommands(HARNESSES[provider].compact ? [compactCommand] : []);
        setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectPath, provider, piBinaryPath, piConfigDirectory]);

  useEffect(() => {
    if (!availableTabs.includes(activeTab)) {
      setActiveTab(availableTabs[0]);
    }
  }, [activeTab, availableTabs]);

  // Counts per tab (for badges)
  const tabCounts = useMemo(() => {
    const counts = Object.fromEntries(
      availableTabs.map((tab) => [tab, 0]),
    ) as Record<Tab, number>;
    counts.all = commands.length;
    for (const cmd of commands) {
      const tab = commandTabForScope(cmd, provider, projectPath);
      counts[tab] = (counts[tab] ?? 0) + 1;
    }
    return counts;
  }, [availableTabs, commands, projectPath, provider]);

  // Filtered results: unified search or tab-scoped
  const filtered = useMemo(() => {
    const q = query.toLowerCase();

    if (isSearching) {
      return filterAndSort(commands, q);
    }

    if (activeTab === "all") {
      return [...commands].sort((a, b) =>
        a.full_command.localeCompare(b.full_command, undefined, {
          sensitivity: "base",
        }),
      );
    }

    const byTab = commands.filter(
      (cmd) => commandTabForScope(cmd, provider, projectPath) === activeTab,
    );
    return byTab;
  }, [query, commands, activeTab, isSearching, projectPath, provider]);

  // The currently highlighted command
  const selectedCommand = filtered.length > 0 ? filtered[selectedIndex] : null;
  const canPreview = selectedCommand?.scope === "skill";

  // Group by scope for unified search display
  const searchGroups = useMemo(() => {
    if (!isSearching) return null;

    const groups: {
      label: string;
      items: { cmd: SlashCommand; globalIndex: number }[];
    }[] = [];
    const order = [
      ...availableTabs.filter((tab) => tab !== "all"),
      ...(availableTabs.includes("command") ? [] : (["command"] as const)),
    ];

    for (const tab of order) {
      const items: { cmd: SlashCommand; globalIndex: number }[] = [];
      filtered.forEach((cmd, i) => {
        if (commandTabForScope(cmd, provider, projectPath) === tab) {
          items.push({ cmd, globalIndex: i });
        }
      });
      if (items.length > 0) {
        groups.push({ label: tabLabel(tab), items });
      }
    }

    return groups;
  }, [availableTabs, filtered, isSearching, projectPath, provider]);

  // Reset selected index when filtered list changes
  useEffect(() => {
    setSelectedIndex(0);
  }, [query, activeTab]);

  // Close preview when switching away from a skill
  useEffect(() => {
    if (!canPreview) setShowPreview(false);
  }, [canPreview]);

  // Handle keys only in this composer and its portaled picker.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (isComposingKey(e) || e.defaultPrevented) return;
      // Focused buttons keep native activation; list navigation belongs to the input.
      if (
        e.key !== "Escape" &&
        !(e.target as Element)?.matches?.("[data-chat-composer-input]")
      )
        return;
      switch (e.key) {
        case "Escape":
          consumeKey(e);
          if (showPreview) {
            setShowPreview(false);
          } else {
            onClose();
          }
          break;
        case "Enter":
        case "Tab":
          consumeKey(e);
          if (filtered.length > 0 && selectedIndex < filtered.length) {
            onSelect(filtered[selectedIndex]);
          }
          break;
        case "ArrowUp":
          consumeKey(e);
          setSelectedIndex((prev) => Math.max(0, prev - 1));
          break;
        case "ArrowDown":
          consumeKey(e);
          setSelectedIndex((prev) => Math.min(filtered.length - 1, prev + 1));
          break;
        case "ArrowRight":
          if (canPreview) {
            consumeKey(e);
            setShowPreview(true);
          }
          break;
        case "ArrowLeft":
          if (showPreview) {
            consumeKey(e);
            setShowPreview(false);
          }
          break;
      }
    };

    const composer = anchorRef.current;
    const popup = popupElementRef.current;
    composer?.addEventListener("keydown", handleKeyDown, true);
    popup?.addEventListener("keydown", handleKeyDown, true);
    return () => {
      composer?.removeEventListener("keydown", handleKeyDown, true);
      popup?.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [filtered, selectedIndex, onSelect, onClose, showPreview, canPreview]);

  // Scroll selected item into view
  useEffect(() => {
    if (listRef.current) {
      const selected = listRef.current.querySelector(
        `[data-index="${selectedIndex}"]`,
      );
      selected?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [selectedIndex]);

  const renderItem = (cmd: SlashCommand, index: number) => {
    const isSelected = index === selectedIndex;
    const isSkill = cmd.scope === "skill";
    return (
      <button
        key={cmd.id}
        data-index={index}
        className={cn(
          "flex w-full items-center gap-2.5 rounded-md px-3 py-1.5 text-left transition-colors",
          isSelected ? "bg-accent text-accent-foreground" : "hover:bg-muted",
        )}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => onSelect(cmd)}
        onMouseEnter={() => setSelectedIndex(index)}
      >
        {getCommandIcon(cmd, provider, projectPath)}
        <span className="truncate font-mono text-sm">
          {commandSyntaxForProvider(cmd, provider)}
        </span>
        {cmd.description && (
          <span className="min-w-0 flex-1 truncate text-muted-foreground text-xs">
            {cmd.description}
          </span>
        )}
        {isSearching && (
          <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
            {cmd.scope === "native"
              ? "Built-in command"
              : tabLabel(commandTabForScope(cmd, provider, projectPath))}
          </span>
        )}
        {isSkill && isSelected && (
          <ChevronRightIcon
            className="size-3.5 shrink-0 text-muted-foreground"
            onClick={(event) => event.stopPropagation()}
            onMouseDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setShowPreview((v) => !v);
            }}
          />
        )}
      </button>
    );
  };

  const renderEmptyState = () => {
    if (isSearching) {
      return (
        <div className="flex flex-col items-center justify-center py-8">
          <SearchIcon className="mb-2 size-6 text-muted-foreground" />
          <span className="text-muted-foreground text-sm">
            No results for "{query}"
          </span>
        </div>
      );
    }

    const hints: Record<Tab, React.ReactNode> = {
      all: null,
      catalex: null,
      command: (
        <p className="mt-1 px-4 text-center text-muted-foreground text-xs">
          Add commands in <code className="px-1">.claude/commands/</code> or{" "}
          <code className="px-1">~/.claude/commands/</code>
        </p>
      ),
      "global-skills": (
        <p className="mt-1 px-4 text-center text-muted-foreground text-xs">
          Install skills in{" "}
          <code className="px-1">
            {provider === "pi"
              ? "~/.pi/agent/skills/"
              : provider === "codex"
                ? "~/.codex/skills/"
                : "~/.claude/skills/"}
          </code>
        </p>
      ),
      "local-skills": (
        <p className="mt-1 px-4 text-center text-muted-foreground text-xs">
          Add project skills in{" "}
          <code className="px-1">
            {provider === "pi"
              ? ".pi/skills/"
              : provider === "codex"
                ? ".codex/skills/"
                : ".claude/skills/"}
          </code>
        </p>
      ),
      "plugin-skills": null,
      "built-in-skills": null,
    };

    return (
      <div className="flex flex-col items-center justify-center py-8">
        <span className="text-muted-foreground text-sm">
          No commands available
        </span>
        {hints[activeTab]}
      </div>
    );
  };

  const renderList = () => (
    <div className="app-scrollbar flex-1 overflow-y-auto" ref={listRef}>
      {isLoading && (
        <div className="flex items-center justify-center py-8">
          <span className="text-muted-foreground text-sm">Loading...</span>
        </div>
      )}

      {!isLoading && filtered.length === 0 && renderEmptyState()}

      {!isLoading && filtered.length > 0 && (
        <div className="p-1.5">
          {isSearching && searchGroups ? (
            <div className="space-y-2">
              {searchGroups.map((group) => (
                <div key={group.label}>
                  <h3 className="px-3 py-1 font-semibold text-[10px] text-muted-foreground uppercase tracking-wider">
                    {group.label}
                  </h3>
                  <div className="space-y-0.5">
                    {group.items.map(({ cmd, globalIndex }) =>
                      renderItem(cmd, globalIndex),
                    )}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="space-y-0.5">
              {filtered.map((cmd, i) => renderItem(cmd, i))}
            </div>
          )}
        </div>
      )}
    </div>
  );

  return createPortal(
    <div
      data-ui-surface="popover"
      ref={slashPopupRef}
      className="popup-glass popup-motion fixed flex overflow-hidden rounded-xl border border-[color:var(--popup-surface-border,var(--border))] bg-[var(--popup-surface-background,var(--background))] shadow-[0_0_0_transparent,var(--popup-surface-shadow,var(--shadow-lg))]"
      style={{
        left: pos.left,
        right: pos.right,
        bottom: pos.bottom,
        maxHeight: "400px",
        zIndex: 9999,
      }}
    >
      {/* Left side: list */}
      <div
        className={cn(
          "flex flex-col overflow-hidden transition-all",
          showPreview ? "w-[45%] min-w-[200px]" : "w-full",
        )}
      >
        {/* Header */}
        <div className="shrink-0 border-border border-b px-3 pt-2.5 pb-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <CommandIcon className="size-4 text-muted-foreground" />
              <span className="font-medium text-sm">
                {isSearching ? `Search: "${query}"` : "Commands"}
              </span>
            </div>
            <button
              aria-label="Close command picker"
              onMouseDown={(e) => e.preventDefault()}
              onClick={onClose}
              className="rounded-md p-1 transition-colors hover:bg-muted"
            >
              <XIcon className="size-3.5" />
            </button>
          </div>

          <div className="mt-1 text-[10px] text-muted-foreground">
            ↑↓ Navigate · Enter Select · {canPreview ? "→ Preview · " : ""}Esc
            Close
          </div>
        </div>

        {renderList()}

        {/* Footer */}
        {!isSearching && (
          <div className="shrink-0 border-border border-t px-3 py-2">
            <ButtonGroup
              ref={tabsScrollRef}
              onWheel={handleTabsWheel}
              className="scrollbar-none overflow-x-auto"
            >
              <div className="flex w-max items-center gap-0">
                {availableTabs.map((tab) => (
                  <button
                    key={tab}
                    aria-pressed={activeTab === tab}
                    className={cn(
                      "group relative flex min-w-[96px] max-w-[180px] shrink-0 items-center gap-1.5 rounded-md px-2 py-1.5 text-xs transition-colors",
                      activeTab === tab
                        ? "bg-background text-foreground shadow-sm"
                        : "text-muted-foreground hover:bg-background/70 hover:text-foreground",
                    )}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => setActiveTab(tab)}
                  >
                    {tabIcon(tab)}
                    <span className="min-w-0 flex-1 truncate text-left">
                      {tabLabel(tab)}
                    </span>
                    {tabCounts[tab] > 0 && (
                      <span
                        className={cn(
                          "shrink-0 rounded-full px-1.5 text-[10px] tabular-nums leading-4",
                          activeTab === tab
                            ? "bg-muted text-foreground"
                            : "bg-muted-foreground/15 text-muted-foreground",
                        )}
                      >
                        {tabCounts[tab]}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </ButtonGroup>
          </div>
        )}
      </div>

      {/* Right side: preview panel */}
      {showPreview && selectedCommand && (
        <div className="flex w-[55%] flex-col border-border border-l">
          {/* Preview header */}
          <div className="flex shrink-0 items-center gap-2 border-border border-b px-3 py-2">
            <button
              aria-label="Close preview"
              onMouseDown={(e) => {
                e.preventDefault();
                setShowPreview(false);
              }}
              className="rounded-md p-0.5 transition-colors hover:bg-muted"
            >
              <ChevronLeftIcon className="size-3.5 text-muted-foreground" />
            </button>
            <FlaskConicalIcon className="size-3.5 text-muted-foreground" />
            <span className="truncate font-medium font-mono text-sm">
              {commandSyntaxForProvider(selectedCommand, provider)}
            </span>
          </div>

          {/* Preview body */}
          <div className="app-scrollbar flex-1 overflow-y-auto px-3 py-2">
            <SkillPreview content={selectedCommand.content} />
          </div>
        </div>
      )}
    </div>,
    document.body,
  );
};
