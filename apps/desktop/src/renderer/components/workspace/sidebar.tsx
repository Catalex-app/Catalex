import { useAppAction } from "@/hooks/use-app-actions";
import "./sidebar-status-motion.css";
import {
  insertMarkdownFileLinksAtPoint,
  updateMarkdownFileDropCaret,
} from "./editor/markdown-file-drop";
import { useUpdater } from "@/hooks/use-updater";
import { PRODUCT_NAME } from "../../../branding";
import { useProjectComments } from "./editor/use-project-comments";
import { CommentDeleteButtons } from "./editor/comment-delete-buttons";
import { PROJECT_COMMENTS_REFRESH_EVENT } from "@/lib/workspace-events";
import { toast } from "sonner";
import { SidebarFileContextActions } from "./sidebar-file-context-actions";
import { fileTreeCollisionDetection } from "./sidebar-file-drop";
import { Hint } from "@/components/ui/tooltip";
import { SettingsSwitch } from "@/components/settings/settings-switch";
import { useCollapsedSidebarBody } from "@/hooks/use-collapsed-sidebar-body";
import {
  SidebarSectionBody,
  SidebarSectionHeader,
  SidebarRow,
  SidebarRowIcon,
  SidebarFittedMarker,
  SidebarTreeGuide,
  SIDEBAR_GUIDE_CHILD_TOP,
  SIDEBAR_GUIDE_BOTTOM,
} from "./sidebar-layout";
import {
  buildFileTree,
  getFileIcon,
  SidebarFileTree,
  type SidebarFileTreeNode,
} from "./sidebar-files";
import { PdfFileIcon } from "@/components/ui/pdf-file-icon";
import {
  EyeIcon,
  MessageSquareOffIcon,
  MessageSquareTextIcon,
} from "lucide-react";
import { useFileCompileDiagnostics } from "@/hooks/use-file-compile-diagnostics";
import {
  memo,
  useState,
  useCallback,
  useMemo,
  useRef,
  useEffect,
  useLayoutEffect,
  useId,
} from "react";
import {
  FileTextIcon,
  CircleArrowUpIcon,
  TriangleAlertIcon,
  CircleXIcon,
  FolderIcon,
  HomeIcon,
  FolderPlusIcon,
  PlusIcon,
  Trash2Icon,
  PencilIcon,
  UploadIcon,
  RefreshCwIcon,
  SunIcon,
  MoonIcon,
  MonitorIcon,
  PaletteIcon,
  ListIcon,
  ChevronRightIcon,
  ChevronDownIcon,
  ActivityIcon,
  SettingsIcon,
  LogOutIcon,
  SidebarIcon,
  UserIcon,
  GitMergeIcon,
  BotMessageSquareIcon,
} from "lucide-react";
import { invoke } from "@/lib/desktop/core";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  useDroppable,
  useDraggable,
  type DragStartEvent,
  type DragEndEvent,
} from "@dnd-kit/core";
import { useAppTheme } from "@/lib/app-theme";
import { useDocumentStore, type ProjectFile } from "@/stores/document-store";
import { useHistoryStore } from "@/stores/history-store";
import { useProposedChangesStore } from "@/stores/proposed-changes-store";
import { useSettingsStore } from "@/stores/settings-store";
import { fetchCcfddlDeadlines, resolveCcfddlCatLabel } from "@/lib/ccfddl";
import { cn } from "@/lib/utils";
import type { ConflictOverview } from "@/lib/git-conflicts";
import {
  formatKeyboardShortcut,
  resolveKeyboardShortcut,
} from "@/lib/keyboard-shortcuts";
import { isMarkdownFile, isMarkdownPath } from "@/lib/markdown";
import {
  parseDocumentOutline,
  indexOutlinePositions,
  findCurrentOutlineLine,
} from "@/lib/document-outline";
import { ZoteroPanel } from "@/components/workspace/zotero-panel";
import { SessionListPanel } from "@/components/agent-chat/session-list-panel";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { PopupHeader, PopupSeparator } from "@/components/ui/popup-surface";
import {
  SettingsDropdown,
  SolarizeDropdown,
  EDITOR_COLOR_SCHEME_OPTIONS,
} from "@/components/settings/settings-dropdown";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Input } from "@/components/ui/input";
import { open as openDialog } from "@/lib/desktop/dialog";
import { getCurrentWebview } from "@/lib/desktop/webview";
import { createLogger } from "@/lib/debug/logger";
import { broadcastSettingsChanged } from "@/components/settings/solar-mode-effect";
import { useZoteroStore } from "@/stores/zotero-store";
import { readTexFileContent } from "@/lib/project-files";
import { getElementFromNativeDropPosition } from "@/lib/desktop/native-drop";
import { TrafficLightSafeHeader } from "@/components/window-titlebar";
import {
  AssistantModeSwitch,
  type WorkspaceAssistantMode,
} from "./assistant-mode-switch";
import { ExternalAppSelector } from "./external-app-selector";

const log = createLogger("sidebar");
const MIN_BOTTOM_SECTION_HEIGHT = 56;
const MAX_BOTTOM_SECTION_HEIGHT = 720;
const SIDEBAR_SECTION_HEADER_HEIGHT = 32;
const MIN_PRIMARY_SECTION_HEIGHT = 64;
const DEFAULT_SYSTEM_PROMPTS_BODY_HEIGHT = 72;
const SIDEBAR_SECTION_TRANSITION_MS = 180;
const GIT_STATS_REFRESH_EVENT = "catalex:git-stats-refresh";
const SKIP_FILE_MOVE_CONFIRMATION_STORAGE_KEY =
  "catalex.skipFileMoveConfirmation";
const DROP_TARGET_HIGHLIGHT_CLASS =
  "rounded-md bg-sidebar-accent/80 ring-1 ring-inset ring-sidebar-ring/50";
export const HANDWRITTEN_CAT_FONT =
  '"Caveat Brush", "Caveat", "Patrick Hand", "Comic Neue", "Chalkboard SE", "Comic Sans MS", cursive';
const HANDWRITTEN_CJK_CAT_FONT = `"Hannotate SC", "Xingkai SC", "Kaiti SC", "STKaiti", "KaiTi", "DFKai-SB", ${HANDWRITTEN_CAT_FONT}`;
const HANDWRITTEN_CJK_BOLD_SHADOW =
  "0.45px 0 currentColor, -0.45px 0 currentColor, 0 0.45px currentColor, 0 -0.45px currentColor";

function openSettingsWindow(section?: "about") {
  invoke("open_settings_window", section ? { section } : undefined).catch(
    (error) => {
      log.error("Failed to open settings window", { error: String(error) });
    },
  );
}

function SidebarUtilityControls() {
  const { notice: updateStatus } = useUpdater();
  const hasUpdate = updateStatus.state === "available";
  const { theme, setTheme } = useAppTheme();
  const ThemeIcon =
    theme === "system" ? MonitorIcon : theme === "dark" ? MoonIcon : SunIcon;
  const themeLabel =
    theme === "system" ? "Auto" : theme === "dark" ? "Dark" : "Light";
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const solarModeLevel = useSettingsStore((state) => state.solarModeLevel);
  const setSolarModeLevel = useSettingsStore(
    (state) => state.setSolarModeLevel,
  );
  const editorColorScheme = useSettingsStore(
    (state) => state.editorColorScheme,
  );
  const setEditorColorScheme = useSettingsStore(
    (state) => state.setEditorColorScheme,
  );
  const overrides = useSettingsStore(
    (state) => state.keyboardShortcutOverrides,
  );
  const shortcut = formatKeyboardShortcut(
    resolveKeyboardShortcut(overrides, "open-settings"),
  );

  return (
    <div
      className="sidebar-utility-controls flex shrink-0 items-center gap-2 border-sidebar-border border-t py-2"
      data-update-available={hasUpdate}
    >
      <Hint content={shortcut ? `Settings (${shortcut})` : "Settings"}>
        <SidebarRow asChild className="sidebar-settings-button h-7 text-xs">
          <Button
            type="button"
            variant="ghost"
            className="h-7 min-w-0 justify-start gap-2 border-0 bg-muted/50 px-2 text-xs ring-1 ring-border ring-inset"
            onClick={() => openSettingsWindow()}
            aria-label="Settings"
          >
            <SidebarRowIcon>
              <SettingsIcon className="size-4" />
            </SidebarRowIcon>
            <span data-settings-detail aria-hidden={hasUpdate}>
              Settings
            </span>
            {shortcut ? (
              <kbd
                data-settings-detail
                aria-hidden={hasUpdate}
                className="ml-auto min-w-0 truncate font-normal font-sans text-muted-foreground text-xs"
              >
                {shortcut}
              </kbd>
            ) : null}
          </Button>
        </SidebarRow>
      </Hint>
      <div
        className="sidebar-update-slot"
        aria-hidden={!hasUpdate}
        inert={!hasUpdate}
      >
        <Button
          type="button"
          className="@container/sidebar-update h-7 w-full min-w-0 gap-2 bg-[#d96b17] px-2 text-white text-xs hover:bg-[#c55d10]"
          aria-label={
            hasUpdate
              ? `Update available: Catalex ${updateStatus.version}`
              : "Update"
          }
          onClick={() => openSettingsWindow("about")}
        >
          <SidebarRowIcon>
            <CircleArrowUpIcon className="size-4" />
          </SidebarRowIcon>
          <span>
            Update
            <span className="@[120px]/sidebar-update:inline hidden">
              {" "}
              available
            </span>
          </span>
        </Button>
      </div>
      <Popover open={appearanceOpen} onOpenChange={setAppearanceOpen}>
        <Hint content={`Appearance (${themeLabel})`}>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-7 data-[state=open]:bg-accent"
              aria-label="Appearance"
              aria-description={`Current theme: ${themeLabel}`}
            >
              <ThemeIcon className="size-3.5" />
            </Button>
          </PopoverTrigger>
        </Hint>
        <PopoverContent
          side="top"
          align="center"
          collisionPadding={8}
          sideOffset={8}
          aria-label="Appearance"
          className="w-64 p-1"
        >
          <PopupHeader>
            <PaletteIcon className="size-3.5 text-muted-foreground" />
            <span>Appearance</span>
          </PopupHeader>
          <div className="px-2 pt-1 pb-2">
            <ButtonGroup aria-label="Theme" className="grid grid-cols-3 gap-1">
              {[
                { value: "light", label: "Light", Icon: SunIcon },
                { value: "dark", label: "Dark", Icon: MoonIcon },
                { value: "system", label: "Auto", Icon: MonitorIcon },
              ].map(({ value, label, Icon }) => (
                <Button
                  key={value}
                  type="button"
                  variant="ghost"
                  size="sm"
                  className={cn(
                    "h-7 gap-1.5 px-2 text-xs focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-ring",
                    theme === value
                      ? "bg-background text-foreground shadow-sm hover:bg-background"
                      : "text-muted-foreground hover:bg-background/70 hover:text-foreground",
                  )}
                  onClick={() => setTheme(value)}
                  aria-pressed={theme === value}
                >
                  <Icon className="size-3.5" />
                  {label}
                </Button>
              ))}
            </ButtonGroup>
          </div>
          <PopupSeparator />
          <div className="px-2 py-1">
            <div className="flex h-8 items-center justify-between gap-4 text-xs">
              <span>Solarize</span>
              <SolarizeDropdown
                value={solarModeLevel}
                onValueChange={(level) => {
                  setSolarModeLevel(level);
                  broadcastSettingsChanged();
                }}
              />
            </div>
            <div className="flex h-8 items-center justify-between gap-4 text-xs">
              <span>Editor theme</span>
              <SettingsDropdown
                ariaLabel="Editor color scheme"
                value={editorColorScheme}
                options={EDITOR_COLOR_SCHEME_OPTIONS}
                onChange={(scheme) => {
                  setEditorColorScheme(scheme);
                  broadcastSettingsChanged();
                }}
              />
            </div>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}

// ─── File Tree Builder ───

type TreeNode = SidebarFileTreeNode<ProjectFile>;

interface GitFileLineStats {
  file_path: string;
  added: number;
  deleted: number;
}

function splitContentLines(content: string): string[] {
  return content.length > 0 ? content.split("\n") : [];
}

function computeLineChangeCounts(
  oldContent: string,
  newContent: string,
): { added: number; deleted: number } {
  const oldLines = splitContentLines(oldContent);
  const newLines = splitContentLines(newContent);

  let i = 0;
  let j = 0;
  let added = 0;
  let deleted = 0;

  while (i < oldLines.length || j < newLines.length) {
    if (
      i < oldLines.length &&
      j < newLines.length &&
      oldLines[i] === newLines[j]
    ) {
      i++;
      j++;
      continue;
    }

    let foundOld = -1;
    let foundNew = -1;
    const searchLimit = Math.min(
      50,
      Math.max(oldLines.length - i, newLines.length - j),
    );
    for (let look = 1; look <= searchLimit; look++) {
      if (
        foundOld < 0 &&
        i + look < oldLines.length &&
        j < newLines.length &&
        oldLines[i + look] === newLines[j]
      ) {
        foundOld = i + look;
      }
      if (
        foundNew < 0 &&
        j + look < newLines.length &&
        i < oldLines.length &&
        newLines[j + look] === oldLines[i]
      ) {
        foundNew = j + look;
      }
      if (foundOld >= 0 || foundNew >= 0) break;
    }

    if (foundOld >= 0 && (foundNew < 0 || foundOld - i <= foundNew - j)) {
      deleted += foundOld - i;
      i = foundOld;
      continue;
    }
    if (foundNew >= 0) {
      added += foundNew - j;
      j = foundNew;
      continue;
    }

    if (i < oldLines.length) {
      deleted++;
      i++;
    }
    if (j < newLines.length) {
      added++;
      j++;
    }
  }

  return { added, deleted };
}

function normalizeGitPath(path: string): string {
  let normalized = path.replace(/\\/g, "/");
  while (normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

const PENDING_AI_REVIEW_TEXT_CLASS = "text-emerald-700 dark:text-emerald-400";
const PENDING_AI_REVIEW_SELECTED_CLASS =
  "bg-emerald-100 hover:bg-emerald-200 dark:bg-emerald-600/20 dark:hover:bg-emerald-600/30";

function isIgnoredFilePath(
  path: string,
  ignoredPaths: ReadonlySet<string>,
): boolean {
  return ignoredPaths.has(normalizeGitPath(path));
}

function isIgnoredFolderPath(
  folderNode: TreeNode,
  ignoredPaths: ReadonlySet<string>,
): boolean {
  const normalized = normalizeGitPath(folderNode.relativePath);
  if (ignoredPaths.has(normalized)) return true;

  // Grey only when all descendant files are ignored (not for mixed folders).
  let hasDescendantFile = false;
  const stack: TreeNode[] = [...folderNode.children];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current.type === "file") {
      hasDescendantFile = true;
      if (!isIgnoredFilePath(current.relativePath, ignoredPaths)) {
        return false;
      }
      continue;
    }
    stack.push(...current.children);
  }
  return hasDescendantFile;
}

// ─── File Icon ───

const CONFLICT_TEXT_CLASS = "text-violet-700 dark:text-violet-300";
const CONFLICT_SELECTED_CLASS =
  "bg-violet-100 hover:bg-violet-200 dark:bg-violet-600/20 dark:hover:bg-violet-600/30";

interface FileCommentCounts {
  human: number;
  agent: number;
}

function FileStatus({
  fileId,
  commentCounts,
}: {
  fileId: string;
  commentCounts?: FileCommentCounts;
}) {
  const diagnostics = useFileCompileDiagnostics(fileId);
  const maskId = useId();
  const stacked = useSettingsStore((s) => s.sidebarStatusStacked);
  const setStacked = useSettingsStore((s) => s.setSidebarStatusStacked);
  const indicators = [
    ...(["human", "agent"] as const).flatMap((author) => {
      const count = commentCounts?.[author] ?? 0;
      if (!count) return [];
      const label = `${count} unresolved ${author} ${count === 1 ? "comment" : "comments"}`;
      return [
        {
          key: author,
          label,
          className: author === "human" ? "text-[#eab308]" : "text-[#7252b5]",
          Icon: MessageSquareTextIcon,
        },
      ];
    }),
    ...(["warning", "error"] as const).flatMap((severity) => {
      const items = diagnostics.filter((item) => item.severity === severity);
      if (!items.length) return [];
      const label = `LaTeX compilation ${severity}`;
      return [
        {
          key: severity,
          label,
          className:
            severity === "error"
              ? "text-red-600 dark:text-red-400"
              : "text-yellow-600 dark:text-yellow-400",
          Icon: severity === "error" ? CircleXIcon : TriangleAlertIcon,
        },
      ];
    }),
  ];
  // Retain disappearing icons just long enough for their inert bubble burst.
  const signature = indicators.map((indicator) => indicator.key).join(",");
  const [presence, setPresence] = useState(() => ({
    signature,
    items: indicators.map((indicator) => ({ indicator, exiting: false })),
  }));
  if (presence.signature !== signature) {
    const order = ["human", "agent", "warning", "error"];
    setPresence({
      signature,
      items: [
        ...indicators.map((indicator) => ({ indicator, exiting: false })),
        ...presence.items
          .filter(
            ({ indicator }) =>
              !indicators.some((item) => item.key === indicator.key),
          )
          .map((item) => ({ ...item, exiting: true })),
      ].sort(
        (a, b) =>
          order.indexOf(a.indicator.key) - order.indexOf(b.indicator.key),
      ),
    });
  }
  useEffect(() => {
    if (!presence.items.some((item) => item.exiting)) return;
    const reducedMotion = matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    const timeout = window.setTimeout(
      () => {
        setPresence((current) => ({
          ...current,
          items: current.items.filter((item) => !item.exiting),
        }));
      },
      reducedMotion ? 0 : 240,
    );
    return () => window.clearTimeout(timeout);
  }, [presence]);
  if (!presence.items.length) return null;
  const canToggle = indicators.length >= 2;
  const action = stacked ? "Unstack file indicators" : "Stack file indicators";
  const icons = (
    <span className="relative inline-flex shrink-0">
      <span
        className="file-status-strip relative inline-block shrink-0"
        style={{ width: 14 + (presence.items.length - 1) * (stacked ? 8 : 18) }}
        data-file-status-stack={stacked && canToggle ? "true" : "false"}
      >
        {presence.items.map(({ indicator, exiting }, index) => {
          const { key, label, className, Icon } =
            indicators.find((item) => item.key === indicator.key) ?? indicator;
          const NextIcon = stacked
            ? presence.items[index + 1]?.indicator.Icon
            : undefined;
          const id = `${maskId}-${key}`;
          return (
            <span
              key={key}
              className={cn(
                "file-status-indicator inline-flex shrink-0",
                className,
              )}
              style={{
                right: (presence.items.length - 1 - index) * (stacked ? 8 : 18),
              }}
              data-status-key={key}
              data-exiting={exiting}
              role="img"
              aria-hidden={exiting || undefined}
              aria-label={label}
            >
              <span className="file-status-glyph">
                {NextIcon ? (
                  <svg
                    className="size-3.5 overflow-visible"
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                  >
                    <defs>
                      <mask
                        id={id}
                        maskUnits="userSpaceOnUse"
                        x="-4"
                        y="-4"
                        width="32"
                        height="32"
                        style={{ maskType: "luminance" }}
                      >
                        <rect
                          x="-4"
                          y="-4"
                          width="32"
                          height="32"
                          fill="white"
                        />
                        {/* Six-pixel overlap, with a transparent halo following the next icon's silhouette. */}
                        <NextIcon
                          className="size-6"
                          x={(8 * 24) / 14}
                          y={0}
                          width={24}
                          height={24}
                          fill="black"
                          stroke="black"
                          strokeWidth={5}
                        />
                      </mask>
                    </defs>
                    <g mask={`url(#${id})`}>
                      <Icon className="size-6" width={24} height={24} />
                    </g>
                  </svg>
                ) : (
                  <Icon className="size-3.5" aria-hidden="true" />
                )}
              </span>
            </span>
          );
        })}
      </span>
      {canToggle && (
        <Hint content={stacked ? "Click to unstack" : "Click to stack"}>
          <Button
            variant="ghost"
            size="sm"
            className="absolute inset-0 h-auto w-full rounded-sm p-0 hover:bg-transparent focus-visible:ring-2 focus-visible:ring-sidebar-ring dark:hover:bg-transparent"
            aria-label={action}
            aria-pressed={stacked}
            onPointerDown={(event) => event.stopPropagation()}
            onPointerMove={(event) => event.stopPropagation()}
            onFocus={(event) => event.stopPropagation()}
            onBlur={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              setStacked(!stacked);
            }}
            onAuxClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
            onDoubleClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ")
                event.stopPropagation();
            }}
          />
        </Hint>
      )}
    </span>
  );
  return icons;
}

function clampSectionHeight(height: number) {
  return Math.max(
    MIN_BOTTOM_SECTION_HEIGHT,
    Math.min(MAX_BOTTOM_SECTION_HEIGHT, height),
  );
}

function getDefaultOpenedSectionHeight(
  stackHeight: number,
  collapsedPanelCount: number,
) {
  return clampSectionHeight(
    0.5 *
      Math.max(
        0,
        stackHeight - SIDEBAR_SECTION_HEADER_HEIGHT * collapsedPanelCount,
      ),
  );
}

function useBottomSectionResize(
  initialHeight: number,
  getBounds?: () => { min?: number; max?: number },
  onResizingChange?: (isResizing: boolean) => void,
) {
  const clampHeight = useCallback(
    (nextHeight: number) => {
      const bounds = getBounds?.();
      const min = bounds?.min ?? MIN_BOTTOM_SECTION_HEIGHT;
      const max = Math.max(min, bounds?.max ?? MAX_BOTTOM_SECTION_HEIGHT);
      return Math.max(min, Math.min(max, nextHeight));
    },
    [getBounds],
  );

  const [height, setRawHeight] = useState(() =>
    clampSectionHeight(initialHeight),
  );

  const setHeight = useCallback(
    (nextHeight: number) => {
      setRawHeight(clampHeight(nextHeight));
    },
    [clampHeight],
  );

  const startResize = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();

      const startY = event.clientY;
      const startHeight = height;
      const pointerId = event.pointerId;
      const handle = event.currentTarget;
      const previousUserSelect = document.body.style.userSelect;
      const previousCursor = document.body.style.cursor;

      handle.setPointerCapture?.(pointerId);
      document.body.style.userSelect = "none";
      document.body.style.cursor = "row-resize";
      onResizingChange?.(true);

      const handlePointerMove = (moveEvent: PointerEvent) => {
        const delta = startY - moveEvent.clientY;
        setHeight(startHeight + delta);
      };

      const stopDragging = () => {
        handle.releasePointerCapture?.(pointerId);
        document.body.style.userSelect = previousUserSelect;
        document.body.style.cursor = previousCursor;
        onResizingChange?.(false);
        window.removeEventListener("pointermove", handlePointerMove);
        window.removeEventListener("pointerup", stopDragging);
        window.removeEventListener("pointercancel", stopDragging);
      };

      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", stopDragging);
      window.addEventListener("pointercancel", stopDragging);
    },
    [height, onResizingChange],
  );

  return {
    height,
    startResize,
    setHeight,
  };
}

export function CollapsibleSectionBody({
  expanded,
  className,
  children,
}: {
  expanded: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  const bodyRef = useCollapsedSidebarBody(!expanded);
  return (
    <div
      ref={bodyRef}
      aria-hidden={!expanded}
      className={cn(
        "grid min-h-0 overflow-hidden transition-[grid-template-rows] ease-out",
        expanded ? "grid-rows-[1fr]" : "pointer-events-none grid-rows-[0fr]",
        className,
      )}
      style={{ transitionDuration: `${SIDEBAR_SECTION_TRANSITION_MS}ms` }}
    >
      <div className="min-h-0 overflow-hidden">{children}</div>
    </div>
  );
}

function PromptSourceToggle({
  label,
  detail,
  Icon,
  checked,
  disabled,
  onCheckedChange,
}: {
  label: string;
  detail?: string;
  Icon: React.ComponentType<{ className?: string }>;
  checked: boolean;
  disabled?: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <SidebarRow
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
    >
      <SidebarRowIcon className="text-foreground">
        <Icon className="size-4" />
      </SidebarRowIcon>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs">{label}</span>
        {detail && (
          <span className="block truncate text-[10px] text-muted-foreground">
            {detail}
          </span>
        )}
      </span>
      <SettingsSwitch checked={checked} size="sm" indicatorOnly />
    </SidebarRow>
  );
}

function SystemPromptsSection({
  isCollapsed,
  onToggle,
  fillAvailableSpace = false,
  showTopBorder = true,
}: {
  isCollapsed: boolean;
  onToggle: () => void;
  fillAvailableSpace?: boolean;
  showTopBorder?: boolean;
}) {
  const enabledProviders = useSettingsStore((s) => s.enabledProviders);
  const files = useDocumentStore((s) => s.files);
  const setActiveFile = useDocumentStore((s) => s.setActiveFile);
  const openProjectInstructionFile = useDocumentStore(
    (s) => s.openProjectInstructionFile,
  );
  const canCreate = useDocumentStore(
    (s) =>
      !!s.projectRoot &&
      !s.agentWorkspaceRoot &&
      !s.isApplyingAgentDraft &&
      !s.isAgentWorkspaceReadOnly &&
      !s.isGitOperationRunning,
  );
  const [openingFile, setOpeningFile] = useState<string | null>(null);
  const instructionFiles = [
    ...(enabledProviders.codex || enabledProviders.pi
      ? ["AGENTS.md" as const]
      : []),
    ...(enabledProviders.claude ? ["CLAUDE.md" as const] : []),
  ];

  const openInstructionFile = async (fileName: "AGENTS.md" | "CLAUDE.md") => {
    setOpeningFile(fileName);
    try {
      await openProjectInstructionFile(fileName);
    } catch (error) {
      toast.error(`Could not open ${fileName}: ${String(error)}`);
    } finally {
      setOpeningFile(null);
    }
  };

  return (
    <div
      className={cn(
        "flex h-full min-h-0 flex-col overflow-hidden",
        showTopBorder && "border-sidebar-border border-t",
        fillAvailableSpace ? "flex-1" : "shrink-0",
      )}
    >
      <SidebarSectionHeader
        section="system-prompts"
        title="System Prompts"
        icon={<BotMessageSquareIcon className="size-3.5" />}
        collapsed={isCollapsed}
        onToggle={onToggle}
      />
      <CollapsibleSectionBody
        expanded={!isCollapsed}
        className="min-h-0 flex-1"
      >
        <SidebarSectionBody className="app-scrollbar h-full space-y-0.5 overflow-y-auto">
          {instructionFiles.map((fileName) => {
            const file = files.find((file) => file.relativePath === fileName);
            return (
              <SidebarRow asChild key={fileName} className="gap-1">
                <div>
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    disabled={!file || openingFile !== null}
                    aria-label={`Open ${fileName}`}
                    onClick={() => file && setActiveFile(file.id)}
                  >
                    <SidebarRowIcon className="text-foreground">
                      <FileTextIcon className="size-4" />
                    </SidebarRowIcon>
                    <span className="truncate text-xs">{fileName}</span>
                  </button>
                  {file ? (
                    <Hint content={`Edit ${fileName}`}>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-5"
                        aria-label={`Edit ${fileName}`}
                        disabled={openingFile !== null}
                        onClick={() => setActiveFile(file.id)}
                      >
                        <PencilIcon className="size-3" />
                      </Button>
                    </Hint>
                  ) : (
                    <Button
                      variant="outline"
                      size="xs"
                      className="h-5 border-sidebar-border px-1.5 text-[10px]"
                      aria-label={`Create ${fileName}`}
                      disabled={!canCreate || openingFile !== null}
                      onClick={() => void openInstructionFile(fileName)}
                    >
                      {openingFile === fileName ? "Creating…" : "Create"}
                    </Button>
                  )}
                </div>
              </SidebarRow>
            );
          })}
        </SidebarSectionBody>
      </CollapsibleSectionBody>
    </div>
  );
}

// ─── Sidebar ───

interface SidebarProps {
  onOutlineNavigate?: (position: number) => void;
  showHeaderActions?: boolean;
  onToggleSidebar?: () => void;
  onCloseProject?: () => void;
  trafficLightInset?: number;
  assistantMode?: WorkspaceAssistantMode;
  onAssistantModeChange?: (mode: WorkspaceAssistantMode) => void;
  contentMode?: "files" | "sessions";
  sessionPanel?: React.ReactNode;
  disableInteractiveIntegrations?: boolean;
  wizardOnly?: boolean;
  wizardPanelTitle?: string;
  wizardPanelActions?: React.ReactNode;
  wizardPrimaryAction?: React.ReactNode;
  wizardPanel?: React.ReactNode;
}

export const Sidebar = memo(function Sidebar(props: SidebarProps) {
  if (props.wizardOnly) {
    return <SidebarWizardOnly {...props} />;
  }
  return <SidebarDefault {...props} />;
});

function SidebarWizardOnly({
  showHeaderActions = false,
  onToggleSidebar,
  onCloseProject,
  trafficLightInset,
  wizardPanelTitle = "Environment",
  wizardPanelActions,
  wizardPrimaryAction,
  wizardPanel,
}: SidebarProps) {
  return (
    <div className="flex h-full flex-col bg-background text-sidebar-foreground">
      <TrafficLightSafeHeader trafficLightInset={trafficLightInset}>
        <div className="-ml-1 flex shrink-0 items-center gap-0.5">
          {showHeaderActions ? (
            <>
              <Hint content="Close project">
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-6"
                  onClick={onCloseProject}
                  aria-label="Close project"
                >
                  <HomeIcon className="size-3.5" />
                </Button>
              </Hint>
              <Hint content="Hide sidebar">
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-6"
                  onClick={onToggleSidebar}
                  aria-label="Hide sidebar"
                >
                  <SidebarIcon className="size-3.5" />
                </Button>
              </Hint>
              <ExternalAppSelector size="compact" />
            </>
          ) : null}
        </div>
      </TrafficLightSafeHeader>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="flex shrink-0 items-center justify-center px-2 pt-0 pb-2">
          <CatCompanion />
        </div>
        {wizardPrimaryAction ? (
          <div className="shrink-0 px-2 pt-1 pb-3">{wizardPrimaryAction}</div>
        ) : null}
        <div className="min-h-0 flex-1" />
        <div className="flex min-h-0 flex-col border-sidebar-border border-t">
          <SidebarSectionHeader
            title={wizardPanelTitle}
            actions={wizardPanelActions}
            icon={<ActivityIcon className="size-3.5" />}
          />
          <SidebarSectionBody className="app-scrollbar min-h-0 overflow-y-auto px-2">
            {wizardPanel}
          </SidebarSectionBody>
        </div>
      </div>

      <SidebarUtilityControls />
    </div>
  );
}

function SidebarDefault({
  onOutlineNavigate,
  showHeaderActions = false,
  onToggleSidebar,
  onCloseProject,
  trafficLightInset,
  assistantMode = "duet",
  onAssistantModeChange,
  contentMode = "files",
  sessionPanel,
  disableInteractiveIntegrations = false,
}: SidebarProps) {
  const sidebarRef = useRef<HTMLDivElement>(null);
  const filesModeStackRef = useRef<HTMLDivElement>(null);
  const filesModePanelHeightsInitializedRef = useRef(false);
  const files = useDocumentStore((s) => s.files);
  const proposedChanges = useProposedChangesStore((s) => s.changes);
  const pendingReviewFilePaths = useMemo(
    () =>
      new Set(
        proposedChanges.map((change) => normalizeGitPath(change.filePath)),
      ),
    [proposedChanges],
  );
  const activeFileId = useDocumentStore((s) => s.activeFileId);
  const setActiveFile = useDocumentStore((s) => s.setActiveFile);
  const deleteFile = useDocumentStore((s) => s.deleteFile);
  const deleteFolder = useDocumentStore((s) => s.deleteFolder);
  const renameFile = useDocumentStore((s) => s.renameFile);
  const createNewFile = useDocumentStore((s) => s.createNewFile);
  const createFolder = useDocumentStore((s) => s.createFolder);
  const importFiles = useDocumentStore((s) => s.importFiles);
  const activeFile = useMemo(
    () => files.find((file) => file.id === activeFileId),
    [activeFileId, files],
  );
  const activeFileContent = activeFile?.content ?? "";
  const requestJumpToPosition = useDocumentStore(
    (s) => s.requestJumpToPosition,
  );
  const _insertAtCursor = useDocumentStore((s) => s.insertAtCursor);
  const moveFile = useDocumentStore((s) => s.moveFile);
  const moveFolder = useDocumentStore((s) => s.moveFolder);
  const renameFolder = useDocumentStore((s) => s.renameFolder);
  const refreshFiles = useDocumentStore((s) => s.refreshFiles);
  const projectRoot = useDocumentStore((s) => s.projectRoot);
  const agentWorkspaceRoot = useDocumentStore((s) => s.agentWorkspaceRoot);
  const [commentFiles, , , commentsLoaded] = useProjectComments(
    agentWorkspaceRoot ? null : projectRoot,
  );
  const commentCountsByPath = useMemo(
    () =>
      new Map(
        commentsLoaded
          ? Object.entries(commentFiles).map(([path, comments]) => [
              path,
              comments.reduce<FileCommentCounts>(
                (counts, comment) => {
                  if (!comment.resolved && comment.text.trim()) {
                    counts[comment.origin ? "agent" : "human"] += 1;
                  }
                  return counts;
                },
                { human: 0, agent: 0 },
              ),
            ])
          : [],
      ),
    [commentFiles, commentsLoaded],
  );
  const folders = useDocumentStore((s) => s.folders);
  const zoteroAuthenticated = useZoteroStore((s) => s.isAuthenticated);
  const zoteroUsername = useZoteroStore((s) => s.username);
  const zoteroLoadingCollections = useZoteroStore(
    (s) => s.isLoadingCollections,
  );
  const zoteroLoadCollections = useZoteroStore((s) => s.loadCollections);
  const zoteroDisconnect = useZoteroStore((s) => s.disconnect);
  const [gitLineStatsByPath, setGitLineStatsByPath] = useState<
    Map<string, GitFileLineStats>
  >(new Map());
  const [gitStatsEventTick, setGitStatsEventTick] = useState(0);
  const [gitConflicts, setGitConflicts] = useState<{
    root: string;
    paths: ReadonlySet<string>;
  } | null>(null);
  const gitConflictPaths = useMemo(
    () =>
      gitConflicts?.root === projectRoot
        ? gitConflicts.paths
        : new Set<string>(),
    [gitConflicts, projectRoot],
  );
  const [unsavedLineStatsByPath, setUnsavedLineStatsByPath] = useState<
    Map<string, GitFileLineStats>
  >(new Map());
  const [gitIgnoredPaths, setGitIgnoredPaths] = useState<Set<string>>(
    new Set(),
  );
  const unsavedBaselineByPathRef = useRef<Map<string, string>>(new Map());

  // ─── Native OS file drop ───
  const sidebarFilesRef = useRef<HTMLDivElement>(null);
  const startupScrollSyncedProjectRef = useRef<string | null>(null);
  const nativeDropTargetRef = useRef<string | null>(null);
  const [nativeDragOver, setNativeDragOver] = useState<string | null>(null);

  useEffect(() => {
    if (disableInteractiveIntegrations) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    getCurrentWebview()
      .onDragDropEvent(async (event) => {
        if (cancelled) return;
        const { type } = event.payload;

        if (type === "over" || type === "enter") {
          const payload = event.payload as {
            position: { x: number; y: number };
          };
          const filesArea = sidebarFilesRef.current;
          const el = getElementFromNativeDropPosition(payload.position, {
            root: filesArea,
          });

          if (!filesArea || !el || !filesArea.contains(el)) {
            // Not over the sidebar file tree
            if (nativeDropTargetRef.current !== null) {
              nativeDropTargetRef.current = null;
              setNativeDragOver(null);
            }
            return;
          }

          // Walk up from the hovered element to find the closest drop-folder target
          const folderEl = el.closest(
            "[data-drop-folder]",
          ) as HTMLElement | null;
          const folder = folderEl?.dataset.dropFolder ?? "__root__";
          nativeDropTargetRef.current = folder;
          setNativeDragOver(folder);
        } else if (type === "drop") {
          const payload = event.payload as {
            paths: string[];
            position: { x: number; y: number };
          };
          const { paths, position } = payload;
          const filesArea = sidebarFilesRef.current;
          const el = getElementFromNativeDropPosition(position, {
            root: filesArea,
          });

          if (!filesArea || !el || !filesArea.contains(el)) {
            setNativeDragOver(null);
            nativeDropTargetRef.current = null;
            return;
          }

          const targetFolder =
            (el.closest<HTMLElement>("[data-drop-folder]")?.dataset
              .dropFolder ?? "__root__") === "__root__"
              ? undefined
              : el.closest<HTMLElement>("[data-drop-folder]")?.dataset
                  .dropFolder;

          // Mark as handled so chat-composer doesn't also process it
          (window as any).__sidebarHandledDrop = true;
          setTimeout(() => {
            (window as any).__sidebarHandledDrop = false;
          }, 200);

          try {
            await importFiles(paths, targetFolder);
          } catch (err) {
            log.error("Native drop import failed", { error: String(err) });
          }

          setNativeDragOver(null);
          nativeDropTargetRef.current = null;
        } else if (type === "leave") {
          setNativeDragOver(null);
          nativeDropTargetRef.current = null;
        }
      })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => {
        // Native drops are unavailable in browser previews
      });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [disableInteractiveIntegrations, importFiles]);

  // Track selected folder for paste target
  const [pasteTargetFolder, setPasteTargetFolder] = useState<
    string | undefined
  >();

  // ─── Cmd+V paste files from OS clipboard ───
  useEffect(() => {
    if (disableInteractiveIntegrations) return;
    const handleKeyDown = async (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key !== "v") return;

      // Don't intercept paste in text inputs / editor (contentEditable)
      const active = document.activeElement;
      if (
        active &&
        (active.tagName === "INPUT" ||
          active.tagName === "TEXTAREA" ||
          (active as HTMLElement).isContentEditable)
      )
        return;

      try {
        const paths = await invoke<string[]>("read_clipboard_file_paths");
        if (paths.length > 0) {
          e.preventDefault();
          await importFiles(paths, pasteTargetFolder);
        }
      } catch (err) {
        log.error("Read clipboard failed", { error: String(err) });
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [disableInteractiveIntegrations, importFiles, pasteTargetFolder]);

  const fileDragPointRef = useRef<{ x: number; y: number } | null>(null);
  const [fileDragOverEditor, setFileDragOverEditor] = useState(false);

  // dnd-kit drag-and-drop with pointer events
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );
  const [activeDrag, setActiveDrag] = useState<{
    id: string;
    type: "file" | "folder";
    name: string;
  } | null>(null);
  useEffect(() => {
    if (activeDrag?.type !== "file") return;
    const move = (event: PointerEvent) => {
      fileDragPointRef.current = { x: event.clientX, y: event.clientY };
      setFileDragOverEditor(
        updateMarkdownFileDropCaret(fileDragPointRef.current),
      );
    };
    const scroll = () =>
      setFileDragOverEditor(
        updateMarkdownFileDropCaret(fileDragPointRef.current),
      );
    const clear = () => {
      updateMarkdownFileDropCaret(null);
      setFileDragOverEditor(false);
    };
    document.addEventListener("pointermove", move, true);
    document.addEventListener("scroll", scroll, true);
    window.addEventListener("blur", clear);
    return () => {
      document.removeEventListener("pointermove", move, true);
      document.removeEventListener("scroll", scroll, true);
      window.removeEventListener("blur", clear);
      fileDragPointRef.current = null;
      clear();
    };
  }, [activeDrag]);

  useEffect(() => {
    if (!activeDrag) return;
    const cancelOnContextMenu = (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      // Use the sensor's Escape path so listeners, overlay and drop state all reset.
      document.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          code: "Escape",
          bubbles: true,
        }),
      );
    };
    document.addEventListener("contextmenu", cancelOnContextMenu, true);
    return () =>
      document.removeEventListener("contextmenu", cancelOnContextMenu, true);
  }, [activeDrag]);

  useEffect(() => {
    if (!activeDrag) return;
    const scrollDuringDrag = (event: WheelEvent) => {
      if (event.ctrlKey) return;
      const area = sidebarFilesRef.current;
      const scroller = area?.querySelector<HTMLElement>(
        '[data-drop-folder="__root__"]',
      );
      if (!area || !scroller) return;
      const bounds = area.getBoundingClientRect();
      if (
        event.clientX < bounds.left ||
        event.clientX > bounds.right ||
        event.clientY < bounds.top ||
        event.clientY > bounds.bottom
      )
        return;
      // The floating drag preview can receive wheel events outside the scroll
      // container. Route them to the file tree while retaining the active drag.
      event.preventDefault();
      const scale =
        event.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? 16
          : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? scroller.clientHeight
            : 1;
      scroller.scrollBy({ top: event.deltaY * scale, behavior: "instant" });
    };
    document.addEventListener("wheel", scrollDuringDrag, {
      capture: true,
      passive: false,
    });
    return () => document.removeEventListener("wheel", scrollDuringDrag, true);
  }, [activeDrag]);

  const [pendingFileMove, setPendingFileMove] = useState<{
    fileId: string;
    fileName: string;
    targetFolder: string | null;
    targetLabel: string;
  } | null>(null);
  const [fileMoveDontAskAgain, setFileMoveDontAskAgain] = useState(false);
  const [skipFileMoveConfirmation, setSkipFileMoveConfirmation] = useState(
    () =>
      typeof window !== "undefined" &&
      window.localStorage.getItem(SKIP_FILE_MOVE_CONFIRMATION_STORAGE_KEY) ===
        "true",
  );

  const handleDragStart = useCallback((event: DragStartEvent) => {
    const { type, name } = event.active.data.current as {
      type: "file" | "folder";
      name: string;
    };
    setActiveDrag({ id: event.active.id as string, type, name });
  }, []);

  const [revealMovedPath, setRevealMovedPath] = useState<string | null>(null);

  const moveFileFromDrop = useCallback(
    (fileId: string, targetFolder: string | null) => {
      void moveFile(fileId, targetFolder)
        .then((path) => {
          if (path) setRevealMovedPath(path);
          window.dispatchEvent(new CustomEvent(GIT_STATS_REFRESH_EVENT));
        })
        .catch((err) => {
          log.error("DnD file move failed", { error: String(err) });
          toast.error("Could not move file", { description: String(err) });
        });
    },
    [moveFile],
  );

  const closeFileMoveDialog = useCallback(() => {
    setPendingFileMove(null);
    setFileMoveDontAskAgain(false);
  }, []);

  const confirmPendingFileMove = useCallback(() => {
    const move = pendingFileMove;
    if (!move) return;
    if (fileMoveDontAskAgain) {
      window.localStorage.setItem(
        SKIP_FILE_MOVE_CONFIRMATION_STORAGE_KEY,
        "true",
      );
      setSkipFileMoveConfirmation(true);
    }
    setPendingFileMove(null);
    setFileMoveDontAskAgain(false);
    moveFileFromDrop(move.fileId, move.targetFolder);
  }, [fileMoveDontAskAgain, moveFileFromDrop, pendingFileMove]);

  const handleDragEnd = useCallback(
    async (event: DragEndEvent) => {
      setActiveDrag(null);
      updateMarkdownFileDropCaret(null);
      const { active, over } = event;
      const pointer = event.activatorEvent;
      const draggedFile = useDocumentStore
        .getState()
        .files.find((file) => file.id === active.id);
      if (
        draggedFile &&
        "clientX" in pointer &&
        "clientY" in pointer &&
        insertMarkdownFileLinksAtPoint(
          [draggedFile.absolutePath],
          fileDragPointRef.current ?? {
            x: Number(pointer.clientX) + event.delta.x,
            y: Number(pointer.clientY) + event.delta.y,
          },
        )
      )
        return;
      if (!over) return;

      const draggedPath = active.id as string;
      const draggedType = (active.data.current as { type: string }).type;
      const targetId = over.id as string;
      const targetFolder = targetId === "__root__" ? null : targetId;

      // Don't move if same parent
      const draggedParent = draggedPath.includes("/")
        ? draggedPath.substring(0, draggedPath.lastIndexOf("/"))
        : null;
      if (targetFolder === draggedParent) return;

      // Don't move folder into itself or descendant
      if (draggedType === "folder" && targetFolder) {
        if (
          targetFolder === draggedPath ||
          targetFolder.startsWith(`${draggedPath}/`)
        )
          return;
      }

      try {
        if (draggedType === "file") {
          if (skipFileMoveConfirmation) {
            moveFileFromDrop(draggedPath, targetFolder);
            return;
          }
          const fileName =
            activeDrag?.name ?? draggedPath.split(/[/\\]/).pop() ?? draggedPath;
          setPendingFileMove({
            fileId: draggedPath,
            fileName,
            targetFolder,
            targetLabel: targetFolder ?? "project root",
          });
        } else {
          const path = await moveFolder(draggedPath, targetFolder);
          if (path) setRevealMovedPath(path);
          window.dispatchEvent(new CustomEvent(GIT_STATS_REFRESH_EVENT));
        }
      } catch (err) {
        log.error("DnD move failed", { error: String(err) });
        toast.error("Could not move folder", { description: String(err) });
      }
    },
    [activeDrag?.name, moveFileFromDrop, moveFolder, skipFileMoveConfirmation],
  );

  // Dialog state
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [addDialogFolder, setAddDialogFolder] = useState<string | undefined>();
  const [folderDialogOpen, setFolderDialogOpen] = useState(false);
  const [folderDialogParent, setFolderDialogParent] = useState<
    string | undefined
  >();
  const [renameDialogOpen, setRenameDialogOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<{
    id: string;
    type: "file" | "folder";
  } | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [newFileName, setNewFileName] = useState("");
  const [newFolderName, setNewFolderName] = useState("");

  const gitStatsRefreshKey = useMemo(
    () =>
      files
        .map((file) => `${file.relativePath}:${file.isDirty ? 1 : 0}`)
        .join("|"),
    [files],
  );

  useEffect(() => {
    const onGitStatsRefresh = () => {
      setGitStatsEventTick((prev) => prev + 1);
    };
    window.addEventListener(GIT_STATS_REFRESH_EVENT, onGitStatsRefresh);
    return () => {
      window.removeEventListener(GIT_STATS_REFRESH_EVENT, onGitStatsRefresh);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    if (!projectRoot) {
      setGitLineStatsByPath(new Map());
      setGitIgnoredPaths(new Set());
      return;
    }

    const loadGitLineStats = async () => {
      try {
        const [stats, ignoredPaths] = await Promise.all([
          invoke<GitFileLineStats[]>("git_worktree_file_line_stats", {
            projectRoot,
          }),
          invoke<string[]>("git_ignored_paths", {
            projectRoot,
          }),
        ]);
        if (cancelled) return;

        const next = new Map<string, GitFileLineStats>();
        for (const stat of stats) {
          next.set(stat.file_path, stat);
        }
        setGitLineStatsByPath(next);
        setGitIgnoredPaths(
          new Set(ignoredPaths.map((path) => normalizeGitPath(path))),
        );
      } catch {
        if (!cancelled) {
          setGitLineStatsByPath(new Map());
          setGitIgnoredPaths(new Set());
        }
      }
    };

    void loadGitLineStats();
    return () => {
      cancelled = true;
    };
  }, [gitStatsEventTick, gitStatsRefreshKey, projectRoot]);

  useEffect(() => {
    let cancelled = false;
    if (!projectRoot) return;
    void invoke<ConflictOverview>("git_panel_conflicts", { projectRoot })
      .then((overview) => {
        if (cancelled) return;
        setGitConflicts({
          root: projectRoot,
          paths: new Set(
            overview.files.flatMap((file) =>
              file.document_path ? [normalizeGitPath(file.document_path)] : [],
            ),
          ),
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [gitStatsEventTick, gitStatsRefreshKey, projectRoot]);

  const dirtyTextFiles = useMemo(
    () =>
      files.filter(
        (file) =>
          file.isDirty &&
          typeof file.content === "string" &&
          file.type !== "image" &&
          file.type !== "pdf",
      ),
    [files],
  );

  useEffect(() => {
    let cancelled = false;

    if (!projectRoot) {
      unsavedBaselineByPathRef.current.clear();
      setUnsavedLineStatsByPath(new Map());
      return;
    }

    const dirtyPathSet = new Set(
      dirtyTextFiles.map((file) => file.relativePath),
    );
    for (const path of Array.from(unsavedBaselineByPathRef.current.keys())) {
      if (!dirtyPathSet.has(path)) {
        unsavedBaselineByPathRef.current.delete(path);
      }
    }

    const refreshUnsavedLineStats = async () => {
      const missingBaselineFiles = dirtyTextFiles.filter(
        (file) => !unsavedBaselineByPathRef.current.has(file.relativePath),
      );

      await Promise.all(
        missingBaselineFiles.map(async (file) => {
          try {
            const diskContent = await readTexFileContent(file.absolutePath);
            if (!cancelled) {
              unsavedBaselineByPathRef.current.set(
                file.relativePath,
                diskContent,
              );
            }
          } catch {
            if (!cancelled) {
              unsavedBaselineByPathRef.current.set(file.relativePath, "");
            }
          }
        }),
      );
      if (cancelled) return;

      const next = new Map<string, GitFileLineStats>();
      for (const file of dirtyTextFiles) {
        const baseline = unsavedBaselineByPathRef.current.get(
          file.relativePath,
        );
        if (baseline == null || typeof file.content !== "string") continue;
        const { added, deleted } = computeLineChangeCounts(
          baseline,
          file.content,
        );
        if (added > 0 || deleted > 0) {
          next.set(file.relativePath, {
            file_path: file.relativePath,
            added,
            deleted,
          });
        }
      }
      setUnsavedLineStatsByPath(next);
    };

    void refreshUnsavedLineStats();
    return () => {
      cancelled = true;
    };
  }, [dirtyTextFiles, projectRoot]);

  // Folder expand/collapse
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(
    new Set(),
  );
  const tree = useMemo(() => buildFileTree(files, folders), [files, folders]);
  const [filesStackHeight, setFilesStackHeight] = useState(0);
  const [isFilesCollapsed, setIsFilesCollapsed] = useState(false);
  const [isSessionsCollapsed, setIsSessionsCollapsed] = useState(false);
  const [isSystemPromptsCollapsed, setIsSystemPromptsCollapsed] =
    useState(true);
  const [isFilesOutlineCollapsed, setIsFilesOutlineCollapsed] = useState(false);
  const [isWorkspaceOutlineCollapsed, setIsWorkspaceOutlineCollapsed] =
    useState(true);
  const [isZoteroCollapsed, setIsZoteroCollapsed] = useState(true);
  const [isSectionResizing, setIsSectionResizing] = useState(false);
  const showSessionsMode = Boolean(sessionPanel);
  const isSessionsModeActive = showSessionsMode && contentMode === "sessions";
  const isOutlineCollapsed = isSessionsModeActive
    ? isWorkspaceOutlineCollapsed
    : isFilesOutlineCollapsed;
  const setIsOutlineCollapsed = isSessionsModeActive
    ? setIsWorkspaceOutlineCollapsed
    : setIsFilesOutlineCollapsed;
  const suppressSessionsSection = !isSessionsModeActive;
  const suppressFilesModeSections = isSessionsModeActive;
  const suppressSystemPromptsSection = assistantMode === "artisan";
  const layoutSessionsCollapsed =
    suppressSessionsSection || isSessionsCollapsed;
  const layoutOutlineCollapsed = isOutlineCollapsed;
  const layoutZoteroCollapsed = suppressFilesModeSections || isZoteroCollapsed;
  const layoutSystemPromptsCollapsed =
    suppressSystemPromptsSection || isSystemPromptsCollapsed;

  const getFilesModeStackHeight = useCallback(
    () => filesModeStackRef.current?.clientHeight ?? filesStackHeight,
    [filesStackHeight],
  );

  useEffect(() => {
    const stack = filesModeStackRef.current;
    if (!stack) return;
    const update = () => setFilesStackHeight(stack.clientHeight);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(stack);
    return () => observer.disconnect();
  }, []);

  const {
    height: filesHeight,
    startResize: startFilesResize,
    setHeight: setFilesHeight,
  } = useBottomSectionResize(220, undefined, setIsSectionResizing);

  const filesModePanelOrder = useMemo(
    () => [
      { key: "files", collapsed: isFilesCollapsed },
      { key: "outline", collapsed: layoutOutlineCollapsed },
      { key: "zotero", collapsed: layoutZoteroCollapsed },
      ...(suppressSystemPromptsSection
        ? []
        : [
            {
              key: "system-prompts",
              collapsed: layoutSystemPromptsCollapsed,
            },
          ]),
    ],
    [
      isFilesCollapsed,
      layoutOutlineCollapsed,
      layoutSystemPromptsCollapsed,
      layoutZoteroCollapsed,
      suppressSystemPromptsSection,
    ],
  );
  const filesModePanelHeaderCount = filesModePanelOrder.length;
  const displayedPanelOrder = useMemo(
    () => [
      ...(showSessionsMode
        ? [{ key: "sessions", collapsed: layoutSessionsCollapsed }]
        : []),
      ...filesModePanelOrder,
    ],
    [filesModePanelOrder, layoutSessionsCollapsed, showSessionsMode],
  );
  const firstOpenPanelKey = useMemo(
    () => displayedPanelOrder.find((panel) => !panel.collapsed)?.key ?? null,
    [displayedPanelOrder],
  );

  const getFilesModeDefaultPanelHeight = useCallback(
    () =>
      getDefaultOpenedSectionHeight(
        getFilesModeStackHeight(),
        filesModePanelOrder.filter((panel) => panel.collapsed).length,
      ),
    [filesModePanelOrder, getFilesModeStackHeight],
  );
  const {
    height: outlineHeight,
    startResize: startOutlineResize,
    setHeight: setOutlineHeight,
  } = useBottomSectionResize(
    180,
    () => {
      const stackHeight = getFilesModeStackHeight();
      if (!stackHeight) return {};
      const maxHeight =
        stackHeight -
        SIDEBAR_SECTION_HEADER_HEIGHT * filesModePanelHeaderCount -
        (layoutSystemPromptsCollapsed ? 0 : systemPromptsHeight) -
        (layoutZoteroCollapsed ? 0 : zoteroHeight) -
        (firstOpenPanelKey && firstOpenPanelKey !== "outline"
          ? MIN_PRIMARY_SECTION_HEIGHT
          : 0);
      return {
        min: MIN_BOTTOM_SECTION_HEIGHT,
        max: maxHeight,
      };
    },
    setIsSectionResizing,
  );
  const {
    height: zoteroHeight,
    startResize: startZoteroResize,
    setHeight: setZoteroHeight,
  } = useBottomSectionResize(
    168,
    () => {
      const stackHeight = getFilesModeStackHeight();
      if (!stackHeight) return {};
      const maxHeight =
        stackHeight -
        SIDEBAR_SECTION_HEADER_HEIGHT * filesModePanelHeaderCount -
        (layoutSystemPromptsCollapsed ? 0 : systemPromptsHeight) -
        (layoutOutlineCollapsed ? 0 : outlineHeight) -
        (firstOpenPanelKey && firstOpenPanelKey !== "zotero"
          ? MIN_PRIMARY_SECTION_HEIGHT
          : 0);
      return {
        min: MIN_BOTTOM_SECTION_HEIGHT,
        max: maxHeight,
      };
    },
    setIsSectionResizing,
  );
  const {
    height: systemPromptsHeight,
    startResize: startSystemPromptsResize,
    setHeight: setSystemPromptsHeight,
  } = useBottomSectionResize(
    DEFAULT_SYSTEM_PROMPTS_BODY_HEIGHT,
    () => {
      const stackHeight = getFilesModeStackHeight();
      if (!stackHeight) return {};
      const maxHeight =
        stackHeight -
        SIDEBAR_SECTION_HEADER_HEIGHT * filesModePanelHeaderCount -
        (layoutOutlineCollapsed ? 0 : outlineHeight) -
        (layoutZoteroCollapsed ? 0 : zoteroHeight) -
        (firstOpenPanelKey && firstOpenPanelKey !== "system-prompts"
          ? MIN_PRIMARY_SECTION_HEIGHT
          : 0);
      return {
        min: MIN_BOTTOM_SECTION_HEIGHT,
        max: maxHeight,
      };
    },
    setIsSectionResizing,
  );

  useEffect(() => {
    if (filesModePanelHeightsInitializedRef.current) return;
    const stack = filesModeStackRef.current;
    if (!stack) return;

    let rafId = 0;
    const initializeHeights = () => {
      if (filesModePanelHeightsInitializedRef.current) return;
      const stackHeight = stack.clientHeight;
      if (!stackHeight) return;
      const defaultHeight = getFilesModeDefaultPanelHeight();
      setOutlineHeight(defaultHeight);
      setZoteroHeight(defaultHeight);
      filesModePanelHeightsInitializedRef.current = true;
      observer.disconnect();
    };

    const scheduleInitialization = () => {
      cancelAnimationFrame(rafId);
      rafId = window.requestAnimationFrame(() => {
        rafId = window.requestAnimationFrame(initializeHeights);
      });
    };

    const observer = new ResizeObserver(() => {
      scheduleInitialization();
    });

    observer.observe(stack);
    scheduleInitialization();

    return () => {
      cancelAnimationFrame(rafId);
      observer.disconnect();
    };
  }, [getFilesModeDefaultPanelHeight, setOutlineHeight, setZoteroHeight]);

  useEffect(() => {
    if (isSectionResizing || layoutOutlineCollapsed) return;
    setOutlineHeight(outlineHeight);
  }, [
    filesStackHeight,
    firstOpenPanelKey,
    isSectionResizing,
    layoutOutlineCollapsed,
    outlineHeight,
    setOutlineHeight,
  ]);

  useEffect(() => {
    if (isSectionResizing || layoutZoteroCollapsed) return;
    setZoteroHeight(zoteroHeight);
  }, [
    filesStackHeight,
    firstOpenPanelKey,
    isSectionResizing,
    layoutZoteroCollapsed,
    setZoteroHeight,
    zoteroHeight,
  ]);

  useEffect(() => {
    if (isSectionResizing || layoutSystemPromptsCollapsed) return;
    setSystemPromptsHeight(systemPromptsHeight);
  }, [
    filesStackHeight,
    firstOpenPanelKey,
    isSectionResizing,
    layoutSystemPromptsCollapsed,
    setSystemPromptsHeight,
    systemPromptsHeight,
  ]);

  // Auto-expand parent folders of the active file so it stays visible
  useEffect(() => {
    if (!activeFileId) return;
    const parts = activeFileId.split("/");
    if (parts.length <= 1) return;
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      let changed = false;
      for (let i = 1; i < parts.length; i++) {
        const folder = parts.slice(0, i).join("/");
        if (!next.has(folder)) {
          next.add(folder);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [activeFileId]);

  useEffect(() => {
    if (!projectRoot || !activeFileId) return;
    if (startupScrollSyncedProjectRef.current === projectRoot) return;
    const filesArea = sidebarFilesRef.current;
    if (!filesArea) return;

    const encodedFileId = encodeURIComponent(activeFileId);
    const selector = `[data-sidebar-file-id="${encodedFileId}"]`;
    const scrollActiveRowIntoView = () => {
      const row = filesArea.querySelector<HTMLElement>(selector);
      if (!row) return false;
      window.requestAnimationFrame(() => {
        row.scrollIntoView({ block: "center" });
      });
      startupScrollSyncedProjectRef.current = projectRoot;
      return true;
    };

    let observer: MutationObserver | null = null;
    let rafId = 0;
    let settleTimer = 0;
    let settled = false;
    const startScrollSync = () => {
      rafId = window.requestAnimationFrame(() => {
        if (scrollActiveRowIntoView()) return;
        observer = new MutationObserver(() => {
          if (!scrollActiveRowIntoView()) return;
          observer?.disconnect();
          observer = null;
        });
        observer.observe(filesArea, { childList: true, subtree: true });
      });
    };

    const filesSection = sidebarRef.current?.querySelector<HTMLElement>(
      '[data-sidebar-section="files"]',
    );
    const finishSettle = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(settleTimer);
      startScrollSync();
    };

    if (filesSection) {
      const onTransitionEnd = (event: TransitionEvent) => {
        if (event.target !== filesSection) return;
        if (event.propertyName !== "height") return;
        filesSection.removeEventListener("transitionend", onTransitionEnd);
        finishSettle();
      };
      filesSection.addEventListener("transitionend", onTransitionEnd);
      settleTimer = window.setTimeout(() => {
        filesSection.removeEventListener("transitionend", onTransitionEnd);
        finishSettle();
      }, SIDEBAR_SECTION_TRANSITION_MS + 80);
    } else {
      settleTimer = window.setTimeout(
        finishSettle,
        SIDEBAR_SECTION_TRANSITION_MS + 80,
      );
    }

    return () => {
      window.clearTimeout(settleTimer);
      window.cancelAnimationFrame(rafId);
      observer?.disconnect();
    };
  }, [activeFileId, expandedFolders, files.length, projectRoot]);

  // Reveal the actual destination, including names deduplicated on disk.
  useEffect(() => {
    if (!revealMovedPath) return;
    const parts = revealMovedPath.split("/");
    setExpandedFolders((current) => {
      const next = new Set(current);
      for (let i = 1; i < parts.length; i++) {
        next.add(parts.slice(0, i).join("/"));
      }
      return next;
    });
  }, [revealMovedPath]);

  useEffect(() => {
    if (!revealMovedPath) return;
    const frame = window.requestAnimationFrame(() => {
      const area = sidebarFilesRef.current;
      const row = area?.querySelector<HTMLElement>(
        `[data-sidebar-file-id="${encodeURIComponent(revealMovedPath)}"], ` +
          `[data-sidebar-folder-id="${encodeURIComponent(revealMovedPath)}"]`,
      );
      if (!row) return;
      row.scrollIntoView({ block: "center", behavior: "smooth" });
      setRevealMovedPath(null);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [revealMovedPath, expandedFolders, files, folders]);

  const toggleFolder = useCallback((path: string) => {
    setPasteTargetFolder(path);
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  // Outline
  const activeOutlineIsMarkdown = Boolean(
    activeFile && isMarkdownFile(activeFile),
  );
  const toc = useMemo(
    () =>
      parseDocumentOutline(
        activeFileContent,
        activeOutlineIsMarkdown ? "markdown" : "latex",
      ),
    [activeFileContent, activeOutlineIsMarkdown],
  );
  const [collapsedOutlineHeadings, setCollapsedOutlineHeadings] = useState<
    Set<string>
  >(new Set());
  useEffect(() => {
    setCollapsedOutlineHeadings(new Set());
  }, [activeFileId]);
  const outlineRows = useMemo(() => {
    const rows: Array<
      (typeof toc)[number] & {
        hasChildren: boolean;
        isCollapsed: boolean;
        ancestorLevels: number[];
      }
    > = [];
    const ancestorLevels: number[] = [];
    let hiddenDescendantLevel: number | null = null;
    toc.forEach((item, index) => {
      if (hiddenDescendantLevel !== null) {
        if (item.level > hiddenDescendantLevel) return;
        hiddenDescendantLevel = null;
      }

      const key = `${item.line}:${item.level}:${item.title}`;
      const hasChildren = (toc[index + 1]?.level ?? 0) > item.level;
      const isCollapsed = hasChildren && collapsedOutlineHeadings.has(key);
      while (
        ancestorLevels.length &&
        ancestorLevels[ancestorLevels.length - 1] >= item.level
      ) {
        ancestorLevels.pop();
      }
      rows.push({
        ...item,
        hasChildren,
        isCollapsed,
        ancestorLevels: [...ancestorLevels],
      });
      if (hasChildren && !isCollapsed) ancestorLevels.push(item.level);
      if (isCollapsed) hiddenDescendantLevel = item.level;
    });
    return rows;
  }, [collapsedOutlineHeadings, toc]);
  const outlinePositionIndex = useMemo(
    () => indexOutlinePositions(activeFileContent, outlineRows),
    [activeFileContent, outlineRows],
  );
  // Subscribe to the derived heading, not the cursor, so movement within a section does not rerender the sidebar.
  const currentOutlineLine = useDocumentStore(
    useCallback(
      (state) =>
        state.activeFileId === activeFileId
          ? findCurrentOutlineLine(
              outlinePositionIndex,
              state.outlineScrollPosition ?? state.cursorPosition,
            )
          : null,
      [activeFileId, outlinePositionIndex],
    ),
  );
  const outlineBaseLevel = activeOutlineIsMarkdown
    ? 1
    : Math.min(...toc.map((item) => item.level), 2);
  const toggleOutlineHeading = useCallback((key: string) => {
    setCollapsedOutlineHeadings((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);
  const handleTocClick = useCallback(
    (line: number) => {
      const lines = activeFileContent.split("\n");
      let position = 0;
      for (let i = 0; i < line - 1 && i < lines.length; i++) {
        position += lines[i].length + 1;
      }
      if (onOutlineNavigate) onOutlineNavigate(position);
      else requestJumpToPosition(position);
    },
    [activeFileContent, requestJumpToPosition, onOutlineNavigate],
  );

  const expandedPanelCount = useMemo(
    () => displayedPanelOrder.filter((panel) => !panel.collapsed).length,
    [displayedPanelOrder],
  );

  const canCollapsePanel = useCallback(
    (isCollapsed: boolean) => isCollapsed || expandedPanelCount > 1,
    [expandedPanelCount],
  );

  const isFilesPrimary = firstOpenPanelKey === "files";
  const isOutlinePrimary = firstOpenPanelKey === "outline";
  const isZoteroPrimary = firstOpenPanelKey === "zotero";
  const isSystemPromptsPrimary = firstOpenPanelKey === "system-prompts";
  const sectionTransitionDuration = isSectionResizing
    ? "0ms"
    : `${SIDEBAR_SECTION_TRANSITION_MS}ms`;
  const sectionHeights = useMemo(() => {
    const stackHeight = getFilesModeStackHeight();
    const visibleSessions = showSessionsMode && isSessionsModeActive;

    const sessionsBaseHeight = !visibleSessions
      ? 0
      : isSessionsCollapsed
        ? SIDEBAR_SECTION_HEADER_HEIGHT
        : 0;
    const filesBaseHeight = isFilesCollapsed
      ? SIDEBAR_SECTION_HEADER_HEIGHT
      : isFilesPrimary
        ? 0
        : filesHeight + SIDEBAR_SECTION_HEADER_HEIGHT;
    const outlineBaseHeight = isOutlineCollapsed
      ? SIDEBAR_SECTION_HEADER_HEIGHT
      : isOutlinePrimary
        ? 0
        : outlineHeight + SIDEBAR_SECTION_HEADER_HEIGHT;
    const zoteroBaseHeight = suppressFilesModeSections
      ? 0
      : isZoteroCollapsed
        ? SIDEBAR_SECTION_HEADER_HEIGHT
        : isZoteroPrimary
          ? 0
          : zoteroHeight + SIDEBAR_SECTION_HEADER_HEIGHT;
    const systemPromptsBaseHeight = suppressSystemPromptsSection
      ? 0
      : isSystemPromptsCollapsed
        ? SIDEBAR_SECTION_HEADER_HEIGHT
        : isSystemPromptsPrimary
          ? 0
          : systemPromptsHeight + SIDEBAR_SECTION_HEADER_HEIGHT;

    const primaryKey = firstOpenPanelKey;
    const baseHeights: Record<string, number> = {
      sessions: sessionsBaseHeight,
      files: filesBaseHeight,
      outline: outlineBaseHeight,
      zotero: zoteroBaseHeight,
      environment: 0,
      "system-prompts": systemPromptsBaseHeight,
    };

    if (
      stackHeight > 0 &&
      primaryKey &&
      Object.prototype.hasOwnProperty.call(baseHeights, primaryKey)
    ) {
      const usedHeight = Object.entries(baseHeights).reduce(
        (sum, [key, value]) => (key === primaryKey ? sum : sum + value),
        0,
      );
      // Reserve room for the primary panel when fixed controls reduce the stack.
      const primaryMinimum = SIDEBAR_SECTION_HEADER_HEIGHT + 64;
      const deficit = Math.max(0, usedHeight + primaryMinimum - stackHeight);
      const flexibleHeight = Object.entries(baseHeights).reduce(
        (sum, [key, value]) =>
          key === primaryKey
            ? sum
            : sum + Math.max(0, value - SIDEBAR_SECTION_HEADER_HEIGHT),
        0,
      );
      if (deficit > 0 && flexibleHeight > 0) {
        const fraction = Math.min(1, deficit / flexibleHeight);
        for (const key of Object.keys(baseHeights)) {
          if (key !== primaryKey)
            baseHeights[key] -=
              Math.max(0, baseHeights[key] - SIDEBAR_SECTION_HEADER_HEIGHT) *
              fraction;
        }
      }
      const remainingUsedHeight = Object.entries(baseHeights).reduce(
        (sum, [key, value]) => (key === primaryKey ? sum : sum + value),
        0,
      );
      baseHeights[primaryKey] = Math.max(0, stackHeight - remainingUsedHeight);
    }

    return baseHeights;
  }, [
    filesHeight,
    firstOpenPanelKey,
    getFilesModeStackHeight,
    isFilesCollapsed,
    isFilesPrimary,
    isOutlineCollapsed,
    isOutlinePrimary,
    isSessionsCollapsed,
    isSessionsModeActive,
    isSystemPromptsCollapsed,
    isSystemPromptsPrimary,
    isZoteroCollapsed,
    isZoteroPrimary,
    outlineHeight,
    showSessionsMode,
    suppressSystemPromptsSection,
    systemPromptsHeight,
    zoteroHeight,
  ]);

  const toggleFilesPanel = useCallback(() => {
    setIsFilesCollapsed((value) => (canCollapsePanel(value) ? !value : value));
  }, [canCollapsePanel]);

  const toggleSessionsPanel = useCallback(() => {
    setIsSessionsCollapsed((value) =>
      canCollapsePanel(value) ? !value : value,
    );
  }, [canCollapsePanel]);

  const toggleHandOffFilesPanel = useCallback(() => {
    setIsFilesCollapsed((value) => (canCollapsePanel(value) ? !value : value));
  }, [canCollapsePanel]);

  const toggleOutlinePanel = useCallback(() => {
    setIsOutlineCollapsed((value) =>
      canCollapsePanel(value) ? !value : value,
    );
  }, [canCollapsePanel, setIsOutlineCollapsed]);

  const toggleZoteroPanel = useCallback(() => {
    setIsZoteroCollapsed((value) => (canCollapsePanel(value) ? !value : value));
  }, [canCollapsePanel]);

  const toggleSystemPromptsPanel = useCallback(() => {
    setIsSystemPromptsCollapsed((value) =>
      canCollapsePanel(value) ? !value : value,
    );
  }, [canCollapsePanel]);

  // Check if a name already exists in the given folder
  // Case-insensitive on macOS/Windows (default case-insensitive filesystems)
  const isCaseInsensitiveFs =
    navigator.platform.startsWith("Mac") ||
    navigator.platform.startsWith("Win");
  const nameExistsIn = useCallback(
    (name: string, folder?: string) => {
      const targetPath = folder ? `${folder}/${name}` : name;
      const cmp = (a: string, b: string) =>
        isCaseInsensitiveFs ? a.toLowerCase() === b.toLowerCase() : a === b;
      const existsAsFile = files.some((f) => cmp(f.relativePath, targetPath));
      const existsAsFolder = folders.some((f) => cmp(f, targetPath));
      return existsAsFile || existsAsFolder;
    },
    [files, folders, isCaseInsensitiveFs],
  );

  // Handlers
  const [nameError, setNameError] = useState("");

  const handleAddFile = () => {
    const name = newFileName.trim();
    if (!name) return;
    if (nameExistsIn(name, addDialogFolder)) {
      setNameError("A file or folder with this name already exists");
      return;
    }
    // Auto-append .tex if no extension provided
    const finalName = /\.\w+$/.test(name) ? name : `${name}.tex`;
    const lower = finalName.toLowerCase();
    const type = /\.(png|jpg|jpeg|gif|svg|bmp|webp)$/.test(lower)
      ? "image"
      : isMarkdownPath(lower)
        ? "other"
        : "tex";
    createNewFile(finalName, type, addDialogFolder);
    setNewFileName("");
    setNameError("");
    setAddDialogOpen(false);
    setAddDialogFolder(undefined);
  };

  const handleCreateFolder = () => {
    const name = newFolderName.trim();
    if (!name) return;
    if (nameExistsIn(name, folderDialogParent)) {
      setNameError("A file or folder with this name already exists");
      return;
    }
    createFolder(name, folderDialogParent);
    setNewFolderName("");
    setNameError("");
    setFolderDialogOpen(false);
    setFolderDialogParent(undefined);
  };

  const handleImport = async (targetFolder?: string) => {
    const selected = await openDialog({
      multiple: true,
      filters: [
        {
          name: "All Files",
          extensions: [
            "tex",
            "bib",
            "sty",
            "cls",
            "bst",
            "png",
            "jpg",
            "jpeg",
            "gif",
            "svg",
            "bmp",
            "webp",
            "pdf",
            "txt",
            "md",
          ],
        },
      ],
    });
    if (selected && projectRoot) {
      const paths = Array.isArray(selected) ? selected : [selected];
      await importFiles(paths, targetFolder);
    }
  };

  const openRenameDialog = (
    id: string,
    name: string,
    type: "file" | "folder" = "file",
  ) => {
    setRenameTarget({ id, type });
    setRenameValue(name);
    setNameError("");
    setRenameDialogOpen(true);
  };

  const closeRenameDialog = () => {
    setRenameDialogOpen(false);
    setRenameTarget(null);
    setRenameValue("");
    setNameError("");
  };

  const handleRename = async () => {
    const name = renameValue.trim();
    if (!renameTarget || !name) return;
    const file =
      renameTarget.type === "file"
        ? files.find((f) => f.id === renameTarget.id)
        : undefined;
    const parentFolder =
      renameTarget.type === "folder"
        ? renameTarget.id.includes("/")
          ? renameTarget.id.substring(0, renameTarget.id.lastIndexOf("/"))
          : undefined
        : file?.relativePath.includes("/")
          ? file.relativePath.substring(0, file.relativePath.lastIndexOf("/"))
          : undefined;
    const currentName =
      renameTarget.type === "folder"
        ? (renameTarget.id.split(/[/\\]/).pop() ?? renameTarget.id)
        : file?.name;
    const isSameName = isCaseInsensitiveFs
      ? name.toLowerCase() === currentName?.toLowerCase()
      : name === currentName;
    if (nameExistsIn(name, parentFolder) && !isSameName) {
      setNameError("A file or folder with this name already exists");
      return;
    }
    if (renameTarget.type === "folder") {
      const oldFolderPath = renameTarget.id;
      const newFolderPath = await renameFolder(oldFolderPath, name);
      if (!newFolderPath) return;
      const remapPath = (path: string) => {
        if (path === oldFolderPath) return newFolderPath;
        const prefix = `${oldFolderPath}/`;
        if (!path.startsWith(prefix)) return path;
        return `${newFolderPath}/${path.slice(prefix.length)}`;
      };
      setExpandedFolders((previous) => {
        const next = new Set<string>();
        previous.forEach((folderPath) => {
          next.add(remapPath(folderPath));
        });
        return next;
      });
      setPasteTargetFolder((previous) =>
        previous ? remapPath(previous) : previous,
      );
    } else {
      renameFile(renameTarget.id, name);
    }
    closeRenameDialog();
  };

  const openNewFileDialog = (folder?: string) => {
    setAddDialogFolder(folder);
    setNewFileName("");
    setNameError("");
    setAddDialogOpen(true);
  };

  const newFileAction = useAppAction({
    id: "new-file",
    label: "New File",
    enabled: !!projectRoot && !disableInteractiveIntegrations,
    run: () => openNewFileDialog(),
    menu: { group: "File", section: 0, order: 0 },
  });

  const openNewFolderDialog = (parent?: string) => {
    setFolderDialogParent(parent);
    setNewFolderName("");
    setNameError("");
    setFolderDialogOpen(true);
  };

  const staticFileTextClassName = (file: ProjectFile) => {
    const isConflicted = gitConflictPaths.has(
      normalizeGitPath(file.relativePath),
    );
    const isPendingAIReview = pendingReviewFilePaths.has(
      normalizeGitPath(file.relativePath),
    );
    return isConflicted
      ? CONFLICT_TEXT_CLASS
      : isPendingAIReview
        ? PENDING_AI_REVIEW_TEXT_CLASS
        : isIgnoredFilePath(file.relativePath, gitIgnoredPaths)
          ? "text-muted-foreground"
          : undefined;
  };

  const staticFileRowProps = (file: ProjectFile) => {
    const isConflicted = gitConflictPaths.has(
      normalizeGitPath(file.relativePath),
    );
    const isPendingAIReview = pendingReviewFilePaths.has(
      normalizeGitPath(file.relativePath),
    );
    return {
      "data-pending-ai-review": isPendingAIReview ? "true" : undefined,
      "data-git-conflicted": isConflicted ? "true" : undefined,
      title: isConflicted
        ? "Unresolved Git conflict"
        : isPendingAIReview
          ? "Awaiting AI review"
          : undefined,
      className:
        file.id === activeFileId
          ? isConflicted
            ? CONFLICT_SELECTED_CLASS
            : isPendingAIReview
              ? PENDING_AI_REVIEW_SELECTED_CLASS
              : undefined
          : undefined,
    };
  };

  const renderStaticFileBadge = (file: ProjectFile) => {
    const lineStats =
      gitLineStatsByPath.get(file.relativePath) ??
      unsavedLineStatsByPath.get(file.relativePath);
    const isConflicted = gitConflictPaths.has(
      normalizeGitPath(file.relativePath),
    );
    return (
      <>
        <FileStatus
          fileId={file.id}
          commentCounts={commentCountsByPath.get(file.relativePath)}
        />
        {lineStats?.added ? (
          <span className="font-mono text-[11px] text-green-600">
            +{lineStats.added}
          </span>
        ) : null}
        {lineStats?.deleted ? (
          <span className="font-mono text-[11px] text-red-600">
            -{lineStats.deleted}
          </span>
        ) : null}
        {isConflicted ? (
          <GitMergeIcon
            aria-label="Unresolved Git conflict"
            className={cn("size-2.5 shrink-0", CONFLICT_TEXT_CLASS)}
          />
        ) : null}
        {file.isDirty ? (
          <Hint content="Modified">
            <span className="size-2 rounded-full bg-blue-500" />
          </Hint>
        ) : null}
      </>
    );
  };

  const renderFilesSection = ({
    collapsible = false,
    collapsed = false,
    className,
    onToggleCollapse,
    showTopBorder = true,
  }: {
    collapsible?: boolean;
    collapsed?: boolean;
    className?: string;
    onToggleCollapse?: () => void;
    showTopBorder?: boolean;
  }) => (
    <div
      className={cn(
        "flex min-h-0 flex-col",
        !collapsible && "h-full flex-1 overflow-hidden",
        className,
        collapsible && showTopBorder && "border-sidebar-border border-t",
      )}
    >
      <SidebarSectionHeader
        section="files"
        wideActions
        title="Files"
        icon={<FolderIcon className="size-3.5" />}
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
                onClick={async () => {
                  const root = projectRoot;
                  await refreshFiles();
                  window.dispatchEvent(
                    new CustomEvent(PROJECT_COMMENTS_REFRESH_EVENT, {
                      detail: { projectRoot: root },
                    }),
                  );
                }}
              >
                <RefreshCwIcon className="size-3" />
              </Button>
            </Hint>
            <DropdownMenu>
              <Hint content="Add">
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-5"
                    aria-label="Add"
                  >
                    <PlusIcon className="size-3" />
                  </Button>
                </DropdownMenuTrigger>
              </Hint>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={newFileAction.run}>
                  <FileTextIcon className="mr-2 size-4" />
                  {newFileAction.label}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => openNewFolderDialog()}>
                  <FolderPlusIcon className="mr-2 size-4" />
                  New Folder
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => handleImport()}>
                  <UploadIcon className="mr-2 size-4" />
                  Import File
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        }
      />
      <CollapsibleSectionBody
        expanded={!collapsed}
        className={!collapsed ? "flex-1" : undefined}
      >
        <div
          ref={sidebarFilesRef}
          className="flex h-full min-h-0 flex-col overflow-hidden"
          data-sidebar-files
        >
          {disableInteractiveIntegrations ? (
            <SidebarSectionBody className="app-scrollbar min-h-0 flex-1 overflow-y-auto">
              <SidebarFileTree
                tree={tree}
                activeFileId={activeFileId}
                expandedFolders={expandedFolders}
                onToggleFolder={toggleFolder}
                onSelectFile={setActiveFile}
                onOpenFileInBackground={
                  useDocumentStore.getState().openFileInBackground
                }
                fileRowProps={staticFileRowProps}
                fileTextClassName={staticFileTextClassName}
                folderTextClassName={(node) =>
                  isIgnoredFolderPath(node, gitIgnoredPaths)
                    ? "text-muted-foreground"
                    : undefined
                }
                renderFileBadge={renderStaticFileBadge}
              />
            </SidebarSectionBody>
          ) : (
            <DndContext
              sensors={sensors}
              collisionDetection={fileTreeCollisionDetection}
              onDragCancel={() => setActiveDrag(null)}
              onDragStart={handleDragStart}
              onDragEnd={handleDragEnd}
            >
              <ContextMenu>
                <ContextMenuTrigger asChild>
                  <DroppableRoot nativeDragOver={nativeDragOver === "__root__"}>
                    {tree.map((node) => (
                      <FileTreeNode
                        key={node.relativePath}
                        node={node}
                        depth={0}
                        activeFileId={activeFileId}
                        expandedFolders={expandedFolders}
                        onToggleFolder={toggleFolder}
                        onSelectFile={(id: string) => {
                          const parent = id.includes("/")
                            ? id.substring(0, id.lastIndexOf("/"))
                            : undefined;
                          setPasteTargetFolder(parent);
                          setActiveFile(id);
                        }}
                        onNewFile={openNewFileDialog}
                        onNewFolder={openNewFolderDialog}
                        onImport={handleImport}
                        onRename={openRenameDialog}
                        onDelete={deleteFile}
                        onDeleteFolder={deleteFolder}
                        aiEnabled={assistantMode !== "artisan"}
                        fileCount={files.length}
                        gitIgnoredPaths={gitIgnoredPaths}
                        gitConflictPaths={gitConflictPaths}
                        gitLineStatsByPath={gitLineStatsByPath}
                        commentCountsByPath={commentCountsByPath}
                        pendingReviewFilePaths={pendingReviewFilePaths}
                        unsavedLineStatsByPath={unsavedLineStatsByPath}
                        nativeDragOver={nativeDragOver}
                      />
                    ))}
                  </DroppableRoot>
                </ContextMenuTrigger>
                <ContextMenuContent>
                  <ContextMenuItem onClick={newFileAction.run}>
                    <FileTextIcon className="mr-2 size-4" />
                    {newFileAction.label}
                  </ContextMenuItem>
                  <ContextMenuItem onClick={() => openNewFolderDialog()}>
                    <FolderPlusIcon className="mr-2 size-4" />
                    New Folder
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem onClick={() => handleImport()}>
                    <UploadIcon className="mr-2 size-4" />
                    Import File
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
              <DragOverlay
                dropAnimation={null}
                style={{ pointerEvents: "none" }}
              >
                {activeDrag && !fileDragOverEditor && (
                  <div className="flex items-center gap-2 rounded-md bg-sidebar px-2 py-1 text-sm shadow-lg ring-1 ring-ring">
                    {activeDrag.type === "folder" ? (
                      <FolderIcon className="size-4 shrink-0" />
                    ) : (
                      <FileTextIcon className="size-4 shrink-0" />
                    )}
                    <span className="truncate">{activeDrag.name}</span>
                  </div>
                )}
              </DragOverlay>
            </DndContext>
          )}
        </div>
      </CollapsibleSectionBody>
    </div>
  );

  // ─── Render ───

  return (
    <div
      ref={sidebarRef}
      data-workspace-assistant-mode={assistantMode}
      className="flex h-full flex-col bg-background text-sidebar-foreground"
    >
      <TrafficLightSafeHeader trafficLightInset={trafficLightInset}>
        <div className="-ml-1 flex shrink-0 items-center gap-0.5">
          {showHeaderActions ? (
            <>
              <Hint content="Close project">
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-6"
                  onClick={onCloseProject}
                  aria-label="Close project"
                >
                  <HomeIcon className="size-3.5" />
                </Button>
              </Hint>
              <Hint content="Hide sidebar">
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-6"
                  onClick={onToggleSidebar}
                  aria-label="Hide sidebar"
                >
                  <SidebarIcon className="size-3.5" />
                </Button>
              </Hint>
              <ExternalAppSelector size="compact" />
            </>
          ) : null}
        </div>
      </TrafficLightSafeHeader>

      <div className="shrink-0 py-1.5">
        <AssistantModeSwitch
          assistantMode={assistantMode}
          onAssistantModeChange={onAssistantModeChange}
        />
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div
          ref={filesModeStackRef}
          data-sidebar-content-stack={
            isSessionsModeActive ? "sessions" : "files"
          }
          data-sidebar-content-active="true"
          className="flex min-h-0 flex-1 flex-col overflow-hidden"
        >
          {showSessionsMode ? (
            <div
              data-sidebar-section="sessions"
              inert={suppressSessionsSection}
              className="relative shrink-0 overflow-hidden border-sidebar-border transition-[height] ease-out"
              style={{
                height: `${sectionHeights.sessions}px`,
                transitionDuration: sectionTransitionDuration,
              }}
            >
              <SessionListPanel
                className="h-full min-h-0 overflow-hidden"
                collapsible
                collapsed={isSessionsCollapsed}
                onToggleCollapse={toggleSessionsPanel}
                active={isSessionsModeActive}
              />
            </div>
          ) : null}

          <div
            data-sidebar-section="files"
            className={cn(
              "relative min-h-0 transition-[height] ease-out",
              "shrink-0",
            )}
            style={{
              height: `${sectionHeights.files}px`,
              transitionDuration: sectionTransitionDuration,
            }}
          >
            {!isFilesCollapsed && !isFilesPrimary ? (
              <Hint content="Resize Files">
                <div
                  className="absolute inset-x-0 -top-1 z-10 h-2 cursor-row-resize"
                  onPointerDown={startFilesResize}
                />
              </Hint>
            ) : null}
            {renderFilesSection({
              collapsible: true,
              collapsed: isFilesCollapsed,
              onToggleCollapse: isSessionsModeActive
                ? toggleHandOffFilesPanel
                : toggleFilesPanel,
              showTopBorder: isSessionsModeActive,
              className: isFilesCollapsed ? undefined : "h-full",
            })}
          </div>

          <div
            data-sidebar-section="outline"
            className={cn(
              "relative flex flex-col overflow-hidden transition-[height] ease-out",
              sectionHeights.outline > 0 && "border-sidebar-border border-t",
              "shrink-0",
            )}
            style={{
              height: `${sectionHeights.outline}px`,
              transitionDuration: sectionTransitionDuration,
            }}
          >
            {!layoutOutlineCollapsed && !isOutlinePrimary && (
              <Hint content="Resize Outline">
                <div
                  className="absolute inset-x-0 -top-1 z-10 h-2 cursor-row-resize"
                  onPointerDown={startOutlineResize}
                />
              </Hint>
            )}
            <SidebarSectionHeader
              section="outline"
              title="Outline"
              icon={<ListIcon className="size-3.5" />}
              collapsed={isOutlineCollapsed}
              onToggle={toggleOutlinePanel}
            />
            <CollapsibleSectionBody
              expanded={!isOutlineCollapsed}
              className="min-h-0 flex-1"
            >
              <div className="h-full min-h-0">
                <SidebarSectionBody className="app-scrollbar h-full overflow-y-auto">
                  {toc.length > 0 ? (
                    outlineRows.map((item, index) => {
                      const key = `${item.line}:${item.level}:${item.title}`;
                      const marker = activeOutlineIsMarkdown
                        ? `H${item.level}`
                        : item.number;
                      const markerContent = (
                        <SidebarFittedMarker
                          text={marker}
                          width={activeOutlineIsMarkdown ? 16 : 20}
                        />
                      );
                      return (
                        <SidebarRow
                          asChild
                          depth={item.level - outlineBaseLevel}
                          key={key}
                          className="gap-0 py-0 pr-0 hover:bg-transparent"
                        >
                          <div className="group relative">
                            <span
                              aria-hidden="true"
                              className="pointer-events-none absolute inset-0"
                            >
                              {item.ancestorLevels.map((level) => (
                                <SidebarTreeGuide
                                  key={level}
                                  data-outline-guide={level}
                                  depth={level - outlineBaseLevel}
                                  top={
                                    outlineRows[index - 1]?.level === level
                                      ? SIDEBAR_GUIDE_CHILD_TOP
                                      : 0
                                  }
                                  bottom={
                                    (outlineRows[index + 1]?.level ?? 0) <=
                                    level
                                      ? SIDEBAR_GUIDE_BOTTOM
                                      : 0
                                  }
                                />
                              ))}
                              {item.hasChildren && !item.isCollapsed && (
                                <SidebarTreeGuide
                                  data-outline-guide-start={item.level}
                                  depth={item.level - outlineBaseLevel}
                                  top="100%"
                                  bottom={0}
                                />
                              )}
                            </span>
                            <span className="-ml-1 flex w-6 shrink-0 items-center font-mono text-[10px] text-muted-foreground">
                              {item.hasChildren ? (
                                <Hint
                                  content={`${marker} — ${item.isCollapsed ? "Expand" : "Collapse"} ${item.title}`}
                                >
                                  <button
                                    type="button"
                                    className="flex h-5 w-6 items-center rounded transition-colors hover:bg-sidebar-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring aria-[expanded=false]:bg-sidebar-accent aria-[expanded=false]:font-semibold aria-[expanded=false]:text-foreground"
                                    style={{
                                      paddingInline: activeOutlineIsMarkdown
                                        ? 4
                                        : 2,
                                    }}
                                    aria-label={`${item.isCollapsed ? "Expand" : "Collapse"} ${item.title}`}
                                    aria-expanded={!item.isCollapsed}
                                    onClick={() => toggleOutlineHeading(key)}
                                  >
                                    {markerContent}
                                  </button>
                                </Hint>
                              ) : (
                                <Hint content={marker}>
                                  <span
                                    style={{
                                      paddingInline: activeOutlineIsMarkdown
                                        ? 4
                                        : 2,
                                    }}
                                  >
                                    {markerContent}
                                  </span>
                                </Hint>
                              )}
                            </span>
                            <button
                              type="button"
                              data-outline-level={item.level}
                              data-outline-line={item.line}
                              aria-current={
                                item.line === currentOutlineLine
                                  ? "location"
                                  : undefined
                              }
                              className={cn(
                                "min-w-0 flex-1 truncate rounded-md py-1.5 pr-2 text-left text-sm transition-colors hover:bg-sidebar-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring",
                                activeOutlineIsMarkdown
                                  ? "pl-2"
                                  : "ml-0.5 pl-1.5",
                                item.line === currentOutlineLine &&
                                  "bg-sidebar-accent text-sidebar-accent-foreground hover:bg-sidebar-accent",
                              )}
                              onClick={() => handleTocClick(item.line)}
                            >
                              {item.title}
                            </button>
                          </div>
                        </SidebarRow>
                      );
                    })
                  ) : (
                    <div className="px-2 py-1 text-muted-foreground text-xs">
                      No sections found
                    </div>
                  )}
                </SidebarSectionBody>
              </div>
            </CollapsibleSectionBody>
          </div>

          <div
            data-sidebar-section="zotero"
            inert={suppressFilesModeSections}
            className={cn(
              "relative flex flex-col overflow-hidden transition-[height] ease-out",
              sectionHeights.zotero > 0 && "border-sidebar-border border-t",
              "shrink-0",
            )}
            style={{
              height: `${sectionHeights.zotero}px`,
              transitionDuration: sectionTransitionDuration,
            }}
          >
            {!layoutZoteroCollapsed && !isZoteroPrimary && (
              <Hint content="Resize Zotero">
                <div
                  className="absolute inset-x-0 -top-1 z-10 h-2 cursor-row-resize"
                  onPointerDown={startZoteroResize}
                />
              </Hint>
            )}
            <SidebarSectionHeader
              section="zotero"
              wideActions
              title="Zotero"
              label={isZoteroCollapsed ? "Expand Zotero" : "Collapse Zotero"}
              icon={
                <span
                  className={cn(
                    "size-1.5 rounded-full",
                    zoteroAuthenticated
                      ? "bg-foreground"
                      : "bg-muted-foreground/30",
                  )}
                />
              }
              collapsed={isZoteroCollapsed}
              onToggle={toggleZoteroPanel}
              actions={
                zoteroAuthenticated && !isZoteroCollapsed ? (
                  <>
                    <Hint content="Refresh">
                      <button
                        className="rounded p-1 text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground"
                        onClick={(e) => {
                          e.stopPropagation();
                          zoteroLoadCollections();
                        }}
                        aria-label="Refresh"
                      >
                        <RefreshCwIcon
                          className={cn(
                            "size-3.5",
                            zoteroLoadingCollections && "animate-spin",
                          )}
                        />
                      </button>
                    </Hint>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button
                          className="rounded p-1 text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <SettingsIcon className="size-3.5" />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="start" className="w-44">
                        <div className="flex items-center gap-2 px-2 py-1">
                          <UserIcon className="size-3.5 text-muted-foreground" />
                          <span className="truncate text-muted-foreground text-xs">
                            {zoteroUsername}
                          </span>
                        </div>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onClick={zoteroDisconnect}>
                          <LogOutIcon className="mr-2 size-3.5" />
                          Disconnect
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </>
                ) : null
              }
            />
            <CollapsibleSectionBody
              expanded={!isZoteroCollapsed}
              className="min-h-0 flex-1"
            >
              <div className="h-full min-h-0">
                <div className="h-full overflow-hidden">
                  <ZoteroPanel />
                </div>
              </div>
            </CollapsibleSectionBody>
          </div>

          {!suppressSystemPromptsSection && (
            <div
              data-sidebar-section="system-prompts"
              inert={suppressSystemPromptsSection}
              className={cn(
                "relative overflow-hidden transition-[height] ease-out",
                "shrink-0",
              )}
              style={{
                height: `${sectionHeights["system-prompts"]}px`,
                transitionDuration: sectionTransitionDuration,
              }}
            >
              {!layoutSystemPromptsCollapsed && !isSystemPromptsPrimary && (
                <Hint content="Resize System Prompts">
                  <div
                    className="absolute inset-x-0 -top-1 z-10 h-2 cursor-row-resize"
                    onPointerDown={startSystemPromptsResize}
                  />
                </Hint>
              )}
              <SystemPromptsSection
                isCollapsed={isSystemPromptsCollapsed}
                onToggle={toggleSystemPromptsPanel}
                fillAvailableSpace={isSystemPromptsPrimary}
                showTopBorder={sectionHeights["system-prompts"] > 0}
              />
            </div>
          )}
        </div>
        <CommentVisibilitySection />
      </div>

      {/* Footer */}
      <SidebarUtilityControls />

      {/* File Move Confirmation Dialog */}
      <Dialog
        open={pendingFileMove !== null}
        onOpenChange={(open) => {
          if (!open) closeFileMoveDialog();
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-left text-lg leading-tight">
              {`Are you sure you want to move '${pendingFileMove?.fileName ?? ""}' into '${pendingFileMove?.targetLabel ?? ""}'?`}
            </DialogTitle>
          </DialogHeader>
          <label className="flex items-center gap-3 py-2 font-medium text-sm">
            <input
              type="checkbox"
              checked={fileMoveDontAskAgain}
              onChange={(event) =>
                setFileMoveDontAskAgain(event.currentTarget.checked)
              }
              className="size-4 rounded border-border accent-primary"
            />
            Do not ask me again
          </label>
          <DialogFooter>
            <Button variant="outline" onClick={closeFileMoveDialog}>
              Cancel
            </Button>
            <Button onClick={confirmPendingFileMove}>Move</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* New File Dialog */}
      <Dialog open={addDialogOpen} onOpenChange={setAddDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              New File{addDialogFolder ? ` in ${addDialogFolder}` : ""}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-2 py-4">
            <Input
              placeholder="filename.tex or README.md"
              value={newFileName}
              onChange={(e) => {
                setNewFileName(e.target.value);
                setNameError("");
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleAddFile();
              }}
              autoFocus
            />
            {nameError && (
              <p className="text-destructive text-xs">{nameError}</p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleAddFile} disabled={!newFileName.trim()}>
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* New Folder Dialog */}
      <Dialog open={folderDialogOpen} onOpenChange={setFolderDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              New Folder{folderDialogParent ? ` in ${folderDialogParent}` : ""}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-2 py-4">
            <Input
              placeholder="folder name"
              value={newFolderName}
              onChange={(e) => {
                setNewFolderName(e.target.value);
                setNameError("");
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleCreateFolder();
              }}
              autoFocus
            />
            {nameError && (
              <p className="text-destructive text-xs">{nameError}</p>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setFolderDialogOpen(false)}
            >
              Cancel
            </Button>
            <Button
              onClick={handleCreateFolder}
              disabled={!newFolderName.trim()}
            >
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Rename Dialog */}
      <Dialog open={renameDialogOpen} onOpenChange={setRenameDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Rename</DialogTitle>
          </DialogHeader>
          <div className="space-y-2 py-4">
            <Input
              value={renameValue}
              onChange={(e) => {
                setRenameValue(e.target.value);
                setNameError("");
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void handleRename();
                }
              }}
              autoFocus
            />
            {nameError && (
              <p className="text-destructive text-xs">{nameError}</p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={closeRenameDialog}>
              Cancel
            </Button>
            <Button onClick={() => void handleRename()}>Rename</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── File Tree Node ───

// ─── dnd-kit helpers ───

function DroppableRoot({
  children,
  nativeDragOver,
}: {
  children: React.ReactNode;
  nativeDragOver?: boolean;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: "__root__" });
  return (
    <SidebarSectionBody
      ref={setNodeRef}
      data-drop-folder="__root__"
      className={cn(
        "app-scrollbar min-h-0 flex-1 overflow-y-auto",
        (isOver || nativeDragOver) && DROP_TARGET_HIGHLIGHT_CLASS,
      )}
    >
      {children}
    </SidebarSectionBody>
  );
}

function DroppableFolder({
  id,
  children,
  nativeDragOver,
}: {
  id: string;
  children: React.ReactNode;
  nativeDragOver?: boolean;
}) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <div
      ref={setNodeRef}
      data-drop-folder={id}
      className={cn(
        "relative",
        (isOver || nativeDragOver) &&
          `rounded-md ${DROP_TARGET_HIGHLIGHT_CLASS}`,
      )}
    >
      {children}
    </div>
  );
}

// ─── File Tree Node ───

interface FileTreeNodeProps {
  node: TreeNode;
  depth: number;
  activeFileId: string;
  expandedFolders: Set<string>;
  onToggleFolder: (path: string) => void;
  onSelectFile: (id: string) => void;
  onNewFile: (folder?: string) => void;
  onNewFolder: (parent?: string) => void;
  onImport: (folder?: string) => void;
  onRename: (id: string, name: string, type: "file" | "folder") => void;
  onDelete: (id: string) => void;
  onDeleteFolder: (folderPath: string) => void;
  aiEnabled: boolean;
  fileCount: number;
  gitIgnoredPaths: Set<string>;
  gitConflictPaths: ReadonlySet<string>;
  gitLineStatsByPath: Map<string, GitFileLineStats>;
  commentCountsByPath: ReadonlyMap<string, FileCommentCounts>;
  pendingReviewFilePaths: ReadonlySet<string>;
  unsavedLineStatsByPath: Map<string, GitFileLineStats>;
  nativeDragOver?: string | null;
}

function TrashMenuLabel() {
  return (
    <>
      <span className="trash-menu-label" aria-hidden="true">
        <Trash2Icon className="mr-2 size-4 text-destructive" />
        Move to Trash
      </span>
      <span className="trash-menu-confirmation" aria-hidden="true">
        <Trash2Icon className="mr-2 size-4 text-white" />
        Confirm
      </span>
    </>
  );
}

function FileTreeNode({
  node,
  depth,
  activeFileId,
  expandedFolders,
  onToggleFolder,
  onSelectFile,
  onNewFile,
  onNewFolder,
  onImport,
  onRename,
  onDelete,
  onDeleteFolder,
  aiEnabled,
  fileCount,
  gitIgnoredPaths,
  gitConflictPaths,
  gitLineStatsByPath,
  commentCountsByPath,
  pendingReviewFilePaths,
  unsavedLineStatsByPath,
  nativeDragOver,
}: FileTreeNodeProps) {
  const isExpanded = expandedFolders.has(node.relativePath);
  const [folderAddMenuOpen, setFolderAddMenuOpen] = useState(false);
  const [confirmTrash, setConfirmTrash] = useState(false);
  const [chatMenuOpen, setChatMenuOpen] = useState(false);

  if (node.type === "folder") {
    const isIgnored = isIgnoredFolderPath(node, gitIgnoredPaths);
    return (
      <DroppableFolder
        id={node.relativePath}
        nativeDragOver={nativeDragOver === node.relativePath}
      >
        {isExpanded && node.children.length > 0 && (
          <SidebarTreeGuide depth={depth} data-folder-guide={depth} />
        )}
        <DraggableItem id={node.relativePath} type="folder" name={node.name}>
          <ContextMenu onOpenChange={() => setConfirmTrash(false)}>
            <ContextMenuTrigger asChild>
              <div
                className={cn(
                  "group relative",
                  folderAddMenuOpen && "bg-sidebar-accent/50",
                )}
              >
                <SidebarRow
                  type="button"
                  className="py-1.5 pr-7"
                  depth={depth}
                  aria-expanded={isExpanded}
                  data-sidebar-folder-id={encodeURIComponent(node.relativePath)}
                  onClick={() => onToggleFolder(node.relativePath)}
                >
                  <SidebarRowIcon className="text-muted-foreground">
                    {isExpanded ? (
                      <ChevronDownIcon className="size-4" />
                    ) : (
                      <ChevronRightIcon className="size-4" />
                    )}
                  </SidebarRowIcon>
                  <span
                    className={cn(
                      "min-w-0 flex-1 truncate",
                      isIgnored && "text-muted-foreground",
                    )}
                  >
                    {node.name}
                  </span>
                </SidebarRow>
                <div
                  className={cn(
                    "absolute top-1/2 right-1 -translate-y-1/2 opacity-0 transition-opacity group-hover:opacity-100",
                    folderAddMenuOpen && "opacity-100",
                  )}
                  onClick={(event) => event.stopPropagation()}
                  onKeyDown={(event) => event.stopPropagation()}
                  onPointerDown={(event) => event.stopPropagation()}
                >
                  <DropdownMenu
                    open={folderAddMenuOpen}
                    onOpenChange={setFolderAddMenuOpen}
                  >
                    <Hint content={`Add to ${node.name}`}>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-5"
                          aria-label={`Add to ${node.name}`}
                        >
                          <PlusIcon className="size-3" />
                        </Button>
                      </DropdownMenuTrigger>
                    </Hint>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        onClick={() => onNewFile(node.relativePath)}
                      >
                        <FileTextIcon className="mr-2 size-4" />
                        New File
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() => onNewFolder(node.relativePath)}
                      >
                        <FolderPlusIcon className="mr-2 size-4" />
                        New Folder
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        onClick={() => onImport(node.relativePath)}
                      >
                        <UploadIcon className="mr-2 size-4" />
                        Import File
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuItem onClick={() => onNewFile(node.relativePath)}>
                <FileTextIcon className="mr-2 size-4" />
                New File Here
              </ContextMenuItem>
              <ContextMenuItem onClick={() => onNewFolder(node.relativePath)}>
                <FolderPlusIcon className="mr-2 size-4" />
                New Folder
              </ContextMenuItem>
              <ContextMenuItem onClick={() => onImport(node.relativePath)}>
                <UploadIcon className="mr-2 size-4" />
                Import File Here
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem
                onClick={() => onRename(node.relativePath, node.name, "folder")}
              >
                <PencilIcon className="mr-2 size-4" />
                Rename
              </ContextMenuItem>
              <ContextMenuItem
                variant="destructive"
                className="trash-context-menu-item"
                data-confirming={confirmTrash}
                aria-label={confirmTrash ? "Confirm" : "Move to Trash"}
                textValue={confirmTrash ? "Confirm" : "Move to Trash"}
                onSelect={(event) => {
                  if (!confirmTrash) {
                    event.preventDefault();
                    setConfirmTrash(true);
                    return;
                  }
                  setConfirmTrash(false);
                  onDeleteFolder(node.relativePath);
                }}
              >
                <TrashMenuLabel />
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        </DraggableItem>
        {isExpanded &&
          node.children.map((child) => (
            <FileTreeNode
              key={child.relativePath}
              node={child}
              depth={depth + 1}
              activeFileId={activeFileId}
              expandedFolders={expandedFolders}
              onToggleFolder={onToggleFolder}
              onSelectFile={onSelectFile}
              onNewFile={onNewFile}
              onNewFolder={onNewFolder}
              onImport={onImport}
              onRename={onRename}
              onDelete={onDelete}
              onDeleteFolder={onDeleteFolder}
              aiEnabled={aiEnabled}
              fileCount={fileCount}
              gitIgnoredPaths={gitIgnoredPaths}
              gitConflictPaths={gitConflictPaths}
              gitLineStatsByPath={gitLineStatsByPath}
              commentCountsByPath={commentCountsByPath}
              pendingReviewFilePaths={pendingReviewFilePaths}
              unsavedLineStatsByPath={unsavedLineStatsByPath}
              nativeDragOver={nativeDragOver}
            />
          ))}
      </DroppableFolder>
    );
  }

  // File node
  const file = node.file!;
  const lineStats =
    gitLineStatsByPath.get(file.relativePath) ??
    unsavedLineStatsByPath.get(file.relativePath);
  const isIgnored = isIgnoredFilePath(file.relativePath, gitIgnoredPaths);
  const isConflicted = gitConflictPaths.has(
    normalizeGitPath(file.relativePath),
  );
  const isPendingAIReview = pendingReviewFilePaths.has(
    normalizeGitPath(file.relativePath),
  );
  return (
    <DraggableItem id={file.relativePath} type="file" name={node.name}>
      <ContextMenu
        onOpenChange={() => {
          setConfirmTrash(false);
          setChatMenuOpen(false);
        }}
      >
        <Hint
          content={
            isConflicted
              ? "Unresolved Git conflict"
              : isPendingAIReview
                ? "Awaiting AI review"
                : undefined
          }
        >
          <ContextMenuTrigger asChild>
            <SidebarRow
              data-sidebar-file-id={encodeURIComponent(file.id)}
              data-middle-click-tab
              data-pending-ai-review={isPendingAIReview ? "true" : undefined}
              data-git-conflicted={isConflicted ? "true" : undefined}
              className={cn(
                "py-1.5",
                file.id === activeFileId
                  ? isConflicted
                    ? CONFLICT_SELECTED_CLASS
                    : isPendingAIReview
                      ? PENDING_AI_REVIEW_SELECTED_CLASS
                      : "bg-sidebar-accent text-sidebar-accent-foreground"
                  : "hover:bg-sidebar-accent/50",
              )}
              trailing={
                <div className="ml-auto flex shrink-0 items-center gap-1.5">
                  <FileStatus
                    fileId={file.id}
                    commentCounts={commentCountsByPath.get(file.relativePath)}
                  />
                  {lineStats?.added ? (
                    <span className="font-mono text-[11px] text-green-600">
                      +{lineStats.added}
                    </span>
                  ) : null}
                  {lineStats?.deleted ? (
                    <span className="font-mono text-[11px] text-red-600">
                      -{lineStats.deleted}
                    </span>
                  ) : null}
                  {isConflicted && (
                    <GitMergeIcon
                      aria-label="Unresolved Git conflict"
                      className={cn("size-2.5 shrink-0", CONFLICT_TEXT_CLASS)}
                    />
                  )}
                  {file.isDirty ? (
                    <Hint content="Modified">
                      <span className="size-2 rounded-full bg-blue-500" />
                    </Hint>
                  ) : null}
                </div>
              }
              depth={depth}
              onClick={() => {
                useHistoryStore.getState().stopReview();
                onSelectFile(file.id);
              }}
              onAuxClick={(event) => {
                if (event.button !== 1) return;
                event.preventDefault();
                event.stopPropagation();
                useDocumentStore.getState().openFileInBackground(file.id);
              }}
            >
              <SidebarRowIcon>
                {getFileIcon(
                  file,
                  isConflicted
                    ? CONFLICT_TEXT_CLASS
                    : isPendingAIReview
                      ? PENDING_AI_REVIEW_TEXT_CLASS
                      : isIgnored
                        ? "text-muted-foreground"
                        : undefined,
                )}
              </SidebarRowIcon>
              <span
                className={cn(
                  "min-w-0 flex-1 truncate",
                  isConflicted
                    ? CONFLICT_TEXT_CLASS
                    : isPendingAIReview
                      ? PENDING_AI_REVIEW_TEXT_CLASS
                      : isIgnored && "text-muted-foreground",
                )}
              >
                {node.name}
              </span>
            </SidebarRow>
          </ContextMenuTrigger>
        </Hint>
        <ContextMenuContent
          className={chatMenuOpen ? "w-64" : undefined}
          aria-label={chatMenuOpen ? "Send file to chat" : "File actions"}
          onEscapeKeyDown={(event) => {
            if (chatMenuOpen) {
              event.preventDefault();
              setChatMenuOpen(false);
            }
          }}
          onKeyDown={(event) => {
            if (chatMenuOpen && event.key === "ArrowLeft") {
              event.preventDefault();
              event.stopPropagation();
              setChatMenuOpen(false);
            }
          }}
        >
          <SidebarFileContextActions
            file={file}
            aiEnabled={aiEnabled}
            chatMenuOpen={chatMenuOpen}
            onChatMenuOpenChange={setChatMenuOpen}
          >
            <ContextMenuItem
              onClick={() => onRename(file.id, file.name, "file")}
            >
              <PencilIcon className="mr-2 size-4" />
              Rename
            </ContextMenuItem>
            <ContextMenuItem
              variant="destructive"
              className="trash-context-menu-item"
              data-confirming={confirmTrash}
              aria-label={confirmTrash ? "Confirm" : "Move to Trash"}
              textValue={confirmTrash ? "Confirm" : "Move to Trash"}
              onSelect={(event) => {
                if (!confirmTrash) {
                  event.preventDefault();
                  setConfirmTrash(true);
                  return;
                }
                setConfirmTrash(false);
                onDelete(file.id);
              }}
              disabled={fileCount <= 1}
            >
              <TrashMenuLabel />
            </ContextMenuItem>
          </SidebarFileContextActions>
        </ContextMenuContent>
      </ContextMenu>
    </DraggableItem>
  );
}

// ─── Draggable wrapper ───

function DraggableItem({
  id,
  type,
  name,
  children,
}: {
  id: string;
  type: "file" | "folder";
  name: string;
  children: React.ReactNode;
}) {
  const { listeners, setNodeRef, isDragging } = useDraggable({
    id,
    data: { type, name },
  });

  // Wrap listeners to log pointer events
  const wrappedListeners = listeners
    ? Object.fromEntries(
        Object.entries(listeners).map(([key, handler]) => [
          key,
          (e: React.PointerEvent) => {
            (handler as (e: React.PointerEvent) => void)(e);
          },
        ]),
      )
    : {};

  return (
    <div
      ref={setNodeRef}
      {...wrappedListeners}
      // Only pointer dragging is configured. The nested row button owns
      // keyboard activation; making this wrapper a button adds a dead Tab stop.
      style={{ opacity: isDragging ? 0.4 : 1 }}
    >
      {children}
    </div>
  );
}

function CommentVisibilitySection() {
  const [collapsed, setCollapsed] = useState(true);
  const displayComments = useSettingsStore((s) => s.displayComments);
  const showPdfComments = useSettingsStore((s) => s.showPdfComments);
  const setDisplayComments = useSettingsStore((s) => s.setDisplayComments);
  const setShowPdfComments = useSettingsStore((s) => s.setShowPdfComments);
  const enableComments = useAppAction({
    id: "toggle-comments",
    label: "Enable comments",
    type: "checkbox",
    checked: displayComments,
    run: () => setDisplayComments(!displayComments),
    menu: { group: "View", section: 3, order: 0 },
  });
  const previewComments = useAppAction({
    id: "toggle-preview-comments",
    label: "Show in preview",
    type: "checkbox",
    checked: showPdfComments,
    enabled: displayComments,
    run: () => setShowPdfComments(!showPdfComments),
    menu: { group: "View", section: 3, order: 1 },
  });
  return (
    <section
      data-sidebar-section="comment-visibility"
      className="shrink-0 border-sidebar-border border-t"
    >
      <SidebarSectionHeader
        section="comment-visibility"
        title="Comments"
        icon={
          displayComments ? (
            <MessageSquareTextIcon className="size-3.5" />
          ) : (
            <MessageSquareOffIcon className="size-3.5" />
          )
        }
        collapsed={collapsed}
        onToggle={() => setCollapsed(!collapsed)}
      />
      <SidebarSectionBody hidden={collapsed} className="space-y-0.5">
        <PromptSourceToggle
          label={enableComments.label}
          Icon={EyeIcon}
          checked={enableComments.checked}
          onCheckedChange={enableComments.run}
        />
        <PromptSourceToggle
          label={previewComments.label}
          Icon={PdfFileIcon}
          checked={previewComments.checked}
          disabled={!previewComments.enabled}
          onCheckedChange={previewComments.run}
        />
        <CommentDeleteButtons />
      </SidebarSectionBody>
    </section>
  );
}

export function CatCompanion() {
  const catDisplayMode = useSettingsStore((s) => s.catDisplayMode);
  const catStaticDisplay = useSettingsStore((s) => s.catStaticDisplay);
  const catCustomText = useSettingsStore((s) => s.catCustomText);
  const catSelectedCcfddlDeadline = useSettingsStore(
    (s) => s.catSelectedCcfddlDeadline,
  );
  const catCountdownPrecision = useSettingsStore(
    (s) => s.catCountdownPrecision,
  );
  const [ccfddlUnavailable, setCcfddlUnavailable] = useState(false);
  const [ccfddlNow, setCcfddlNow] = useState(() => Date.now());

  useEffect(() => {
    if (catDisplayMode !== "ccfddl") {
      setCcfddlUnavailable(false);
      return;
    }

    if (!catSelectedCcfddlDeadline) {
      setCcfddlUnavailable(false);
      return;
    }

    let cancelled = false;
    fetchCcfddlDeadlines()
      .then((entries) => {
        if (cancelled) return;
        setCcfddlUnavailable(
          !entries.some((entry) => entry.id === catSelectedCcfddlDeadline.id),
        );
      })
      .catch(() => {
        if (!cancelled) setCcfddlUnavailable(true);
      });

    return () => {
      cancelled = true;
    };
  }, [catDisplayMode, catSelectedCcfddlDeadline]);

  useEffect(() => {
    if (catDisplayMode !== "ccfddl") return;
    setCcfddlNow(Date.now());
    const timer = window.setInterval(() => setCcfddlNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [catDisplayMode]);

  const staticCatText =
    catStaticDisplay === "hakimi"
      ? "南北绿豆"
      : catStaticDisplay === "custom"
        ? catCustomText || "Bibilabu"
        : "Bibilabu";
  const wizardGreetingText =
    catDisplayMode === "ccfddl"
      ? resolveCcfddlCatLabel({
          mode: "ccfddl",
          selectedEntry: catSelectedCcfddlDeadline,
          countdownPrecision: catCountdownPrecision,
          unavailable: ccfddlUnavailable,
          now: ccfddlNow,
        })
      : resolveCcfddlCatLabel({
          mode: "static",
          staticText: staticCatText,
        });
  const wizardGreetingLines = wizardGreetingText.split("\n");
  const isCcfddlGreeting = catDisplayMode === "ccfddl" && !ccfddlUnavailable;
  const isCcfddlNoDeadlineGreeting =
    isCcfddlGreeting && !catSelectedCcfddlDeadline && !ccfddlUnavailable;
  const isStaticCjkGreeting =
    !isCcfddlGreeting && /[\u3400-\u9fff]/.test(wizardGreetingText);
  const wizardGreetingChars = Array.from(`| ${wizardGreetingText} |`);
  const wizardGreetingFontSize = isStaticCjkGreeting
    ? 13
    : !isCcfddlGreeting && wizardGreetingChars.length > 24
      ? 12
      : 16;
  const wizardGreetingFontFamily = isStaticCjkGreeting
    ? HANDWRITTEN_CJK_CAT_FONT
    : HANDWRITTEN_CAT_FONT;
  const wizardGreetingFontWeight = isStaticCjkGreeting ? 800 : 600;
  const greetingSlotRef = useRef<HTMLDivElement>(null);
  const greetingRef = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    const slot = greetingSlotRef.current;
    const greeting = greetingRef.current;
    if (!slot || !greeting || !wizardGreetingText) return;
    const rotation = `rotate(${isCcfddlGreeting ? -8 : -10}deg)`;
    const fitGreeting = () => {
      // Measure the rotated letters, including their arc, before fitting them.
      greeting.style.transform = rotation;
      const range = document.createRange();
      range.selectNodeContents(greeting);
      const bounds = range.getBoundingClientRect();
      const box = slot.getBoundingClientRect();
      const label = greeting.getBoundingClientRect();
      if (!box.width || !box.height || !bounds.width || !bounds.height) return;
      // Account for the enlarged cat preview during onboarding as well.
      const zoom = box.width / slot.offsetWidth;
      // Keep the original font sizes. Only unusually wide labels need fitting;
      // the shared slot provides vertical space for the arc and rotation.
      const scale = Math.min(1, (box.width - 8 * zoom) / bounds.width);
      const centerX = label.x + label.width / 2;
      const centerY = label.y + label.height / 2;
      const x =
        (box.x +
          box.width / 2 -
          centerX -
          (bounds.x + bounds.width / 2 - centerX) * scale) /
        zoom;
      const y =
        (box.y +
          box.height / 2 -
          centerY -
          (bounds.y + bounds.height / 2 - centerY) * scale) /
        zoom;
      greeting.style.transform = `translate(${x}px, ${y}px) scale(${scale}) ${rotation}`;
    };
    fitGreeting();
    const observer = new ResizeObserver(fitGreeting);
    observer.observe(slot);
    observer.observe(greeting);
    return () => observer.disconnect();
  }, [wizardGreetingText, isCcfddlGreeting]);

  const renderGreetingArc = (
    text: string,
    {
      arcHeight,
      className,
      rotationScale = 0.42,
      withPipes = false,
    }: {
      arcHeight: number;
      className: string;
      rotationScale?: number;
      withPipes?: boolean;
    },
  ) => {
    const chars = Array.from(withPipes ? `| ${text} |` : text);
    const half = (chars.length - 1) / 2;

    return (
      <span className={className}>
        {chars.map((char, index) => {
          const x = index - half;
          const t = half === 0 ? 0 : x / half;
          const offsetY = -arcHeight * (1 - t * t);
          const slope = half === 0 ? 0 : (2 * arcHeight * x) / (half * half);
          const tangentAngle = (Math.atan(slope) * 180) / Math.PI;
          const rotation = tangentAngle * rotationScale;
          return (
            <span
              key={`${char}-${index}`}
              className="inline-block"
              style={{
                transform: `translateY(${offsetY.toFixed(2)}px) rotate(${rotation.toFixed(2)}deg)`,
                transformOrigin: "50% 85%",
              }}
            >
              {char === " " ? "\u00A0" : char}
            </span>
          );
        })}
      </span>
    );
  };

  return (
    <div data-cat-companion className="flex flex-col items-center pt-1">
      <div
        ref={greetingSlotRef}
        className="flex h-14 w-56 items-center justify-center"
      >
        <Hint content={wizardGreetingText.replace("\n", " ")}>
          <span
            ref={greetingRef}
            className="pointer-events-none relative z-10 flex shrink-0 select-none flex-col items-center whitespace-nowrap text-center text-foreground/90"
            style={{
              fontFamily: wizardGreetingFontFamily,
              fontWeight: wizardGreetingFontWeight,
              letterSpacing: "0.02em",
              transform: `rotate(${isCcfddlGreeting ? -8 : -10}deg)`,
              transformOrigin: "center",
              fontSize: `${wizardGreetingFontSize}px`,
              lineHeight: isStaticCjkGreeting ? 1.55 : 1.2,
              textShadow: isStaticCjkGreeting
                ? HANDWRITTEN_CJK_BOLD_SHADOW
                : undefined,
            }}
          >
            {isCcfddlGreeting ? (
              <>
                {renderGreetingArc(wizardGreetingLines[0] || "", {
                  arcHeight: 4,
                  className: "px-2 text-[15px] leading-[1.05]",
                })}
                {wizardGreetingLines[1]
                  ? renderGreetingArc(wizardGreetingLines[1], {
                      arcHeight: 8,
                      className: "mt-1.5 text-[11px] leading-[1.05]",
                      withPipes: !isCcfddlNoDeadlineGreeting,
                    })
                  : null}
              </>
            ) : (
              renderGreetingArc(wizardGreetingText, {
                arcHeight: 6,
                className: "",
                withPipes: true,
              })
            )}
          </span>
        </Hint>
      </div>
      <img
        src="/cat-leaf.svg"
        alt={PRODUCT_NAME + " cat leaf"}
        className="relative z-0 -mt-3 h-16 w-auto shrink-0 select-none transition-[filter] duration-200 dark:invert"
        draggable={false}
      />
    </div>
  );
}
