import { ARTISAN_MODE_REQUEST_EVENT } from "@/lib/workspace-events";
import { AgentFileReview } from "./editor/agent-file-review";
import {
  AGENT_REVIEW_NAVIGATION_COLORS,
  AgentReviewFileNavigation,
} from "./agent-review-file-navigation";
import {
  GIT_REVIEW_NAVIGATION_COLORS,
  GitReviewFileNavigation,
} from "./git-review-file-navigation";
import {
  createFileListSelector,
  createFilesSelector,
  type FileListEntry,
} from "@/lib/file-selectors";
import { useSettingsStore } from "@/stores/settings-store";
import { Hint } from "@/components/ui/tooltip";
import { WorkspacePanel, WorkspacePanelResizeHandle } from "./workspace-panel";
import {
  areWorkspaceLayoutsClose as areLayoutsClose,
  WORKSPACE_PANEL_EXPAND_ANIMATION_MS,
  useWorkspaceLayoutAnimation,
} from "./use-workspace-layout-animation";
import { ProjectSidebarPanel } from "./project-sidebar-panel";
import { useWorkspaceTheme } from "@/hooks/use-workspace-theme";
import { PdfFileIcon } from "@/components/ui/pdf-file-icon";
import { ButtonGroup } from "@/components/ui/button-group";
import { WorkspaceHistoryControl } from "./workspace-history-control";
import { preparePdfCommentLayout } from "@/lib/workspace-events";
import { invoke } from "@/lib/desktop/core";
import {
  type ConflictFile,
  type ConflictOverview,
  isTextEditorConflict,
} from "@/lib/git-conflicts";
import { GitFileConflictView } from "./editor/git-file-conflict-view";
import {
  type CSSProperties,
  type MouseEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTrafficLightInset } from "@/hooks/use-traffic-light-inset";
import {
  Panel,
  PanelGroup,
  PanelResizeHandle,
  type ImperativePanelGroupHandle,
} from "react-resizable-panels";
import {
  BotIcon,
  CodeXmlIcon,
  FileCodeIcon,
  FileIcon,
  FileSpreadsheetIcon,
  FileTextIcon,
  HomeIcon,
  ImageIcon,
  MessagesSquareIcon,
  SidebarIcon,
  SplitSquareHorizontalIcon,
} from "lucide-react";
import { Sidebar } from "./sidebar";
import { LatexEditor } from "./editor/latex-editor";
import { PdfPreview } from "./preview/pdf-preview";
import { MarkdownPreview } from "./preview/markdown-preview";
import { CsvTable } from "./preview/csv-table";
import { ExternalAppSelector } from "./external-app-selector";
import { GitActionsControl } from "./git-actions-control";
import { SyncNavigationControl } from "./sync-navigation-control";
import { AgentChatDrawer } from "@/components/agent-chat/agent-chat-drawer";
import { ChatWorkspacePane } from "@/components/agent-chat/chat-workspace-pane";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { APP_VISIBILITY_RESTORED } from "@/lib/debug/log-store";
import { isMarkdownFile, isMarkdownPath } from "@/lib/markdown";
import { shouldMuteLatexScrollSync } from "@/lib/latex-project";
import { cn } from "@/lib/utils";
import { useAgentChatStore } from "@/stores/agent-chat-store";
import { useDocumentStore } from "@/stores/document-store";
import { useProposedChangesStore } from "@/stores/proposed-changes-store";
import type {
  WorkspaceMode,
  ProjectWorkspacePreferences,
} from "@/lib/workspace-mode";
import {
  shouldShowEditorForProposedChange,
  type WorkspaceContentMode,
  type ModeTransitionPhase,
  type WorkspaceViewMode,
} from "./workspace-layout-state";

type SyncNavigationDirection = "to-editor" | "to-pdf" | "to-preview";
type WorkspaceColumnId = "chat" | "editor" | "incoming" | "pdf";
type ComposerTransferPhase =
  | "idle"
  | "drawer_exit"
  | "panel_exit"
  | "panel_tv_exit"
  | "panel_enter_prep"
  | "panel_enter"
  | "drawer_enter_prep"
  | "drawer_enter";
const DEFAULT_HANDOFF_LAYOUT: [number, number] = [50, 50];
const SIDECAR_MODE_LAYOUT: [number, number] = [0, 100];
const WORKSPACE_COLUMN_ORDER: WorkspaceColumnId[] = [
  "chat",
  "editor",
  "incoming",
  "pdf",
];
const OPEN_COLUMN_MIN_PERCENT = 20;

function getWorkspaceViewOptions({
  isMarkdownDocument,
  isCsvDocument,
}: {
  isMarkdownDocument: boolean;
  isCsvDocument: boolean;
}): Array<{
  value: WorkspaceViewMode;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}> {
  return [
    {
      value: "editor",
      label: isCsvDocument ? "Raw" : "Editor",
      icon: CodeXmlIcon,
    },
    { value: "split", label: "Split", icon: SplitSquareHorizontalIcon },
    {
      value: "pdf",
      label: isCsvDocument ? "Table" : isMarkdownDocument ? "Preview" : "PDF",
      icon: isCsvDocument
        ? FileSpreadsheetIcon
        : isMarkdownDocument
          ? FileTextIcon
          : PdfFileIcon,
    },
  ];
}

const SIDEBAR_TOGGLE_ANIMATION_MS = 320;
const FRONT_MORPH_DURATION_MS = 220;
const FRONT_MORPH_GEOMETRY_DELAY_MS = 90;
const BACK_MORPH_DURATION_MS = 230;
const BACK_MORPH_DELAY_MS = 20;
const FRONT_MORPH_EASE = "cubic-bezier(0.2, 0.9, 0.25, 1)";
const BACK_MORPH_EASE = "cubic-bezier(0.2, 0.9, 0.25, 1)";
const DRAWER_EXIT_DURATION_MS = 180;
const DRAWER_REVEAL_MS = 240;
const PANEL_TV_EXIT_MS = 220;
const COMPOSER_TRANSFER_SOURCE_EXIT_MS = 180;
const COMPOSER_TRANSFER_REVERSE_SOURCE_EXIT_MS = 180;
const COMPOSER_TRANSFER_TARGET_ENTER_MS = 210;
const DRAWER_ANCHOR_STABILIZE_FRAMES = 2;
const DRAWER_ANCHOR_STABILIZE_FRAME_CAP = 6;
const DRAWER_ANCHOR_STABILIZE_TIMEOUT_MS = 120;
const DRAWER_ANCHOR_UNLOCK_DELAY_MS = 240;

type DrawerHostAnchor = {
  shellTop: number;
  shellLeft: number;
  shellWidth: number;
  shellHeight: number;
  clipTop: number;
  clipHeight: number;
};

function interpolateDrawerAnchor(
  from: DrawerHostAnchor,
  to: DrawerHostAnchor,
  progress: number,
): DrawerHostAnchor {
  const mix = (start: number, end: number) => start + (end - start) * progress;
  return {
    shellTop: mix(from.shellTop, to.shellTop),
    shellLeft: mix(from.shellLeft, to.shellLeft),
    shellWidth: mix(from.shellWidth, to.shellWidth),
    shellHeight: mix(from.shellHeight, to.shellHeight),
    clipTop: mix(from.clipTop, to.clipTop),
    clipHeight: mix(from.clipHeight, to.clipHeight),
  };
}

type ModeTransitionDirection = "assist_to_direct" | "direct_to_assist";
function getColumnIndex(column: WorkspaceColumnId) {
  return WORKSPACE_COLUMN_ORDER.indexOf(column);
}

function normalizeOpenColumns(
  columns: WorkspaceColumnId[],
  fallback: WorkspaceColumnId = "editor",
) {
  const deduped: WorkspaceColumnId[] = [];
  for (const column of columns) {
    if (!WORKSPACE_COLUMN_ORDER.includes(column)) continue;
    if (deduped.includes(column)) continue;
    deduped.push(column);
  }
  deduped.sort((a, b) => getColumnIndex(a) - getColumnIndex(b));
  if (deduped.length === 0) return [fallback] as WorkspaceColumnId[];
  if (deduped.length <= 2) return deduped;
  return deduped.slice(0, 2);
}

function getOrderedPairKey(left: WorkspaceColumnId, right: WorkspaceColumnId) {
  const ordered = [left, right].sort(
    (a, b) => getColumnIndex(a) - getColumnIndex(b),
  ) as [WorkspaceColumnId, WorkspaceColumnId];
  return `${ordered[0]}|${ordered[1]}`;
}

function areOpenColumnsEqual(
  left: WorkspaceColumnId[],
  right: WorkspaceColumnId[],
) {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

/** Drawer CSS uses local layout pixels, even while an ancestor animates its scale. */
function createLayoutRectReader(container: HTMLElement) {
  const bounds = container.getBoundingClientRect();
  const scaleX =
    container.offsetWidth > 0 ? bounds.width / container.offsetWidth : 1;
  const scaleY =
    container.offsetHeight > 0 ? bounds.height / container.offsetHeight : 1;
  return (element: HTMLElement) => {
    const rect = element.getBoundingClientRect();
    return new DOMRect(
      (rect.left - bounds.left) / (scaleX || 1),
      (rect.top - bounds.top) / (scaleY || 1),
      rect.width / (scaleX || 1),
      rect.height / (scaleY || 1),
    );
  };
}

function anchorsEqual(left: DrawerHostAnchor, right: DrawerHostAnchor) {
  return (
    Math.abs(left.shellTop - right.shellTop) < 0.5 &&
    Math.abs(left.shellLeft - right.shellLeft) < 0.5 &&
    Math.abs(left.shellWidth - right.shellWidth) < 0.5 &&
    Math.abs(left.shellHeight - right.shellHeight) < 0.5 &&
    Math.abs(left.clipTop - right.clipTop) < 0.5 &&
    Math.abs(left.clipHeight - right.clipHeight) < 0.5
  );
}

function getWorkspaceChatFileIcon(file: FileListEntry) {
  if (file.type === "image") return <ImageIcon className="size-4 shrink-0" />;
  if (file.type === "csv")
    return <FileSpreadsheetIcon className="size-4 shrink-0" />;
  if (file.type === "pdf")
    return <FileSpreadsheetIcon className="size-4 shrink-0" />;
  if (file.type === "style")
    return <FileCodeIcon className="size-4 shrink-0" />;
  if (isMarkdownFile(file)) return <FileTextIcon className="size-4 shrink-0" />;
  if (file.type === "other") return <FileIcon className="size-4 shrink-0" />;
  return <FileTextIcon className="size-4 shrink-0" />;
}

function formatWorkspaceChatTitle(title: string) {
  if (!title) return title;
  return title.charAt(0).toUpperCase() + title.slice(1);
}

export function WorkspaceLayout() {
  const projectRoot = useDocumentStore((s) => s.projectRoot);
  return <ProjectWorkspaceLayout key={projectRoot} />;
}

function ProjectWorkspaceLayout() {
  const initialized = useDocumentStore((s) => s.initialized);
  const closeProject = useDocumentStore((s) => s.closeProject);
  const workspaceChatFileOptions = useDocumentStore(
    useMemo(createFileListSelector, []),
  );
  const activeFileId = useDocumentStore((s) => s.activeFileId);
  const setActiveFile = useDocumentStore((s) => s.setActiveFile);
  const projectRoot = useDocumentStore((s) => s.projectRoot);
  const activeFileType = useDocumentStore(
    (s) => s.files.find((f) => f.id === s.activeFileId)?.type,
  );
  const activeFileRelativePath = useDocumentStore(
    (s) => s.files.find((f) => f.id === s.activeFileId)?.relativePath ?? null,
  );
  const [fileConflictState, setFileConflictState] = useState<{
    root: string;
    files: ConflictFile[];
    rebasing: boolean;
  } | null>(null);
  const [conflictRefresh, setConflictRefresh] = useState(0);
  // The overview already includes every file. Resolve tab layout synchronously
  // from it instead of briefly opening a normal image layout while fetching again.
  const fileConflict = useMemo(() => {
    if (fileConflictState?.root !== projectRoot) return null;
    const file = fileConflictState?.files.find(
      (entry) =>
        entry.document_path === activeFileRelativePath &&
        !isTextEditorConflict(entry),
    );
    return file && fileConflictState
      ? {
          root: fileConflictState.root,
          file,
          rebasing: fileConflictState.rebasing,
        }
      : null;
  }, [fileConflictState, projectRoot, activeFileRelativePath]);
  const agentReviewFile = useDocumentStore(
    (state) =>
      state.files.find((file) => file.id === state.activeFileId) ?? null,
  );
  const workspaceSessionId = useDocumentStore(
    (state) => state.agentWorkspaceSessionId,
  );
  const agentFileChange = useProposedChangesStore(
    (state) =>
      state.changes.find(
        (change) =>
          change.filePath === activeFileRelativePath &&
          change.workspaceSessionId === workspaceSessionId &&
          (change.binary ||
            agentReviewFile?.type === "image" ||
            agentReviewFile?.type === "pdf"),
      ) ?? null,
  );
  const hasWholeFileComparison =
    Boolean(fileConflict) ||
    Boolean(
      agentFileChange &&
        !["added", "deleted"].includes(
          agentFileChange.workspaceChangeKind ?? "modified",
        ),
    );
  // Keep the outgoing image available until its own column has finished closing.
  const [retainedConflict, setRetainedConflict] = useState(fileConflict);
  useLayoutEffect(() => {
    if (fileConflict) setRetainedConflict(fileConflict);
  }, [fileConflict]);
  const displayedConflict =
    fileConflict ??
    (retainedConflict?.root === projectRoot ? retainedConflict : null);
  const refreshConflict = useCallback(() => {
    window.dispatchEvent(new CustomEvent("catalex:git-stats-refresh"));
  }, []);
  useEffect(() => {
    const refresh = () => setConflictRefresh((value) => value + 1);
    window.addEventListener("catalex:git-stats-refresh", refresh);
    return () =>
      window.removeEventListener("catalex:git-stats-refresh", refresh);
  }, []);
  useEffect(() => {
    if (!projectRoot) return;
    let cancelled = false;
    void invoke<ConflictOverview>("git_panel_conflicts", { projectRoot })
      .then((overview) => {
        if (cancelled) return;
        setFileConflictState({
          root: projectRoot,
          files: overview.files,
          rebasing: overview.rebasing,
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [projectRoot, activeFileRelativePath, conflictRefresh]);
  const proposedChanges = useProposedChangesStore((s) => s.changes);
  const isReviewNavigation = proposedChanges.length > 0;
  const pendingReviewFiles = useMemo(() => {
    const paths = isReviewNavigation
      ? proposedChanges.map((change) => change.filePath)
      : fileConflictState?.root === projectRoot && !workspaceSessionId
        ? fileConflictState.files.map((file) => file.document_path ?? file.path)
        : [];
    const byPath = new Map(
      workspaceChatFileOptions.map((file) => [file.relativePath, file]),
    );
    return [...new Set(paths)]
      .map((path) => byPath.get(path))
      .filter((file): file is FileListEntry => Boolean(file));
  }, [
    isReviewNavigation,
    proposedChanges,
    fileConflictState,
    projectRoot,
    workspaceSessionId,
    workspaceChatFileOptions,
  ]);
  const reviewFileIndex = pendingReviewFiles.findIndex(
    (file) => file.id === activeFileId,
  );
  const reviewNavigationColors = isReviewNavigation
    ? AGENT_REVIEW_NAVIGATION_COLORS
    : GIT_REVIEW_NAVIGATION_COLORS;
  const navigateReviewFile = (direction: -1 | 1) => {
    if (!pendingReviewFiles.length) return;
    const index =
      reviewFileIndex < 0
        ? direction === 1
          ? 0
          : pendingReviewFiles.length - 1
        : (reviewFileIndex + direction + pendingReviewFiles.length) %
          pendingReviewFiles.length;
    setActiveFile(pendingReviewFiles[index].id);
  };
  const activeChatTitle = useAgentChatStore((s) => {
    const activeTab = s.tabs.find((tab) => tab.id === s.activeTabId);
    return activeTab?.title ?? "New Chat";
  });
  const activeChatProvider = useAgentChatStore((s) => {
    const activeTab = s.tabs.find((tab) => tab.id === s.activeTabId);
    return activeTab?.provider ?? "claude";
  });
  const [viewMode, setViewMode] = useState<WorkspaceViewMode>("split");
  // Preserve drawer size while its workspace presentation is active.
  const [chatDrawerOpen, setChatDrawerOpen] = useState(false);
  const [chatDrawerHeight, setChatDrawerHeight] = useState<number>();
  useEffect(() => setChatDrawerHeight(undefined), [projectRoot]);
  const [workspacePreferences, updateWorkspacePreferences] = useState(() =>
    useSettingsStore.getState().getWorkspacePreferences(projectRoot),
  );
  const { mode: workspaceMode, chatLayout } = workspacePreferences;
  const isWorkspaceChat =
    workspaceMode === "duet" && chatLayout === "workspace";
  const isDrawerChat = workspaceMode === "duet" && chatLayout === "drawer";
  // Acknowledge the destination in the sidebar before the composer transfer commits.
  const [sidebarTarget, setSidebarTarget] =
    useState<ProjectWorkspacePreferences | null>(null);
  const setWorkspacePreferences = useCallback(
    (preferences: ProjectWorkspacePreferences) => {
      updateWorkspacePreferences(preferences);
      setSidebarTarget(null);
      if (projectRoot)
        useSettingsStore
          .getState()
          .setWorkspacePreferences(projectRoot, preferences);
    },
    [projectRoot],
  );
  const [drawerPresence, setDrawerPresence] = useState<
    "hidden" | "visible" | "exiting" | "transfer"
  >(() => (isDrawerChat ? "visible" : "hidden"));
  const [drawerIntroPhase, setDrawerIntroPhase] = useState<
    "idle" | "preparing" | "revealing"
  >("idle");
  const [modeTransitionPhase, setModeTransitionPhase] =
    useState<ModeTransitionPhase>("idle");
  const [workspaceDrawerAnchor, setWorkspaceDrawerAnchor] =
    useState<DrawerHostAnchor | null>(null);
  const [frontMorphToPanel, setFrontMorphToPanel] = useState(false);
  const [backLayerTransform, setBackLayerTransform] = useState<string | null>(
    null,
  );
  const [backLayerTransition, setBackLayerTransition] =
    useState<string>("none");
  const [composerTransferPhase, setComposerTransferPhase] =
    useState<ComposerTransferPhase>("idle");
  const [artisanToDuetFadeActive, setArtisanToDuetFadeActive] = useState(false);
  const [forceHidePanelComposer, setForceHidePanelComposer] = useState(false);
  const [
    workspaceChatRenderableFileModes,
    setWorkspaceChatRenderableFileModes,
  ] = useState<Record<string, WorkspaceContentMode>>({});
  const [workspaceChatHeaderLayout, setWorkspaceChatHeaderLayout] = useState<
    [number, number]
  >(DEFAULT_HANDOFF_LAYOUT);
  const [syncNavigationRequest, setSyncNavigationRequest] = useState<{
    id: number;
    direction: SyncNavigationDirection;
  } | null>(null);
  const isScrollSyncLocked = useSettingsStore(
    (state) =>
      (projectRoot
        ? state.scrollSyncByProject[projectRoot]?.[activeFileId]
        : undefined) ?? true,
  );
  const [markdownPreviewScrollTarget, setMarkdownPreviewScrollTarget] =
    useState<{
      id: number;
      position: number;
    } | null>(null);
  const [latexPdfScrollTarget, setLatexPdfScrollTarget] = useState<{
    id: number;
    position: number;
  } | null>(null);
  const [editorScrollSyncTarget, setEditorScrollSyncTarget] = useState<{
    id: number;
    position: number;
  } | null>(null);
  useEffect(() => {
    setMarkdownPreviewScrollTarget(null);
    setLatexPdfScrollTarget(null);
    setEditorScrollSyncTarget(null);
  }, [projectRoot, activeFileId]);
  const [isSyncNavigationControlHovered, setIsSyncNavigationControlHovered] =
    useState(false);
  const [isWorkspaceSeamMiddleHovered, setIsWorkspaceSeamMiddleHovered] =
    useState(false);
  const isWorkspaceSeamDraggingRef = useRef(false);
  useEffect(() => {
    const updateSeamResizeRegion = (event: PointerEvent) => {
      if (isWorkspaceSeamDraggingRef.current) return;
      const seam = document.querySelector<HTMLElement>(
        "[data-workspace-resize-seam]",
      );
      if (!seam) return;
      const bounds = seam.getBoundingClientRect();
      const position = (event.clientY - bounds.top) / bounds.height;
      setIsWorkspaceSeamMiddleHovered(position > 1 / 3 && position < 2 / 3);
    };
    // The resize library hit-tests a margin outside the handle itself.
    // Track the pointer globally so the same vertical restriction covers that margin.
    window.addEventListener("pointermove", updateSeamResizeRegion, true);
    return () =>
      window.removeEventListener("pointermove", updateSeamResizeRegion, true);
  }, []);

  const [globalHeaderHost, setGlobalHeaderHost] =
    useState<HTMLDivElement | null>(null);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [isSidebarTransitioning, setIsSidebarTransitioning] = useState(false);
  const collapsedHeaderInset = useTrafficLightInset();
  const [collapsedHeaderControlsWidth, setCollapsedHeaderControlsWidth] =
    useState(0);
  const markdownPreviewScrollRequestIdRef = useRef(0);
  const latexPdfScrollRequestIdRef = useRef(0);
  const editorScrollSyncRequestIdRef = useRef(0);

  const modeContentGroupRef = useRef<ImperativePanelGroupHandle | null>(null);
  const contentGroupRef = useRef<ImperativePanelGroupHandle | null>(null);
  const headerRowRef = useRef<HTMLDivElement | null>(null);
  const modeAreaRef = useRef<HTMLDivElement | null>(null);
  const collapsedHeaderControlsRef = useRef<HTMLDivElement | null>(null);
  const contentAreaRef = useRef<HTMLDivElement | null>(null);
  const editorPanelRef = useRef<HTMLDivElement | null>(null);
  const pdfPanelRef = useRef<HTMLDivElement | null>(null);
  const incomingPanelRef = useRef<HTMLDivElement | null>(null);
  const sidebarTransitionTimerRef = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);
  const splitFromPdfTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const hasInitializedLayoutRef = useRef(false);
  const hasInitializedModeLayoutRef = useRef(false);
  const modeLayoutRef = useRef<[number, number]>(SIDECAR_MODE_LAYOUT);
  const splitLayoutRef = useRef<[number, number]>([50, 50]);
  const workspaceChatLayoutRef = useRef<[number, number]>(
    DEFAULT_HANDOFF_LAYOUT,
  );
  const lastViewModeRef = useRef<WorkspaceViewMode>("split");
  const drawerTransitionShellRef = useRef<HTMLDivElement | null>(null);
  const modeTransitionTokenRef = useRef(0);
  const modeTransitionGuardTimerRef = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);
  const composerTransferTokenRef = useRef(0);
  const composerTransferTimersRef = useRef<
    Array<ReturnType<typeof setTimeout>>
  >([]);
  const drawerAnchorLockRef = useRef(false);
  const drawerEnterPreflightRafRef = useRef<number | null>(null);
  const drawerEnterPreflightTimeoutRef = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);
  const exitingDrawerAnchorRef = useRef<{
    shellTop: number;
    shellLeft: number;
    shellWidth: number;
    shellHeight: number;
    clipTop: number;
    clipHeight: number;
  } | null>(null);

  // Add a pane here to share the same visibility and size animation policy.
  // Chat keeps its separate composer/drawer visibility choreography.
  const animatedPanels = useMemo(
    () => [
      { index: getColumnIndex("editor"), ref: editorPanelRef },
      { index: getColumnIndex("pdf"), ref: pdfPanelRef },
      { index: getColumnIndex("incoming"), ref: incomingPanelRef },
    ],
    [],
  );
  const [drawerViewMotion, setDrawerViewMotion] = useState<{
    from: DrawerHostAnchor;
    progress: number;
  } | null>(null);
  const [pdfLayoutTarget, setPdfLayoutTarget] = useState<{
    from: number;
    to: number;
    width: number;
    currentWidth: number;
  }>();
  const handlePanelAnimationStart = useCallback(
    (from: number[], to: number[]) => {
      const group = pdfPanelRef.current?.closest("[data-panel-group]");
      const panels = group?.querySelectorAll(":scope > [data-panel]");
      const availableWidth = Array.from(panels ?? []).reduce(
        (sum, panel) => sum + panel.getBoundingClientRect().width,
        0,
      );
      setPdfLayoutTarget({
        currentWidth: pdfPanelRef.current?.clientWidth ?? 0,
        from: from[getColumnIndex("pdf")],
        to: to[getColumnIndex("pdf")],
        width: Math.max(
          0,
          (availableWidth * to[getColumnIndex("pdf")]) / 100 - 2,
        ),
      });
      // A replacement conflict can mount into an already-open Incoming column.
      if (to[getColumnIndex("incoming")] > 0.5 && incomingPanelRef.current) {
        incomingPanelRef.current.style.opacity = "1";
      }
    },
    [],
  );
  const handlePanelAnimationFrame = useCallback(
    (layout: number[], progress: number) => {
      setDrawerViewMotion((current) =>
        current
          ? { ...current, progress: progress * progress * (3 - 2 * progress) }
          : current,
      );
      const group = pdfPanelRef.current?.closest("[data-panel-group]");
      const panels = group?.querySelectorAll(":scope > [data-panel]");
      // Handle visibility commits with the new mode; measure its available space
      // before deriving both the current and opening PDF sizes for this frame.
      const availableWidth = Array.from(panels ?? []).reduce(
        (sum, panel) => sum + panel.getBoundingClientRect().width,
        0,
      );
      const currentWidth = Math.max(
        0,
        (availableWidth * layout[getColumnIndex("pdf")]) / 100 - 2,
      );
      setPdfLayoutTarget((current) =>
        current
          ? {
              ...current,
              currentWidth,
              width: Math.max(0, (availableWidth * current.to) / 100 - 2),
            }
          : current,
      );
    },
    [],
  );
  const handlePanelAnimationComplete = useCallback((layout: number[]) => {
    setDrawerViewMotion(null);
    if (layout[getColumnIndex("incoming")] <= 0.5) setRetainedConflict(null);
  }, []);
  const {
    animate: animateWorkspaceLayout,
    stop: stopRunningAnimation,
    applyOpacity: applyWorkspacePanelOpacity,
    isAnimating: isColumnLayoutAnimating,
    isAnimatingRef: isAnimatingColumnLayoutRef,
  } = useWorkspaceLayoutAnimation({
    groupRef: contentGroupRef,
    panels: animatedPanels,
    onStart: handlePanelAnimationStart,
    onFrame: handlePanelAnimationFrame,
    onComplete: handlePanelAnimationComplete,
  });

  const isRenderableLatex = activeFileType === "tex";
  const isMarkdownDocument = isMarkdownPath(activeFileRelativePath);
  const isCsvDocument = activeFileType === "csv";
  const isPreviewableFile =
    isRenderableLatex || isMarkdownDocument || isCsvDocument;
  const editorPanelLabel = isCsvDocument ? "Raw" : "Editor";
  const previewPanelLabel = isCsvDocument
    ? "Table"
    : isMarkdownDocument
      ? "Preview"
      : "PDF";
  const workspaceViewOptions = getWorkspaceViewOptions({
    isMarkdownDocument,
    isCsvDocument,
  });
  const isLatexScrollSyncMuted = useDocumentStore(
    useMemo(
      () =>
        createFilesSelector(
          (files) =>
            isRenderableLatex && shouldMuteLatexScrollSync(activeFileId, files),
        ),
      [activeFileId, isRenderableLatex],
    ),
  );
  const isLatexScrollSyncEnabled =
    isScrollSyncLocked && !isLatexScrollSyncMuted;

  useEffect(() => {
    if (!isRenderableLatex) return;
    if (!isLatexScrollSyncEnabled) {
      setLatexPdfScrollTarget(null);
      setEditorScrollSyncTarget(null);
      return;
    }
    const documentState = useDocumentStore.getState();
    latexPdfScrollRequestIdRef.current += 1;
    setLatexPdfScrollTarget({
      id: latexPdfScrollRequestIdRef.current,
      position:
        documentState.selectionRange?.start ?? documentState.cursorPosition,
    });
  }, [activeFileId, isLatexScrollSyncEnabled, isRenderableLatex]);
  const activeFileProposedChange = proposedChanges.find(
    (change) => change.filePath === activeFileRelativePath,
  );
  const hasActiveFileProposedChange = !!activeFileProposedChange;
  const autoRevealedReviewRef = useRef<string | null>(null);
  const [previewReviewHost, setPreviewReviewHost] =
    useState<HTMLDivElement | null>(null);
  useWorkspaceTheme(workspaceMode);
  const workspaceChatRightPanelMode: WorkspaceContentMode =
    isPreviewableFile && activeFileId
      ? (workspaceChatRenderableFileModes[activeFileId] ?? "pdf")
      : "editor";
  const [expandedPanel, setExpandedPanel] = useState<WorkspaceColumnId | null>(
    null,
  );
  useEffect(() => {
    setExpandedPanel(null);
  }, [workspacePreferences, projectRoot, hasWholeFileComparison]);
  const panelExpansion = (column: WorkspaceColumnId, label: string) => ({
    label,
    expanded: expandedPanel === column,
    onExpandedChange: (expanded: boolean) =>
      setExpandedPanel(expanded ? column : null),
    disabled: modeTransitionPhase !== "idle" || isColumnLayoutAnimating,
  });
  const effectiveViewMode: WorkspaceViewMode = isWorkspaceChat
    ? isPreviewableFile
      ? workspaceChatRightPanelMode
      : "editor"
    : isPreviewableFile
      ? viewMode
      : "editor";
  const showGlobalChatDrawer =
    isDrawerChat && modeTransitionPhase === "idle" && !hasWholeFileComparison;
  const shouldRenderGlobalChatDrawer =
    (isDrawerChat && !hasWholeFileComparison) || drawerPresence !== "hidden";
  useEffect(() => {
    if (!showGlobalChatDrawer) setDrawerViewMotion(null);
  }, [showGlobalChatDrawer]);
  const drawerTracksEditorHalf = isPreviewableFile && viewMode === "split";
  const [drawerAnchor, setDrawerAnchor] = useState<DrawerHostAnchor | null>(
    null,
  );
  const [isSplitFromPdfTransition, setIsSplitFromPdfTransition] =
    useState(false);
  const drawerComposerTransferPhase =
    composerTransferPhase === "drawer_exit" ||
    composerTransferPhase === "drawer_enter_prep" ||
    composerTransferPhase === "drawer_enter"
      ? composerTransferPhase
      : "idle";
  const panelComposerTransferPhase =
    composerTransferPhase === "panel_exit" ||
    composerTransferPhase === "panel_tv_exit" ||
    composerTransferPhase === "drawer_enter_prep" ||
    composerTransferPhase === "drawer_enter" ||
    composerTransferPhase === "panel_enter_prep" ||
    composerTransferPhase === "panel_enter"
      ? composerTransferPhase === "drawer_enter_prep" ||
        composerTransferPhase === "drawer_enter"
        ? "panel_exit"
        : composerTransferPhase
      : "idle";
  const suppressHandoffPaneFade =
    composerTransferPhase === "panel_exit" ||
    composerTransferPhase === "panel_tv_exit" ||
    composerTransferPhase === "drawer_enter_prep" ||
    composerTransferPhase === "drawer_enter";
  const [initialOpenColumns] = useState<WorkspaceColumnId[]>(() => {
    if (hasWholeFileComparison) return ["editor", "incoming"];
    if (isWorkspaceChat) return ["chat", workspaceChatRightPanelMode];
    return isPreviewableFile ? ["editor", "pdf"] : ["editor"];
  });
  const [openColumns, setOpenColumns] =
    useState<WorkspaceColumnId[]>(initialOpenColumns);
  const initialColumnSize = (column: WorkspaceColumnId) =>
    initialOpenColumns.includes(column) ? 100 / initialOpenColumns.length : 0;
  const [pairRatioByKey, setPairRatioByKey] = useState<Record<string, number>>({
    "chat|editor": 50,
    "chat|pdf": 50,
    "editor|pdf": 50,
  });
  const pairRatioByKeyRef = useRef(pairRatioByKey);
  pairRatioByKeyRef.current = pairRatioByKey;
  const openColumnsRef = useRef(openColumns);
  openColumnsRef.current = openColumns;
  const assistLayoutSnapshotRef = useRef<{
    viewMode: WorkspaceViewMode;
    openColumns: WorkspaceColumnId[];
  } | null>(null);
  const openPairKey =
    openColumns.length === 2
      ? getOrderedPairKey(openColumns[0], openColumns[1])
      : null;
  const visibleColumnCount = openColumns.length;
  const isChatVisible = openColumns.includes("chat");
  const isEditorVisible = openColumns.includes("editor");
  const isPdfVisible = openColumns.includes("pdf");
  const isPreviewOnly = isPdfVisible && !isEditorVisible;
  const isIncomingVisible = openColumns.includes("incoming");
  useEffect(() => {
    if (expandedPanel && !openColumns.includes(expandedPanel))
      setExpandedPanel(null);
  }, [expandedPanel, openColumns]);
  const chatPanelMinSize =
    !isColumnLayoutAnimating && visibleColumnCount === 2 && isChatVisible
      ? OPEN_COLUMN_MIN_PERCENT
      : 0;
  const editorPanelMinSize =
    !isColumnLayoutAnimating && visibleColumnCount === 2 && isEditorVisible
      ? OPEN_COLUMN_MIN_PERCENT
      : 0;
  const pdfPanelMinSize =
    !isColumnLayoutAnimating && visibleColumnCount === 2 && isPdfVisible
      ? OPEN_COLUMN_MIN_PERCENT
      : 0;
  const incomingPanelMinSize =
    !isColumnLayoutAnimating && visibleColumnCount === 2 && isIncomingVisible
      ? OPEN_COLUMN_MIN_PERCENT
      : 0;
  const showChatEditorHandle =
    openPairKey === "chat|editor" || openPairKey === "chat|pdf";
  const showEditorPdfHandle =
    openPairKey === "editor|pdf" || openPairKey === "editor|incoming";

  const updateWorkspaceContentMode = useCallback(
    (mode: WorkspaceContentMode) => {
      if (!activeFileId || !isPreviewableFile) return;
      setWorkspaceChatRenderableFileModes((current) => {
        if (current[activeFileId] === mode) return current;
        return {
          ...current,
          [activeFileId]: mode,
        };
      });
    },
    [activeFileId, isPreviewableFile],
  );

  const computeLayoutFromOpenColumns = useCallback(
    (columns: WorkspaceColumnId[]) => {
      const normalized = normalizeOpenColumns(columns, "editor");
      const layout = WORKSPACE_COLUMN_ORDER.map(() => 0);
      if (normalized.length === 1) {
        const idx = getColumnIndex(normalized[0]);
        layout[idx] = 100;
        return layout;
      }
      const [left, right] = normalized as [
        WorkspaceColumnId,
        WorkspaceColumnId,
      ];
      // Current is the editor: exchanging Incoming and preview must preserve its width.
      const ratioKey =
        right === "incoming" ? "editor|pdf" : getOrderedPairKey(left, right);
      const storedRatio = pairRatioByKeyRef.current[ratioKey] ?? 50;
      const leftWidth = Math.max(
        OPEN_COLUMN_MIN_PERCENT,
        Math.min(100 - OPEN_COLUMN_MIN_PERCENT, storedRatio),
      );
      layout[getColumnIndex(left)] = leftWidth;
      layout[getColumnIndex(right)] = 100 - leftWidth;
      return layout;
    },
    [],
  );

  const resolveAssistOpenColumns = useCallback((): WorkspaceColumnId[] => {
    if (hasWholeFileComparison) return ["editor", "incoming"];
    if (!isPreviewableFile) {
      return ["editor"];
    }
    if (viewMode === "editor") return ["editor"];
    if (viewMode === "pdf") return ["pdf"];
    return ["editor", "pdf"];
  }, [hasWholeFileComparison, isPreviewableFile, viewMode]);

  const resolveDirectOpenColumns = useCallback((): WorkspaceColumnId[] => {
    if (hasWholeFileComparison) return ["editor", "incoming"];
    const content = isPreviewableFile ? workspaceChatRightPanelMode : "editor";
    return ["chat", content];
  }, [hasWholeFileComparison, workspaceChatRightPanelMode, isPreviewableFile]);

  const getWorkspaceChatDrawerAnchor =
    useCallback((): DrawerHostAnchor | null => {
      const modeArea = modeAreaRef.current;
      if (!modeArea) return null;

      const readRect = createLayoutRectReader(modeArea);
      const modeRect = readRect(modeArea);
      const total = Math.max(
        1,
        workspaceChatLayoutRef.current[0] + workspaceChatLayoutRef.current[1],
      );
      const targetWidth = Math.max(
        1,
        Math.min(
          modeRect.width,
          Math.round(
            (modeRect.width * workspaceChatLayoutRef.current[0]) / total,
          ),
        ),
      );

      return {
        shellTop: 0,
        shellLeft: 0,
        shellWidth: targetWidth,
        shellHeight: Math.max(0, modeRect.height),
        clipTop: 0,
        clipHeight: Math.max(0, modeRect.height),
      };
    }, []);

  const getDrawerAnchorSnapshot = useCallback(() => {
    const modeArea = modeAreaRef.current;
    if (!modeArea) return;

    const readRect = createLayoutRectReader(modeArea);
    const modeRect = readRect(modeArea);
    let nextShellTop = 0;
    let nextShellLeft = 0;
    let nextShellWidth = modeRect.width;
    let nextShellHeight = modeRect.height;
    let nextClipTop = 0;
    let nextClipHeight = modeRect.height;

    const editorDrawerShell = editorPanelRef.current?.querySelector(
      "[data-drawer-shell='true']",
    ) as HTMLElement | null;
    const editorDrawerHost = editorPanelRef.current?.querySelector(
      "[data-drawer-host='true']",
    ) as HTMLElement | null;
    const editorShellRect = editorDrawerShell
      ? readRect(editorDrawerShell)
      : undefined;
    const editorHostRect = editorDrawerHost
      ? readRect(editorDrawerHost)
      : undefined;
    const pdfRect = pdfPanelRef.current
      ? readRect(pdfPanelRef.current)
      : undefined;

    if (effectiveViewMode === "pdf") {
      if (pdfRect && pdfRect.width > 1) {
        nextShellTop = Math.max(0, pdfRect.top - modeRect.top);
        nextShellHeight = Math.max(
          0,
          Math.min(pdfRect.height, modeRect.height - nextShellTop),
        );
        nextClipHeight = nextShellHeight;
      }
    } else if (editorHostRect && editorHostRect.height > 1) {
      nextClipTop = Math.max(0, editorHostRect.top - modeRect.top);
      nextClipHeight = Math.max(
        0,
        Math.min(editorHostRect.height, modeRect.height - nextClipTop),
      );
    }

    if (drawerTracksEditorHalf) {
      if (editorShellRect && editorShellRect.width > 1) {
        nextShellTop = Math.max(0, editorShellRect.top - modeRect.top);
        nextShellLeft = Math.max(0, editorShellRect.left - modeRect.left);
        nextShellWidth = Math.max(
          1,
          Math.min(editorShellRect.width, modeRect.width - nextShellLeft),
        );
        nextShellHeight = Math.max(
          0,
          Math.min(editorShellRect.height, modeRect.height - nextShellTop),
        );
      }
      if (isSplitFromPdfTransition) {
        if (pdfRect && pdfRect.width > 1) {
          nextShellWidth = Math.max(1, Math.min(pdfRect.width, modeRect.width));
        }
      }
      if (editorHostRect && editorHostRect.height > 1) {
        nextClipTop = Math.max(
          0,
          editorHostRect.top - (modeRect.top + nextShellTop),
        );
        nextClipHeight = Math.max(
          0,
          Math.min(editorHostRect.height, nextShellHeight - nextClipTop),
        );
      }
    } else {
      nextClipTop = Math.max(0, nextClipTop);
      nextClipHeight = Math.max(
        0,
        Math.min(nextClipHeight, nextShellHeight - nextClipTop),
      );
    }

    return {
      shellTop: nextShellTop,
      shellLeft: nextShellLeft,
      shellWidth: nextShellWidth,
      shellHeight: nextShellHeight,
      clipTop: nextClipTop,
      clipHeight: nextClipHeight,
    };
  }, [drawerTracksEditorHalf, effectiveViewMode, isSplitFromPdfTransition]);

  const getVisibleDrawerPanelAnchor =
    useCallback((): DrawerHostAnchor | null => {
      const modeArea = modeAreaRef.current;
      if (!modeArea) return null;

      const panel = modeArea.querySelector(
        "[data-chat-drawer-panel='true']",
      ) as HTMLElement | null;
      if (!panel) return null;

      const readRect = createLayoutRectReader(modeArea);
      const modeRect = readRect(modeArea);
      const panelRect = readRect(panel);
      const shellTop = Math.max(0, panelRect.top - modeRect.top);
      const shellLeft = Math.max(0, panelRect.left - modeRect.left);
      const shellWidth = Math.max(
        1,
        Math.min(panelRect.width, modeRect.width - shellLeft),
      );
      const shellHeight = Math.max(
        1,
        Math.min(panelRect.height, modeRect.height - shellTop),
      );

      return {
        shellTop,
        shellLeft,
        shellWidth,
        shellHeight,
        clipTop: 0,
        clipHeight: shellHeight,
      };
    }, []);

  const getProjectedDrawerAnchor = useCallback((): DrawerHostAnchor | null => {
    const modeArea = modeAreaRef.current;
    if (!modeArea) return null;

    const readRect = createLayoutRectReader(modeArea);
    const modeRect = readRect(modeArea);
    const editorDrawerShell = editorPanelRef.current?.querySelector(
      "[data-drawer-shell='true']",
    ) as HTMLElement | null;
    const editorDrawerHost = editorPanelRef.current?.querySelector(
      "[data-drawer-host='true']",
    ) as HTMLElement | null;
    const editorShellRect = editorDrawerShell
      ? readRect(editorDrawerShell)
      : undefined;
    const editorHostRect = editorDrawerHost
      ? readRect(editorDrawerHost)
      : undefined;
    const pdfRect = pdfPanelRef.current
      ? readRect(pdfPanelRef.current)
      : undefined;

    const sidecarMode: WorkspaceViewMode = isPreviewableFile
      ? viewMode
      : "editor";
    const nextShellTop =
      sidecarMode === "pdf" && pdfRect
        ? Math.max(0, pdfRect.top - modeRect.top)
        : editorShellRect
          ? Math.max(0, editorShellRect.top - modeRect.top)
          : 0;
    const nextShellHeight = Math.max(1, modeRect.height - nextShellTop);
    let nextShellWidth = modeRect.width;
    if (sidecarMode === "split") {
      const total = Math.max(
        1,
        splitLayoutRef.current[0] + splitLayoutRef.current[1],
      );
      nextShellWidth = Math.max(
        1,
        Math.min(
          modeRect.width,
          Math.round((modeRect.width * splitLayoutRef.current[0]) / total),
        ),
      );
    }

    let nextClipTop = 0;
    let nextClipHeight = nextShellHeight;
    if (editorHostRect) {
      const shellTopAbsolute = modeRect.top + nextShellTop;
      nextClipTop = Math.max(0, editorHostRect.top - shellTopAbsolute);
      nextClipHeight = Math.max(
        0,
        Math.min(editorHostRect.height, nextShellHeight - nextClipTop),
      );
    }

    return {
      shellTop: nextShellTop,
      shellLeft: 0,
      shellWidth: nextShellWidth,
      shellHeight: nextShellHeight,
      clipTop: nextClipTop,
      clipHeight: nextClipHeight,
    };
  }, [isPreviewableFile, viewMode]);

  const updateDrawerAnchor = useCallback(() => {
    if (drawerAnchorLockRef.current) return;
    const next = getDrawerAnchorSnapshot();
    if (!next) return;

    setDrawerAnchor((prev) => {
      if (
        prev &&
        Math.abs(prev.shellTop - next.shellTop) < 0.5 &&
        Math.abs(prev.shellLeft - next.shellLeft) < 0.5 &&
        Math.abs(prev.shellWidth - next.shellWidth) < 0.5 &&
        Math.abs(prev.shellHeight - next.shellHeight) < 0.5 &&
        Math.abs(prev.clipTop - next.clipTop) < 0.5 &&
        Math.abs(prev.clipHeight - next.clipHeight) < 0.5
      ) {
        return prev;
      }
      return next;
    });
  }, [getDrawerAnchorSnapshot]);

  const beginSidebarTransition = useCallback(() => {
    if (sidebarTransitionTimerRef.current != null) {
      clearTimeout(sidebarTransitionTimerRef.current);
      sidebarTransitionTimerRef.current = null;
    }
    setIsSidebarTransitioning(true);
    sidebarTransitionTimerRef.current = setTimeout(() => {
      setIsSidebarTransitioning(false);
      sidebarTransitionTimerRef.current = null;
    }, SIDEBAR_TOGGLE_ANIMATION_MS + 40);
  }, []);

  const toggleSidebar = useCallback(() => {
    beginSidebarTransition();
    setIsSidebarCollapsed((collapsed) => !collapsed);
  }, [beginSidebarTransition]);

  const resetWorkspaceSplit = useCallback((event: MouseEvent<unknown>) => {
    // Navigation buttons inside the divider keep their own double-click behavior.
    if (event.target !== event.currentTarget) return;
    const group = contentGroupRef.current;
    const columns = openColumnsRef.current;
    if (!group || columns.length !== 2 || isAnimatingColumnLayoutRef.current) {
      return;
    }
    group.setLayout(
      WORKSPACE_COLUMN_ORDER.map((column) =>
        columns.includes(column) ? 50 : 0,
      ),
    );
  }, []);

  const clearModeTransitionGuardTimer = useCallback(() => {
    if (modeTransitionGuardTimerRef.current == null) return;
    clearTimeout(modeTransitionGuardTimerRef.current);
    modeTransitionGuardTimerRef.current = null;
  }, []);

  const clearDrawerEnterPreflight = useCallback(() => {
    if (drawerEnterPreflightRafRef.current != null) {
      cancelAnimationFrame(drawerEnterPreflightRafRef.current);
      drawerEnterPreflightRafRef.current = null;
    }
    if (drawerEnterPreflightTimeoutRef.current != null) {
      clearTimeout(drawerEnterPreflightTimeoutRef.current);
      drawerEnterPreflightTimeoutRef.current = null;
    }
  }, []);

  const clearComposerTransferTimers = useCallback(() => {
    clearDrawerEnterPreflight();
    if (composerTransferTimersRef.current.length > 0) {
      for (const timerId of composerTransferTimersRef.current) {
        clearTimeout(timerId);
      }
      composerTransferTimersRef.current = [];
    }
    drawerAnchorLockRef.current = false;
  }, [clearDrawerEnterPreflight]);

  const runDrawerEnterWithStabilizedAnchor = useCallback(
    (token: number, startEnter: () => void) => {
      clearDrawerEnterPreflight();
      let frameCount = 0;
      let stableFrames = 0;
      let previousAnchor: DrawerHostAnchor | null = null;
      let lastAnchor: DrawerHostAnchor | null = null;

      const finalize = (anchor: DrawerHostAnchor | null) => {
        clearDrawerEnterPreflight();
        if (composerTransferTokenRef.current !== token) return;
        if (anchor) {
          setDrawerAnchor(anchor);
        }
        drawerAnchorLockRef.current = true;
        startEnter();
      };

      drawerEnterPreflightTimeoutRef.current = setTimeout(() => {
        finalize(lastAnchor);
      }, DRAWER_ANCHOR_STABILIZE_TIMEOUT_MS);

      const tick = () => {
        if (composerTransferTokenRef.current !== token) {
          clearDrawerEnterPreflight();
          return;
        }

        frameCount += 1;
        const currentAnchor = getDrawerAnchorSnapshot() ?? null;
        if (currentAnchor) {
          lastAnchor = currentAnchor;
          if (previousAnchor && anchorsEqual(previousAnchor, currentAnchor)) {
            stableFrames += 1;
          } else {
            stableFrames = 0;
          }
          previousAnchor = currentAnchor;
        }

        if (
          stableFrames >= DRAWER_ANCHOR_STABILIZE_FRAMES ||
          frameCount >= DRAWER_ANCHOR_STABILIZE_FRAME_CAP
        ) {
          finalize(lastAnchor);
          return;
        }

        drawerEnterPreflightRafRef.current = requestAnimationFrame(tick);
      };

      drawerEnterPreflightRafRef.current = requestAnimationFrame(tick);
    },
    [clearDrawerEnterPreflight, getDrawerAnchorSnapshot],
  );

  const runDrawerComposerEnterTransition = useCallback(
    (
      token: number,
      options?: {
        resyncAnchorOnComplete?: boolean;
        unlockDrawerAnchorOnComplete?: boolean;
      },
    ) => {
      setComposerTransferPhase("drawer_enter");
      const resyncAnchorOnComplete = options?.resyncAnchorOnComplete ?? true;
      const unlockDrawerAnchorOnComplete =
        options?.unlockDrawerAnchorOnComplete ?? false;
      const completeEnter = () => {
        if (composerTransferTokenRef.current !== token) return;
        setComposerTransferPhase("idle");
        setForceHidePanelComposer(false);
        if (resyncAnchorOnComplete) {
          window.requestAnimationFrame(() => {
            updateDrawerAnchor();
          });
        }
        if (unlockDrawerAnchorOnComplete) {
          const unlockTimer = setTimeout(() => {
            if (composerTransferTokenRef.current !== token) return;
            drawerAnchorLockRef.current = false;
          }, DRAWER_ANCHOR_UNLOCK_DELAY_MS);
          composerTransferTimersRef.current.push(unlockTimer);
        }
      };

      const composerShell = modeAreaRef.current?.querySelector(
        "[data-chat-drawer-panel='true'] [data-chat-composer-shell='true']",
      ) as HTMLElement | null;

      const onDrawerComposerEnterEnd = (event: TransitionEvent) => {
        if (event.target !== composerShell) return;
        if (event.propertyName !== "transform") return;
        composerShell?.removeEventListener(
          "transitionend",
          onDrawerComposerEnterEnd,
        );
        completeEnter();
      };

      composerShell?.addEventListener(
        "transitionend",
        onDrawerComposerEnterEnd,
      );

      const targetEnterTimer = setTimeout(() => {
        composerShell?.removeEventListener(
          "transitionend",
          onDrawerComposerEnterEnd,
        );
        completeEnter();
      }, COMPOSER_TRANSFER_TARGET_ENTER_MS + 140);
      composerTransferTimersRef.current.push(targetEnterTimer);
    },
    [updateDrawerAnchor],
  );

  const runDrawerToWorkspaceComposerTransfer = useCallback(
    (onModeSwitch: () => void) => {
      const token = composerTransferTokenRef.current + 1;
      composerTransferTokenRef.current = token;
      clearComposerTransferTimers();
      setForceHidePanelComposer(false);
      setComposerTransferPhase("drawer_exit");

      const sourceExitTimer = setTimeout(() => {
        if (composerTransferTokenRef.current !== token) return;
        onModeSwitch();
        setComposerTransferPhase("panel_enter_prep");

        const panelPrepTimer = setTimeout(() => {
          window.requestAnimationFrame(() => {
            if (composerTransferTokenRef.current !== token) return;
            setComposerTransferPhase("panel_enter");
            const targetEnterTimer = setTimeout(() => {
              if (composerTransferTokenRef.current !== token) return;
              setComposerTransferPhase("idle");
              setForceHidePanelComposer(false);
            }, COMPOSER_TRANSFER_TARGET_ENTER_MS);
            composerTransferTimersRef.current.push(targetEnterTimer);
          });
        }, WORKSPACE_PANEL_EXPAND_ANIMATION_MS);
        composerTransferTimersRef.current.push(panelPrepTimer);
      }, COMPOSER_TRANSFER_SOURCE_EXIT_MS);
      composerTransferTimersRef.current.push(sourceExitTimer);
    },
    [clearComposerTransferTimers],
  );

  const runWorkspaceToDrawerComposerTransfer = useCallback(
    (onModeSwitch: () => void) => {
      const token = composerTransferTokenRef.current + 1;
      composerTransferTokenRef.current = token;
      clearComposerTransferTimers();
      setForceHidePanelComposer(false);
      setComposerTransferPhase("panel_exit");

      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          if (composerTransferTokenRef.current !== token) return;
          const sourceExitTimer = setTimeout(() => {
            if (composerTransferTokenRef.current !== token) return;
            setForceHidePanelComposer(true);
            onModeSwitch();
            setComposerTransferPhase("drawer_enter_prep");

            const drawerPrepTimer = setTimeout(() => {
              window.requestAnimationFrame(() => {
                if (composerTransferTokenRef.current !== token) return;
                runDrawerEnterWithStabilizedAnchor(token, () => {
                  runDrawerComposerEnterTransition(token, {
                    resyncAnchorOnComplete: false,
                    unlockDrawerAnchorOnComplete: true,
                  });
                });
              });
            }, WORKSPACE_PANEL_EXPAND_ANIMATION_MS);
            composerTransferTimersRef.current.push(drawerPrepTimer);
          }, COMPOSER_TRANSFER_REVERSE_SOURCE_EXIT_MS);
          composerTransferTimersRef.current.push(sourceExitTimer);
        });
      });
    },
    [
      clearComposerTransferTimers,
      runDrawerComposerEnterTransition,
      runDrawerEnterWithStabilizedAnchor,
    ],
  );

  const runWorkspaceToArtisanComposerTransfer = useCallback(
    (onModeSwitch: () => void) => {
      const token = composerTransferTokenRef.current + 1;
      composerTransferTokenRef.current = token;
      clearComposerTransferTimers();
      setForceHidePanelComposer(false);
      setComposerTransferPhase("panel_tv_exit");

      const composerShell = modeAreaRef.current?.querySelector(
        "[data-workspace-chat-pane='true'] [data-chat-composer-shell='true']",
      ) as HTMLElement | null;

      const completeExit = () => {
        if (composerTransferTokenRef.current !== token) return;
        setForceHidePanelComposer(true);
        onModeSwitch();
        const clearAfterLayoutTimer = setTimeout(() => {
          if (composerTransferTokenRef.current !== token) return;
          setComposerTransferPhase("idle");
          setForceHidePanelComposer(false);
        }, WORKSPACE_PANEL_EXPAND_ANIMATION_MS + 40);
        composerTransferTimersRef.current.push(clearAfterLayoutTimer);
      };

      const onPanelComposerExitEnd = (event: AnimationEvent) => {
        if (event.target !== composerShell) return;
        if (event.animationName !== "workspace-drawer-tv-off") return;
        composerShell?.removeEventListener(
          "animationend",
          onPanelComposerExitEnd,
        );
        completeExit();
      };

      composerShell?.addEventListener("animationend", onPanelComposerExitEnd);

      const exitFallbackTimer = setTimeout(() => {
        composerShell?.removeEventListener(
          "animationend",
          onPanelComposerExitEnd,
        );
        completeExit();
      }, PANEL_TV_EXIT_MS + 140);
      composerTransferTimersRef.current.push(exitFallbackTimer);
    },
    [clearComposerTransferTimers],
  );

  const runArtisanToWorkspaceComposerTransfer = useCallback(
    (onModeSwitch: () => void) => {
      const token = composerTransferTokenRef.current + 1;
      composerTransferTokenRef.current = token;
      clearComposerTransferTimers();
      setForceHidePanelComposer(false);
      setComposerTransferPhase("panel_enter_prep");
      onModeSwitch();

      const panelPrepTimer = setTimeout(() => {
        window.requestAnimationFrame(() => {
          if (composerTransferTokenRef.current !== token) return;
          setComposerTransferPhase("panel_enter");
          const targetEnterTimer = setTimeout(() => {
            if (composerTransferTokenRef.current !== token) return;
            setComposerTransferPhase("idle");
            setForceHidePanelComposer(false);
          }, COMPOSER_TRANSFER_TARGET_ENTER_MS);
          composerTransferTimersRef.current.push(targetEnterTimer);
        });
      }, WORKSPACE_PANEL_EXPAND_ANIMATION_MS);
      composerTransferTimersRef.current.push(panelPrepTimer);
    },
    [clearComposerTransferTimers],
  );

  const getBackLayerHandoffTransform = useCallback(() => {
    const modeArea = modeAreaRef.current;
    if (!modeArea) return null;
    const readRect = createLayoutRectReader(modeArea);
    const modeRect = readRect(modeArea);
    if (modeRect.width <= 1) return null;

    const total = Math.max(
      1,
      workspaceChatLayoutRef.current[0] + workspaceChatLayoutRef.current[1],
    );
    const leftWidth =
      (modeRect.width * workspaceChatLayoutRef.current[0]) / total;
    const rightScale = Math.max(
      0.0001,
      workspaceChatLayoutRef.current[1] / total,
    );

    return `translate3d(${leftWidth}px, 0, 0) scaleX(${rightScale})`;
  }, []);

  const getBackLayerSidecarTransformFromDirect = useCallback(() => {
    const modeArea = modeAreaRef.current;
    if (!modeArea) return null;
    const readRect = createLayoutRectReader(modeArea);
    const modeRect = readRect(modeArea);
    if (modeRect.width <= 1) return null;

    const total = Math.max(
      1,
      workspaceChatLayoutRef.current[0] + workspaceChatLayoutRef.current[1],
    );
    const leftWidth =
      (modeRect.width * workspaceChatLayoutRef.current[0]) / total;
    const rightScale = Math.max(
      0.0001,
      workspaceChatLayoutRef.current[1] / total,
    );
    const inverseScale = 1 / rightScale;

    return `translate3d(${-leftWidth}px, 0, 0) scaleX(${inverseScale})`;
  }, []);

  const runCompositorTransition = useCallback(
    ({
      direction,
      startAnchor,
      targetAnchor,
      backStartTransform,
      backEndTransform,
      onCommit,
    }: {
      direction: ModeTransitionDirection;
      startAnchor: DrawerHostAnchor;
      targetAnchor: DrawerHostAnchor;
      backStartTransform: string;
      backEndTransform: string;
      onCommit: () => void;
    }) => {
      const frontNode = drawerTransitionShellRef.current;
      const backNode = contentAreaRef.current;
      if (!frontNode || !backNode) {
        onCommit();
        return;
      }

      const token = modeTransitionTokenRef.current + 1;
      modeTransitionTokenRef.current = token;
      clearModeTransitionGuardTimer();

      let finished = false;
      let frontComplete = false;
      let backComplete = false;

      const completeIfReady = () => {
        if (finished) return;
        if (!frontComplete || !backComplete) return;
        finished = true;
        cleanup();
        if (modeTransitionTokenRef.current !== token) return;
        onCommit();
      };

      const onFrontEnd = (event: TransitionEvent) => {
        if (event.target !== frontNode) return;
        if (
          event.propertyName !== "top" &&
          event.propertyName !== "left" &&
          event.propertyName !== "width" &&
          event.propertyName !== "height"
        ) {
          return;
        }
        frontComplete = true;
        completeIfReady();
      };

      const onBackEnd = (event: TransitionEvent) => {
        if (event.target !== backNode) return;
        if (event.propertyName !== "transform") return;
        backComplete = true;
        completeIfReady();
      };

      const cleanup = () => {
        frontNode.removeEventListener("transitionend", onFrontEnd);
        backNode.removeEventListener("transitionend", onBackEnd);
        clearModeTransitionGuardTimer();
      };

      frontNode.addEventListener("transitionend", onFrontEnd);
      backNode.addEventListener("transitionend", onBackEnd);
      modeTransitionGuardTimerRef.current = setTimeout(
        () => {
          frontComplete = true;
          backComplete = true;
          completeIfReady();
        },
        FRONT_MORPH_DURATION_MS +
          BACK_MORPH_DELAY_MS +
          BACK_MORPH_DURATION_MS +
          160,
      );

      setModeTransitionPhase(direction);
      setDrawerPresence("transfer");
      setWorkspaceDrawerAnchor(startAnchor);
      setFrontMorphToPanel(direction === "direct_to_assist");
      setBackLayerTransition("none");
      setBackLayerTransform(backStartTransform);

      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          if (modeTransitionTokenRef.current !== token) return;
          setWorkspaceDrawerAnchor((current) =>
            current && anchorsEqual(current, targetAnchor)
              ? current
              : targetAnchor,
          );
          setFrontMorphToPanel(direction === "assist_to_direct");
          setBackLayerTransition(
            `transform ${BACK_MORPH_DURATION_MS}ms ${BACK_MORPH_EASE} ${BACK_MORPH_DELAY_MS}ms`,
          );
          setBackLayerTransform(backEndTransform);
        });
      });
    },
    [clearModeTransitionGuardTimer],
  );

  const commentLayoutTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (commentLayoutTimer.current) clearTimeout(commentLayoutTimer.current);
    },
    [],
  );
  const applyOpenColumnsLayout = useCallback(
    (
      nextColumns: WorkspaceColumnId[],
      options?: {
        animate?: boolean;
      },
    ) => {
      const normalized = normalizeOpenColumns(nextColumns, "editor");
      if (commentLayoutTimer.current) clearTimeout(commentLayoutTimer.current);
      const delay =
        openColumnsRef.current.includes("editor") !==
        normalized.includes("editor")
          ? preparePdfCommentLayout(
              modeAreaRef.current,
              normalized.includes("editor"),
            )
          : 0;
      const apply = () => {
        if (!areOpenColumnsEqual(openColumnsRef.current, normalized)) {
          openColumnsRef.current = normalized;
          setOpenColumns(normalized);
        }

        const group = contentGroupRef.current;
        if (!group) return;
        const target = computeLayoutFromOpenColumns(normalized);

        if (!hasInitializedLayoutRef.current) {
          hasInitializedLayoutRef.current = true;
          group.setLayout(target);
          applyWorkspacePanelOpacity(target);
        } else if (options?.animate === false) {
          stopRunningAnimation();
          group.setLayout(target);
          applyWorkspacePanelOpacity(target);
        } else {
          const current = group.getLayout();
          animateWorkspaceLayout(current, target);
        }

        if (normalized.includes("chat")) {
          const chatWidth = target[getColumnIndex("chat")];
          const nextHeaderLayout: [number, number] = [
            chatWidth,
            100 - chatWidth,
          ];
          workspaceChatLayoutRef.current = nextHeaderLayout;
          setWorkspaceChatHeaderLayout(nextHeaderLayout);
        }
      };
      if (delay) commentLayoutTimer.current = setTimeout(apply, delay);
      else apply();
    },
    [
      animateWorkspaceLayout,
      applyWorkspacePanelOpacity,
      computeLayoutFromOpenColumns,
      stopRunningAnimation,
    ],
  );

  const runAssistToDirectTransition = useCallback(() => {
    const assistOpenColumns = resolveAssistOpenColumns();
    assistLayoutSnapshotRef.current = {
      viewMode,
      openColumns: assistOpenColumns,
    };
    const applyModeSwitch = () => {
      modeTransitionTokenRef.current += 1;
      clearModeTransitionGuardTimer();
      setModeTransitionPhase("idle");
      setWorkspaceDrawerAnchor(null);
      setFrontMorphToPanel(false);
      setBackLayerTransform(null);
      setBackLayerTransition("none");
      setDrawerPresence("hidden");
      setDrawerIntroPhase("idle");
      setWorkspacePreferences({ mode: "duet", chatLayout: "workspace" });
      const snapshotMode =
        assistLayoutSnapshotRef.current?.viewMode ?? viewMode;
      const entryColumns: WorkspaceColumnId[] = hasWholeFileComparison
        ? ["editor", "incoming"]
        : !isPreviewableFile
          ? ["chat", "editor"]
          : snapshotMode === "split"
            ? ["chat", workspaceChatRightPanelMode]
            : snapshotMode === "pdf"
              ? ["chat", "pdf"]
              : ["chat", "editor"];
      applyOpenColumnsLayout(entryColumns);
    };

    if (isDrawerChat) {
      runDrawerToWorkspaceComposerTransfer(applyModeSwitch);
      return;
    }
    if (workspaceMode === "artisan") {
      runArtisanToWorkspaceComposerTransfer(applyModeSwitch);
      return;
    }
    applyModeSwitch();
  }, [
    workspacePreferences,
    applyOpenColumnsLayout,
    clearModeTransitionGuardTimer,
    workspaceChatRightPanelMode,
    hasWholeFileComparison,
    isPreviewableFile,
    resolveAssistOpenColumns,
    runArtisanToWorkspaceComposerTransfer,
    runDrawerToWorkspaceComposerTransfer,
    viewMode,
  ]);

  const runDirectToAssistTransition = useCallback(
    (nextPreferences: ProjectWorkspacePreferences) => {
      const snapshot = assistLayoutSnapshotRef.current;
      const restoredColumns = normalizeOpenColumns(
        hasWholeFileComparison
          ? ["editor", "incoming"]
          : (snapshot?.openColumns ?? resolveAssistOpenColumns()),
        "editor",
      );
      const applyModeSwitch = () => {
        if (snapshot?.viewMode) {
          setViewMode(snapshot.viewMode);
        }
        modeTransitionTokenRef.current += 1;
        clearModeTransitionGuardTimer();
        setModeTransitionPhase("idle");
        setWorkspaceDrawerAnchor(null);
        setFrontMorphToPanel(false);
        setBackLayerTransform(null);
        setBackLayerTransition("none");
        setWorkspacePreferences(nextPreferences);
        setDrawerPresence(
          nextPreferences.mode === "duet" ? "visible" : "hidden",
        );
        setDrawerIntroPhase("idle");
        applyOpenColumnsLayout(restoredColumns);
        window.requestAnimationFrame(() => {
          updateDrawerAnchor();
        });
      };
      if (nextPreferences.mode === "duet") {
        runWorkspaceToDrawerComposerTransfer(applyModeSwitch);
        return;
      }
      if (nextPreferences.mode === "artisan") {
        runWorkspaceToArtisanComposerTransfer(applyModeSwitch);
        return;
      }
      applyModeSwitch();
    },
    [
      applyOpenColumnsLayout,
      clearModeTransitionGuardTimer,
      hasWholeFileComparison,
      resolveAssistOpenColumns,
      runWorkspaceToArtisanComposerTransfer,
      runWorkspaceToDrawerComposerTransfer,
      updateDrawerAnchor,
    ],
  );

  const showDuetDrawer = useCallback(() => {
    const token = composerTransferTokenRef.current + 1;
    composerTransferTokenRef.current = token;
    clearComposerTransferTimers();
    setComposerTransferPhase("drawer_enter_prep");
    setForceHidePanelComposer(false);
    setArtisanToDuetFadeActive(true);
    const projectedAnchor = getProjectedDrawerAnchor();
    if (projectedAnchor) {
      setDrawerAnchor(projectedAnchor);
    }
    exitingDrawerAnchorRef.current = null;
    setDrawerPresence("visible");
    // Mount invisibly while the new mode's layout settles. Revealing first
    // exposes provisional anchor geometry, especially on slower renderers.
    setDrawerIntroPhase("preparing");
    runDrawerEnterWithStabilizedAnchor(token, () => {
      setDrawerIntroPhase("revealing");
      const revealTimer = setTimeout(() => {
        if (composerTransferTokenRef.current !== token) return;
        setDrawerIntroPhase("idle");
        runDrawerComposerEnterTransition(token, {
          resyncAnchorOnComplete: false,
          unlockDrawerAnchorOnComplete: true,
        });
        setArtisanToDuetFadeActive(false);
      }, DRAWER_REVEAL_MS);
      composerTransferTimersRef.current.push(revealTimer);
    });
    setWorkspaceDrawerAnchor(null);
    setFrontMorphToPanel(false);
    setBackLayerTransform(null);
    setBackLayerTransition("none");
    return;
  }, [
    clearComposerTransferTimers,
    getProjectedDrawerAnchor,
    runDrawerEnterWithStabilizedAnchor,
    runDrawerComposerEnterTransition,
  ]);

  const hideDuetDrawer = useCallback(
    (anchor?: DrawerHostAnchor | null) => {
      composerTransferTokenRef.current += 1;
      clearComposerTransferTimers();
      setComposerTransferPhase("idle");
      setForceHidePanelComposer(false);
      drawerAnchorLockRef.current = false;
      // Exit from the rendered geometry, not a fresh measurement of the host
      // panels, which may already be resizing for the next mode or file.
      exitingDrawerAnchorRef.current =
        anchor ?? drawerAnchor ?? getDrawerAnchorSnapshot() ?? null;
      setDrawerPresence("exiting");
      setDrawerIntroPhase("idle");
      setArtisanToDuetFadeActive(false);
      setWorkspaceDrawerAnchor(null);
      setFrontMorphToPanel(false);
      setBackLayerTransform(null);
      setBackLayerTransition("none");
      return;
    },
    [clearComposerTransferTimers, getDrawerAnchorSnapshot, drawerAnchor],
  );

  // Tab-driven visibility uses the same entry/exit lifecycle as Artisan ↔ Duet.
  // Keep the drawer mounted during exit, and cancel a previous entry on rapid switches.
  useLayoutEffect(() => {
    if (!isDrawerChat || modeTransitionPhase !== "idle") return;
    if (hasWholeFileComparison) {
      if (drawerPresence === "visible") hideDuetDrawer(drawerAnchor);
    } else if (drawerPresence === "hidden" || drawerPresence === "exiting") {
      showDuetDrawer();
    }
  }, [
    workspacePreferences,
    modeTransitionPhase,
    hasWholeFileComparison,
    drawerPresence,
    drawerAnchor,
    hideDuetDrawer,
    showDuetDrawer,
  ]);

  const requestWorkspacePreferences = useCallback(
    (next: ProjectWorkspacePreferences) => {
      if (next.mode === workspaceMode && next.chatLayout === chatLayout) return;
      if (modeTransitionPhase !== "idle" || composerTransferPhase !== "idle")
        return;
      setSidebarTarget(next);
      const nextWorkspaceChat =
        next.mode === "duet" && next.chatLayout === "workspace";
      if (!isWorkspaceChat && nextWorkspaceChat) {
        runAssistToDirectTransition();
        return;
      }
      if (isWorkspaceChat && !nextWorkspaceChat) {
        runDirectToAssistTransition(next);
        return;
      }
      if (workspaceMode === "artisan" && next.mode === "duet") {
        setWorkspacePreferences(next);
        if (hasWholeFileComparison) setDrawerPresence("hidden");
        else showDuetDrawer();
        return;
      }
      if (isDrawerChat && next.mode === "artisan") hideDuetDrawer();
      setWorkspacePreferences(next);
    },
    [
      workspaceMode,
      chatLayout,
      isWorkspaceChat,
      isDrawerChat,
      modeTransitionPhase,
      composerTransferPhase,
      runAssistToDirectTransition,
      runDirectToAssistTransition,
      hasWholeFileComparison,
      showDuetDrawer,
      hideDuetDrawer,
      setWorkspacePreferences,
    ],
  );
  // Drawer geometry changes its transition callbacks throughout panel motion.
  // Keep the sidebar event stable while using the current transition policy.
  const workspaceModeRequest = useRef({
    requestWorkspacePreferences,
    chatLayout,
  });
  workspaceModeRequest.current = { requestWorkspacePreferences, chatLayout };
  const requestWorkspaceMode = useCallback((mode: WorkspaceMode) => {
    const current = workspaceModeRequest.current;
    current.requestWorkspacePreferences({
      mode,
      chatLayout: current.chatLayout,
    });
  }, []);
  const chatDisplayControl = (
    <ButtonGroup
      aria-label="Chat display"
      className="flex w-max items-center gap-1"
    >
      {(["Collapsed", "Expanded", "Workspace"] as const).map((label) => {
        const selected = isWorkspaceChat
          ? label === "Workspace"
          : label === (chatDrawerOpen ? "Expanded" : "Collapsed");
        const fillTop =
          label === "Collapsed" ? 16 : label === "Expanded" ? 11 : 5.5;
        return (
          <Button
            key={label}
            type="button"
            variant="ghost"
            size="xs"
            aria-pressed={selected}
            data-chat-display={label}
            disabled={
              modeTransitionPhase !== "idle" || composerTransferPhase !== "idle"
            }
            className={cn(
              selected
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:bg-background/70 hover:text-foreground",
            )}
            onClick={() => {
              if (label === "Workspace")
                requestWorkspacePreferences({
                  mode: "duet",
                  chatLayout: "workspace",
                });
              else {
                setChatDrawerOpen(label === "Expanded");
                requestWorkspacePreferences({
                  mode: "duet",
                  chatLayout: "drawer",
                });
              }
            }}
          >
            <svg
              aria-hidden="true"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="3" y="3" width="18" height="18" rx="3" />
              <rect
                x="5.5"
                y={fillTop}
                width="13"
                height={18.5 - fillTop}
                rx="1"
                fill="currentColor"
                stroke="none"
              />
            </svg>
            {{ Collapsed: "Mini", Expanded: "Half", Workspace: "Full" }[label]}
          </Button>
        );
      })}
    </ButtonGroup>
  );

  useEffect(() => {
    const useArtisan = () => requestWorkspaceMode("artisan");
    window.addEventListener(ARTISAN_MODE_REQUEST_EVENT, useArtisan);
    return () =>
      window.removeEventListener(ARTISAN_MODE_REQUEST_EVENT, useArtisan);
  }, [requestWorkspaceMode]);

  const handleWorkspacePanelsLayout = useCallback(
    (layout: number[]) => {
      let normalizedLayout = layout;

      if (showGlobalChatDrawer && drawerTracksEditorHalf) {
        updateDrawerAnchor();
      }

      if (isAnimatingColumnLayoutRef.current) {
        return;
      }

      // In handoff chat|pdf mode, dragging can transiently route width into the hidden
      // middle editor panel because handles are defined between adjacent panels.
      // Fold any leaked editor width back into PDF so drag behaves as chat<->pdf.
      if (isWorkspaceChat && openPairKey === "chat|pdf") {
        const chatIdx = getColumnIndex("chat");
        const editorIdx = getColumnIndex("editor");
        const pdfIdx = getColumnIndex("pdf");
        const chatWidth = normalizedLayout[chatIdx] ?? 0;
        const editorWidth = normalizedLayout[editorIdx] ?? 0;
        const pdfWidth = normalizedLayout[pdfIdx] ?? 0;
        if (chatWidth > 0.5 && editorWidth > 0.1) {
          normalizedLayout = [...normalizedLayout];
          normalizedLayout[editorIdx] = 0;
          normalizedLayout[pdfIdx] = Math.max(0, pdfWidth + editorWidth);
          contentGroupRef.current?.setLayout(normalizedLayout);
        }
      }

      // The editor/preview divider passes over the collapsed Incoming column.
      // Fold drag width into the visible preview, as for the hidden editor in handoff mode.
      if (!hasWholeFileComparison && openColumnsRef.current.includes("pdf")) {
        const incomingIdx = getColumnIndex("incoming");
        const pdfIdx = getColumnIndex("pdf");
        if (normalizedLayout[incomingIdx] > 0.01) {
          normalizedLayout = [...normalizedLayout];
          normalizedLayout[pdfIdx] += normalizedLayout[incomingIdx];
          normalizedLayout[incomingIdx] = 0;
          contentGroupRef.current?.setLayout(normalizedLayout);
        }
      }

      const rankedColumns = WORKSPACE_COLUMN_ORDER.map((column) => ({
        column,
        width: normalizedLayout[getColumnIndex(column)] ?? 0,
      }))
        .filter((entry) => entry.width > 0.01)
        .sort((left, right) => right.width - left.width);

      const visibleColumns = normalizeOpenColumns(
        rankedColumns.slice(0, 2).map((entry) => entry.column),
        "editor",
      );

      // Ignore stale cross-mode layouts right after mode switches.
      if (hasWholeFileComparison && visibleColumns.includes("chat")) return;
      if (
        isWorkspaceChat &&
        !hasWholeFileComparison &&
        !visibleColumns.includes("chat")
      ) {
        return;
      }
      if (!isWorkspaceChat && visibleColumns.includes("chat")) {
        return;
      }

      if (!areOpenColumnsEqual(openColumnsRef.current, visibleColumns)) {
        openColumnsRef.current = visibleColumns;
        setOpenColumns(visibleColumns);
      }

      if (visibleColumns.length === 2) {
        const [left, right] = visibleColumns as [
          WorkspaceColumnId,
          WorkspaceColumnId,
        ];
        const leftValue = normalizedLayout[getColumnIndex(left)];
        const rightValue = normalizedLayout[getColumnIndex(right)];
        const total = leftValue + rightValue;
        if (total > 0.01) {
          const ratio = (leftValue / total) * 100;
          const key =
            right === "incoming"
              ? "editor|pdf"
              : getOrderedPairKey(left, right);
          setPairRatioByKey((current) => {
            const existing = current[key] ?? 50;
            if (Math.abs(existing - ratio) < 0.5) return current;
            return {
              ...current,
              [key]: ratio,
            };
          });
        }
      }

      if (
        !hasWholeFileComparison &&
        normalizedLayout[getColumnIndex("editor")] > 0.5 &&
        normalizedLayout[getColumnIndex("pdf")] > 0.5
      ) {
        splitLayoutRef.current = [
          normalizedLayout[getColumnIndex("editor")],
          normalizedLayout[getColumnIndex("pdf")],
        ];
      }

      if (normalizedLayout[getColumnIndex("chat")] > 0.5) {
        const chatWidth = normalizedLayout[getColumnIndex("chat")];
        const nextHeaderLayout: [number, number] = [chatWidth, 100 - chatWidth];
        workspaceChatLayoutRef.current = nextHeaderLayout;
        setWorkspaceChatHeaderLayout(nextHeaderLayout);
      }
    },
    [
      workspacePreferences,
      hasWholeFileComparison,
      drawerTracksEditorHalf,
      openPairKey,
      showGlobalChatDrawer,
      updateDrawerAnchor,
    ],
  );

  const isCurrentLayoutAtTarget = useCallback(
    (targetColumns: WorkspaceColumnId[]) => {
      const group = contentGroupRef.current;
      if (!group) return false;
      const current = group.getLayout();
      const target = computeLayoutFromOpenColumns(targetColumns);
      return areLayoutsClose(current, target);
    },
    [areLayoutsClose, computeLayoutFromOpenColumns],
  );

  useLayoutEffect(() => {
    if (hasInitializedLayoutRef.current) return;
    if (!contentGroupRef.current) return;
    const initialColumns = isWorkspaceChat
      ? resolveDirectOpenColumns()
      : resolveAssistOpenColumns();
    applyOpenColumnsLayout(initialColumns, { animate: false });
  }, [
    workspacePreferences,
    applyOpenColumnsLayout,
    resolveAssistOpenColumns,
    resolveDirectOpenColumns,
  ]);

  useLayoutEffect(() => {
    if (isWorkspaceChat) return;
    const targetColumns = resolveAssistOpenColumns();
    const columnsMatch = areOpenColumnsEqual(
      openColumnsRef.current,
      targetColumns,
    );
    if (columnsMatch && isCurrentLayoutAtTarget(targetColumns)) return;
    applyOpenColumnsLayout(targetColumns);
  }, [
    workspacePreferences,
    applyOpenColumnsLayout,
    isCurrentLayoutAtTarget,
    openColumns,
    resolveAssistOpenColumns,
  ]);

  useLayoutEffect(() => {
    if (!isWorkspaceChat) return;
    const targetColumns = resolveDirectOpenColumns();
    const columnsMatch = areOpenColumnsEqual(
      openColumnsRef.current,
      targetColumns,
    );
    if (columnsMatch && isCurrentLayoutAtTarget(targetColumns)) return;
    applyOpenColumnsLayout(targetColumns);
  }, [
    workspacePreferences,
    applyOpenColumnsLayout,
    isCurrentLayoutAtTarget,
    openColumns,
    resolveDirectOpenColumns,
  ]);

  useEffect(() => {
    if (!activeFileProposedChange) {
      autoRevealedReviewRef.current = null;
      return;
    }
    if (!isWorkspaceChat || modeTransitionPhase !== "idle") return;
    const reviewKey = JSON.stringify([
      projectRoot,
      activeFileId,
      activeFileProposedChange.id,
      activeFileProposedChange.workspaceSessionId,
    ]);
    if (autoRevealedReviewRef.current === reviewKey) return;
    autoRevealedReviewRef.current = reviewKey;
    if (
      !shouldShowEditorForProposedChange({
        isWorkspaceChat,
        isRenderableLatex: isPreviewableFile,
        activeFileId,
        workspaceChatRightPanelMode,
        hasActiveFileProposedChange,
        modeTransitionPhase,
      })
    ) {
      return;
    }

    updateWorkspaceContentMode("editor");
  }, [
    activeFileProposedChange,
    projectRoot,
    activeFileId,
    workspacePreferences,
    workspaceChatRightPanelMode,
    hasActiveFileProposedChange,
    isPreviewableFile,
    modeTransitionPhase,
    updateWorkspaceContentMode,
  ]);

  useEffect(() => {
    const handleVisibilityRestored = () => {
      stopRunningAnimation();
      setDrawerViewMotion(null);
      clearModeTransitionGuardTimer();
      clearComposerTransferTimers();
      modeTransitionTokenRef.current += 1;
      composerTransferTokenRef.current += 1;
      drawerAnchorLockRef.current = false;
      exitingDrawerAnchorRef.current = null;

      setModeTransitionPhase("idle");
      setComposerTransferPhase("idle");
      setSidebarTarget(null);
      setDrawerIntroPhase("idle");
      setWorkspaceDrawerAnchor(null);
      setFrontMorphToPanel(false);
      setBackLayerTransform(null);
      setBackLayerTransition("none");
      setArtisanToDuetFadeActive(false);
      setForceHidePanelComposer(false);

      if (isDrawerChat) {
        setDrawerPresence("visible");
        window.requestAnimationFrame(() => {
          updateDrawerAnchor();
        });
        return;
      }

      setDrawerPresence("hidden");
    };

    window.addEventListener(APP_VISIBILITY_RESTORED, handleVisibilityRestored);
    return () => {
      window.removeEventListener(
        APP_VISIBILITY_RESTORED,
        handleVisibilityRestored,
      );
    };
  }, [
    workspacePreferences,
    clearComposerTransferTimers,
    clearModeTransitionGuardTimer,
    stopRunningAnimation,
    updateDrawerAnchor,
  ]);

  useEffect(() => {
    if (isWorkspaceChat) return;
    const previousMode = lastViewModeRef.current;
    const enteringSplitFromPdf = previousMode === "pdf" && viewMode === "split";
    if (enteringSplitFromPdf) {
      setIsSplitFromPdfTransition(true);
      if (splitFromPdfTimerRef.current != null) {
        clearTimeout(splitFromPdfTimerRef.current);
      }
      splitFromPdfTimerRef.current = setTimeout(() => {
        setIsSplitFromPdfTransition(false);
        splitFromPdfTimerRef.current = null;
      }, 320);
    } else if (splitFromPdfTimerRef.current != null) {
      clearTimeout(splitFromPdfTimerRef.current);
      splitFromPdfTimerRef.current = null;
      setIsSplitFromPdfTransition(false);
    }
    lastViewModeRef.current = viewMode;
  }, [workspacePreferences, viewMode]);

  useEffect(() => {
    if (
      isWorkspaceChat &&
      modeTransitionPhase === "idle" &&
      drawerPresence !== "hidden"
    ) {
      exitingDrawerAnchorRef.current = null;
      setDrawerPresence("hidden");
    }
  }, [workspacePreferences, drawerPresence, modeTransitionPhase]);

  useEffect(() => {
    if (drawerPresence === "exiting") {
      const timerId = window.setTimeout(() => {
        exitingDrawerAnchorRef.current = null;
        setDrawerPresence("hidden");
      }, DRAWER_EXIT_DURATION_MS);

      return () => {
        window.clearTimeout(timerId);
      };
    }
  }, [drawerPresence]);

  useLayoutEffect(() => {
    if (!showGlobalChatDrawer) return;
    updateDrawerAnchor();
  }, [showGlobalChatDrawer, updateDrawerAnchor]);

  const renderedDrawerAnchor =
    drawerPresence === "exiting"
      ? (exitingDrawerAnchorRef.current ?? drawerAnchor)
      : drawerPresence === "transfer"
        ? (workspaceDrawerAnchor ?? drawerAnchor)
        : drawerViewMotion && drawerAnchor
          ? interpolateDrawerAnchor(
              drawerViewMotion.from,
              drawerAnchor,
              drawerViewMotion.progress,
            )
          : drawerAnchor;
  const changeViewMode = (nextMode: WorkspaceViewMode) => {
    if (nextMode === viewMode) return;
    // Leaving Split changes the anchor policy immediately. Retain its current
    // geometry and move to the new anchor with the pane's own animation frames.
    setDrawerViewMotion(
      showGlobalChatDrawer &&
        viewMode === "split" &&
        nextMode !== "split" &&
        renderedDrawerAnchor
        ? { from: renderedDrawerAnchor, progress: 0 }
        : null,
    );
    setViewMode(nextMode);
  };
  const frontMorphGeometryDelayMs =
    drawerPresence === "transfer" && frontMorphToPanel
      ? FRONT_MORPH_GEOMETRY_DELAY_MS
      : 0;
  const disableDrawerAnchorTransition =
    drawerPresence === "exiting" ||
    artisanToDuetFadeActive ||
    (Boolean(drawerViewMotion) && drawerPresence !== "transfer") ||
    (drawerTracksEditorHalf && drawerPresence !== "transfer");
  const isDrawerComposerEntering =
    composerTransferPhase === "drawer_enter_prep" ||
    composerTransferPhase === "drawer_enter";
  const shouldForceFullDrawerClip =
    isDrawerComposerEntering && effectiveViewMode === "pdf";
  const isDrawerRevealActive =
    drawerIntroPhase === "revealing" && modeTransitionPhase === "idle";

  useLayoutEffect(() => {
    if (!isWorkspaceChat) return;
    setIsSplitFromPdfTransition(false);
    if (splitFromPdfTimerRef.current != null) {
      clearTimeout(splitFromPdfTimerRef.current);
      splitFromPdfTimerRef.current = null;
    }
  }, [isWorkspaceChat]);

  useEffect(() => {
    if (!showGlobalChatDrawer || typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver(() => {
      updateDrawerAnchor();
    });
    const editorDrawerShell = editorPanelRef.current?.querySelector(
      "[data-drawer-shell='true']",
    ) as HTMLElement | null;
    const editorDrawerHost = editorPanelRef.current?.querySelector(
      "[data-drawer-host='true']",
    ) as HTMLElement | null;

    if (modeAreaRef.current) observer.observe(modeAreaRef.current);
    if (contentAreaRef.current) observer.observe(contentAreaRef.current);
    if (editorPanelRef.current) observer.observe(editorPanelRef.current);
    if (editorDrawerShell) observer.observe(editorDrawerShell);
    if (editorDrawerHost) observer.observe(editorDrawerHost);
    if (pdfPanelRef.current) observer.observe(pdfPanelRef.current);

    return () => observer.disconnect();
  }, [showGlobalChatDrawer, updateDrawerAnchor]);

  useEffect(() => {
    if (!isSidebarCollapsed) {
      setCollapsedHeaderControlsWidth(0);
      return;
    }
    const controls = collapsedHeaderControlsRef.current;
    const headerRow = headerRowRef.current;
    if (!controls || !headerRow) return;

    const syncWidth = () => {
      const controlsRect = controls.getBoundingClientRect();
      const headerRect = headerRow.getBoundingClientRect();
      setCollapsedHeaderControlsWidth(
        Math.max(0, controlsRect.right - headerRect.left),
      );
    };

    syncWidth();

    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(syncWidth);
    observer.observe(controls);
    return () => observer.disconnect();
  }, [isSidebarCollapsed, collapsedHeaderInset, isWorkspaceChat]);

  useEffect(() => {
    if (!isWorkspaceChat || modeTransitionPhase !== "idle") return;
    const rafId = window.requestAnimationFrame(() => {
      const target = modeAreaRef.current?.querySelector(
        "[data-workspace-chat-pane='true'] textarea[data-chat-composer-input='true']",
      ) as HTMLTextAreaElement | null;
      if (!target) return;
      target.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(rafId);
  }, [workspacePreferences, modeTransitionPhase]);

  useEffect(() => {
    return () => {
      if (sidebarTransitionTimerRef.current != null) {
        clearTimeout(sidebarTransitionTimerRef.current);
      }
      if (splitFromPdfTimerRef.current != null) {
        clearTimeout(splitFromPdfTimerRef.current);
      }
      clearModeTransitionGuardTimer();
      clearComposerTransferTimers();
      composerTransferTokenRef.current += 1;
    };
  }, [clearComposerTransferTimers, clearModeTransitionGuardTimer]);

  // Navigation policy changes with the view; the sidebar itself need not render
  // on every panel animation frame or merely to receive a new event callback.
  const outlineNavigationMode = useRef({
    isPreviewOnly,
    isMarkdownDocument,
    isRenderableLatex,
  });
  outlineNavigationMode.current = {
    isPreviewOnly,
    isMarkdownDocument,
    isRenderableLatex,
  };
  const handleOutlineNavigate = useCallback((position: number) => {
    const { isPreviewOnly, isMarkdownDocument, isRenderableLatex } =
      outlineNavigationMode.current;
    if (!isPreviewOnly) {
      useDocumentStore.getState().requestJumpToPosition(position);
      return;
    }
    useDocumentStore.setState({ outlineScrollPosition: position });
    if (isMarkdownDocument) {
      markdownPreviewScrollRequestIdRef.current += 1;
      setMarkdownPreviewScrollTarget({
        id: markdownPreviewScrollRequestIdRef.current,
        position,
      });
    } else if (isRenderableLatex) {
      latexPdfScrollRequestIdRef.current += 1;
      setLatexPdfScrollTarget({
        id: latexPdfScrollRequestIdRef.current,
        position,
      });
    }
  }, []);
  const sidebarSessionPanel = useMemo(() => <div />, []);

  if (!initialized) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-muted-foreground">Loading project...</div>
      </div>
    );
  }

  return (
    <div className="h-full pt-0 pr-2 pl-3">
      <div className="flex h-full">
        <ProjectSidebarPanel
          key={projectRoot}
          projectRoot={projectRoot}
          collapsed={isSidebarCollapsed}
          transitioning={isSidebarTransitioning}
          onToggle={toggleSidebar}
        >
          <Sidebar
            showHeaderActions={!isSidebarCollapsed}
            onToggleSidebar={toggleSidebar}
            onCloseProject={closeProject}
            trafficLightInset={collapsedHeaderInset}
            assistantMode={sidebarTarget?.mode ?? workspaceMode}
            onAssistantModeChange={requestWorkspaceMode}
            contentMode={
              (sidebarTarget ?? workspacePreferences).mode === "duet" &&
              (sidebarTarget ?? workspacePreferences).chatLayout === "workspace"
                ? "sessions"
                : "files"
            }
            sessionPanel={sidebarSessionPanel}
            onOutlineNavigate={handleOutlineNavigate}
          />
        </ProjectSidebarPanel>
        <div className="min-w-0 flex-1 pb-2">
          <div className="flex h-full min-h-0 flex-col">
            <div
              ref={headerRowRef}
              className={cn(
                "relative flex h-10 shrink-0 items-center gap-2 overflow-hidden",
                isSidebarCollapsed && !isWorkspaceChat && "pl-2",
              )}
            >
              {isSidebarCollapsed ? (
                <div
                  ref={collapsedHeaderControlsRef}
                  className={cn(
                    "items-center",
                    isWorkspaceChat
                      ? "absolute inset-y-0 left-2 z-10 flex"
                      : "flex shrink-0",
                  )}
                >
                  <div
                    className="shrink-0"
                    style={{ width: `${collapsedHeaderInset}px` }}
                    aria-hidden="true"
                  />
                  <div className="relative -ml-1 flex shrink-0 items-center gap-0.5">
                    <Hint content="Close project">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-6"
                        onClick={closeProject}
                        aria-label="Close project"
                      >
                        <HomeIcon className="size-3.5" />
                      </Button>
                    </Hint>
                    <Hint content="Show sidebar">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-6"
                        onClick={toggleSidebar}
                        aria-label="Show sidebar"
                      >
                        <SidebarIcon className="size-3.5" />
                      </Button>
                    </Hint>
                    <ExternalAppSelector size="compact" />
                  </div>
                </div>
              ) : null}
              <div
                data-workspace-header="true"
                className="grid h-full min-w-0 flex-1 items-center overflow-hidden"
                style={{
                  gridTemplateColumns: isWorkspaceChat
                    ? `${workspaceChatHeaderLayout[0]}fr ${workspaceChatHeaderLayout[1]}fr`
                    : "0fr 1fr",
                  columnGap: isWorkspaceChat ? 8 : 0,
                }}
              >
                <div
                  className="flex h-full min-w-0 items-center overflow-hidden"
                  inert={!isWorkspaceChat}
                  style={{
                    paddingLeft:
                      isWorkspaceChat &&
                      isSidebarCollapsed &&
                      collapsedHeaderControlsWidth > 0
                        ? Math.round(collapsedHeaderControlsWidth + 8)
                        : 0,
                  }}
                ></div>
                <div
                  data-git-actions-compact-root
                  data-git-actions-compact-threshold={
                    isWorkspaceChat ? "760" : "620"
                  }
                  className="flex h-full min-w-0 items-center gap-2"
                >
                  {pendingReviewFiles.length > 0 &&
                    (isReviewNavigation ? (
                      <AgentReviewFileNavigation
                        currentIndex={reviewFileIndex}
                        totalFiles={pendingReviewFiles.length}
                        onPrevious={() => navigateReviewFile(-1)}
                        onNext={() => navigateReviewFile(1)}
                      />
                    ) : (
                      <GitReviewFileNavigation
                        currentIndex={reviewFileIndex}
                        totalFiles={pendingReviewFiles.length}
                        onPrevious={() => navigateReviewFile(-1)}
                        onNext={() => navigateReviewFile(1)}
                      />
                    ))}
                  <div
                    ref={setGlobalHeaderHost}
                    className={cn(
                      "h-full min-w-0 flex-1 overflow-hidden",
                      isWorkspaceChat && "hidden",
                      reviewFileIndex >= 0 &&
                        "[--review-tab-marker:var(--review-tab-marker-light)] dark:[--review-tab-marker:var(--review-tab-marker-dark)]",
                    )}
                    style={
                      reviewFileIndex >= 0
                        ? ({
                            "--review-tab-marker-light":
                              reviewNavigationColors.light,
                            "--review-tab-marker-dark":
                              reviewNavigationColors.dark,
                          } as CSSProperties)
                        : undefined
                    }
                  />
                  {isWorkspaceChat && (
                    <div
                      data-git-actions-overlap-anchor
                      className="min-w-0 shrink overflow-hidden"
                    >
                      <Select
                        value={activeFileId || undefined}
                        onValueChange={setActiveFile}
                      >
                        <SelectTrigger
                          size="sm"
                          className="h-8 w-full min-w-0 max-w-[280px] justify-start gap-2 overflow-hidden rounded-md px-2 py-0 font-normal text-sm leading-none shadow-none"
                        >
                          <SelectValue
                            className="truncate"
                            placeholder="Choose file"
                          />
                        </SelectTrigger>
                        <SelectContent
                          position="popper"
                          align="start"
                          sideOffset={1}
                        >
                          {workspaceChatFileOptions.map((file) => (
                            <SelectItem key={file.id} value={file.id}>
                              <div className="flex min-w-0 items-center gap-2">
                                {getWorkspaceChatFileIcon(file)}
                                <span className="truncate">
                                  {file.relativePath}
                                </span>
                              </div>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                  <div
                    data-workspace-header-git
                    className="ml-auto flex shrink-0 items-center gap-2"
                  >
                    <GitActionsControl projectPath={projectRoot} />
                  </div>
                  <WorkspaceHistoryControl />
                  {isWorkspaceChat ? (
                    <ButtonGroup
                      aria-label="Chat workspace content"
                      data-comment-layout-control
                      className="flex h-8 shrink-0 items-center p-0"
                    >
                      {isPreviewableFile ? (
                        <div
                          role="tablist"
                          aria-label="Chat workspace content"
                          className="flex items-center p-1"
                        >
                          {(["editor", "pdf"] as const).map((option) => (
                            <Hint
                              content={
                                option === "editor"
                                  ? editorPanelLabel
                                  : previewPanelLabel
                              }
                              key={option}
                            >
                              <button
                                type="button"
                                role="tab"
                                aria-selected={
                                  workspaceChatRightPanelMode === option
                                }
                                aria-label={
                                  option === "editor"
                                    ? editorPanelLabel
                                    : previewPanelLabel
                                }
                                className={cn(
                                  "flex h-6 w-7 items-center justify-center rounded-md transition-colors",
                                  workspaceChatRightPanelMode === option
                                    ? "bg-background text-foreground shadow-sm"
                                    : "text-muted-foreground hover:bg-background/70 hover:text-foreground",
                                )}
                                onClick={() =>
                                  updateWorkspaceContentMode(option)
                                }
                              >
                                {option === "editor" ? (
                                  <CodeXmlIcon className="size-4" />
                                ) : isCsvDocument ? (
                                  <FileSpreadsheetIcon className="size-4" />
                                ) : isMarkdownDocument ? (
                                  <FileTextIcon className="size-4" />
                                ) : (
                                  <PdfFileIcon className="size-4" />
                                )}
                                <span className="sr-only">
                                  {option === "editor"
                                    ? editorPanelLabel
                                    : previewPanelLabel}
                                </span>
                              </button>
                            </Hint>
                          ))}
                        </div>
                      ) : null}
                    </ButtonGroup>
                  ) : (
                    <>
                      {isPreviewableFile ? (
                        <ButtonGroup
                          role="tablist"
                          aria-label="Workspace view mode"
                          data-comment-layout-control
                          data-assistant-mode={workspaceMode}
                          data-chat-layout={chatLayout}
                          className="workspace-view-mode-switch flex h-8 shrink-0 items-center"
                        >
                          {workspaceViewOptions.map((option) => {
                            const isActive = viewMode === option.value;
                            const Icon = option.icon;
                            return (
                              <Hint content={option.label} key={option.value}>
                                <button
                                  type="button"
                                  role="tab"
                                  aria-selected={isActive}
                                  aria-label={option.label}
                                  onClick={() => changeViewMode(option.value)}
                                  className={cn(
                                    "workspace-view-mode-tab flex h-6 w-7 items-center justify-center rounded-md transition-colors",
                                    isActive
                                      ? "bg-background text-foreground shadow-sm"
                                      : "text-muted-foreground hover:bg-background/70 hover:text-foreground",
                                  )}
                                >
                                  <Icon className="size-4" />
                                  <span className="sr-only">
                                    {option.label}
                                  </span>
                                </button>
                              </Hint>
                            );
                          })}
                        </ButtonGroup>
                      ) : null}{" "}
                    </>
                  )}
                </div>
              </div>
            </div>

            <div className="mt-0 min-h-0 flex-1">
              <div
                ref={modeAreaRef}
                data-workspace-mode-area="true"
                data-assistant-mode={workspaceMode}
                data-chat-layout={chatLayout}
                className="relative h-full min-h-0 overflow-hidden rounded-panel"
              >
                <div
                  key="workspace-content"
                  ref={contentAreaRef}
                  data-workspace-mode-content="true"
                  className={cn(
                    "relative h-full min-h-0 overflow-hidden rounded-panel",
                  )}
                >
                  <GitFileConflictView
                    projectRoot={projectRoot}
                    file={displayedConflict?.file ?? null}
                    active={Boolean(fileConflict)}
                    rebasing={displayedConflict?.rebasing ?? false}
                    onRefresh={refreshConflict}
                    onResolved={(resolvedFile) => {
                      setFileConflictState((current) =>
                        current?.root === projectRoot
                          ? {
                              ...current,
                              files: current.files.filter(
                                (file) =>
                                  file.path !== resolvedFile.path ||
                                  file.version !== resolvedFile.version,
                              ),
                            }
                          : current,
                      );
                      refreshConflict();
                    }}
                  >
                    {({
                      current: currentConflictPane,
                      incoming: incomingConflictPane,
                    }) => (
                      <AgentFileReview
                        file={agentReviewFile}
                        change={agentFileChange}
                      >
                        {({
                          current: currentAgentPane,
                          incoming: incomingAgentPane,
                        }) => (
                          <PanelGroup
                            ref={contentGroupRef}
                            data-agent-file-review={
                              agentFileChange ? "true" : undefined
                            }
                            data-workspace-layout-animating={String(
                              isColumnLayoutAnimating,
                            )}
                            direction="horizontal"
                            className="relative h-full min-h-0"
                            onLayout={handleWorkspacePanelsLayout}
                          >
                            <Panel
                              defaultSize={initialColumnSize("chat")}
                              minSize={chatPanelMinSize}
                              maxSize={70}
                            >
                              <div
                                data-workspace-chat-pane="true"
                                inert={!isChatVisible}
                                className={cn(
                                  "h-full min-h-0",
                                  suppressHandoffPaneFade
                                    ? "transition-none"
                                    : "transition-opacity duration-120",
                                  isWorkspaceChat
                                    ? "opacity-100"
                                    : "pointer-events-none opacity-0",
                                )}
                              >
                                <ChatWorkspacePane
                                  expansion={panelExpansion("chat", "Chat")}
                                  title={
                                    <>
                                      <MessagesSquareIcon
                                        className={cn(
                                          "mr-2 size-3.5 shrink-0",
                                          activeChatProvider === "codex"
                                            ? "text-blue-500"
                                            : "text-amber-500",
                                        )}
                                        aria-hidden="true"
                                      />
                                      <span className="truncate">
                                        {formatWorkspaceChatTitle(
                                          activeChatTitle,
                                        )}
                                      </span>
                                    </>
                                  }
                                  displayControl={
                                    isWorkspaceChat
                                      ? chatDisplayControl
                                      : undefined
                                  }
                                  showTabBar={false}
                                  composerTransferPhase={
                                    panelComposerTransferPhase
                                  }
                                  forceHideComposer={forceHidePanelComposer}
                                  acceptPendingAttachments={isWorkspaceChat}
                                />
                              </div>
                            </Panel>

                            <Hint content="Double-click to split panes equally">
                              <WorkspacePanelResizeHandle
                                collapsed={!showChatEditorHandle}
                                tabIndex={showChatEditorHandle ? 0 : -1}
                                aria-label="Resize workspace panes"
                                onDoubleClick={
                                  showChatEditorHandle
                                    ? resetWorkspaceSplit
                                    : undefined
                                }
                              />
                            </Hint>

                            <Panel
                              defaultSize={initialColumnSize("editor")}
                              minSize={editorPanelMinSize}
                              maxSize={100}
                            >
                              <div
                                ref={editorPanelRef}
                                className="h-full min-h-0"
                              >
                                <LatexEditor
                                  expansion={panelExpansion(
                                    "editor",
                                    editorPanelLabel,
                                  )}
                                  reviewToolbarTarget={
                                    !isEditorVisible ? previewReviewHost : null
                                  }
                                  fileConflict={fileConflict?.file}
                                  currentConflictContent={currentConflictPane}
                                  agentFileReviewContent={currentAgentPane}
                                  useGlobalToolbar={!isWorkspaceChat}
                                  suppressToolbar={isWorkspaceChat}
                                  globalToolbarTarget={
                                    isWorkspaceChat ? null : globalHeaderHost
                                  }
                                  assistantMode={workspaceMode}
                                  chatLayout={chatLayout}
                                  selectionAiEnabled={
                                    workspaceMode !== "artisan"
                                  }
                                  scrollSyncEnabled={
                                    isMarkdownDocument
                                      ? isScrollSyncLocked
                                      : isRenderableLatex &&
                                        isLatexScrollSyncEnabled
                                  }
                                  scrollSyncPaused={
                                    !isEditorVisible || isColumnLayoutAnimating
                                  }
                                  outlineTrackingEnabled={
                                    isEditorVisible && !isColumnLayoutAnimating
                                  }
                                  scrollSyncTarget={editorScrollSyncTarget}
                                  onScrollPositionChange={(position) => {
                                    setEditorScrollSyncTarget(null);
                                    if (isMarkdownDocument) {
                                      if (!isScrollSyncLocked) return;
                                      markdownPreviewScrollRequestIdRef.current += 1;
                                      setMarkdownPreviewScrollTarget({
                                        id: markdownPreviewScrollRequestIdRef.current,
                                        position,
                                      });
                                      return;
                                    }
                                    if (
                                      !isRenderableLatex ||
                                      !isLatexScrollSyncEnabled
                                    ) {
                                      return;
                                    }
                                    latexPdfScrollRequestIdRef.current += 1;
                                    setLatexPdfScrollTarget({
                                      id: latexPdfScrollRequestIdRef.current,
                                      position,
                                    });
                                  }}
                                />
                              </div>
                            </Panel>

                            <Hint
                              content={
                                isWorkspaceSeamMiddleHovered ||
                                isSyncNavigationControlHovered
                                  ? undefined
                                  : "Double-click to split panes equally"
                              }
                            >
                              <div
                                className={
                                  showEditorPdfHandle
                                    ? "relative w-2 shrink-0"
                                    : "w-0 shrink-0"
                                }
                              >
                                <PanelResizeHandle
                                  aria-label={
                                    hasWholeFileComparison
                                      ? "Resize conflict panes"
                                      : "Resize workspace panes"
                                  }
                                  data-workspace-resize-seam="true"
                                  onPointerDownCapture={(event) => {
                                    const bounds = (
                                      event.currentTarget as unknown as HTMLElement
                                    ).getBoundingClientRect();
                                    const position =
                                      (event.clientY - bounds.top) /
                                      bounds.height;
                                    if (position > 1 / 3 && position < 2 / 3) {
                                      event.stopPropagation();
                                    }
                                  }}
                                  onDragging={(dragging) => {
                                    isWorkspaceSeamDraggingRef.current =
                                      dragging;
                                  }}
                                  onDoubleClick={
                                    showEditorPdfHandle &&
                                    !isWorkspaceSeamMiddleHovered
                                      ? resetWorkspaceSplit
                                      : undefined
                                  }
                                  disabled={
                                    !showEditorPdfHandle ||
                                    isWorkspaceSeamMiddleHovered ||
                                    isSyncNavigationControlHovered
                                  }
                                  tabIndex={showEditorPdfHandle ? 0 : -1}
                                  className={
                                    showEditorPdfHandle
                                      ? `relative h-full w-2 bg-transparent ${isWorkspaceSeamMiddleHovered ? "cursor-default" : ""}`
                                      : "pointer-events-none mx-0 w-0 bg-transparent"
                                  }
                                >
                                  {showEditorPdfHandle &&
                                  !hasWholeFileComparison &&
                                  isPreviewableFile &&
                                  !isCsvDocument ? (
                                    <SyncNavigationControl
                                      previewLabel={
                                        isMarkdownDocument ? "preview" : "PDF"
                                      }
                                      onActiveChange={
                                        setIsSyncNavigationControlHovered
                                      }
                                      scrollSyncMuted={
                                        !isMarkdownDocument &&
                                        isLatexScrollSyncMuted
                                      }
                                      onScrollSyncEnabledChange={(enabled) => {
                                        if (!projectRoot) return;
                                        useSettingsStore
                                          .getState()
                                          .setFileScrollSync(
                                            projectRoot,
                                            activeFileId,
                                            enabled,
                                          );
                                        if (isMarkdownDocument) {
                                          setMarkdownPreviewScrollTarget(null);
                                          setEditorScrollSyncTarget(null);
                                          if (!enabled) return;
                                          const documentState =
                                            useDocumentStore.getState();
                                          markdownPreviewScrollRequestIdRef.current += 1;
                                          setMarkdownPreviewScrollTarget({
                                            id: markdownPreviewScrollRequestIdRef.current,
                                            position:
                                              documentState.selectionRange
                                                ?.start ??
                                              documentState.cursorPosition,
                                          });
                                        } else {
                                          setLatexPdfScrollTarget(null);
                                          setEditorScrollSyncTarget(null);
                                          if (!enabled) return;
                                          const documentState =
                                            useDocumentStore.getState();
                                          latexPdfScrollRequestIdRef.current += 1;
                                          setLatexPdfScrollTarget({
                                            id: latexPdfScrollRequestIdRef.current,
                                            position:
                                              documentState.selectionRange
                                                ?.start ??
                                              documentState.cursorPosition,
                                          });
                                        }
                                      }}
                                      scrollSyncLocked={
                                        isMarkdownDocument
                                          ? isScrollSyncLocked
                                          : isLatexScrollSyncEnabled
                                      }
                                      onNavigateToPreview={() => {
                                        setSyncNavigationRequest({
                                          id: Date.now(),
                                          direction: isMarkdownDocument
                                            ? "to-preview"
                                            : "to-pdf",
                                        });
                                      }}
                                      onNavigateToEditor={() => {
                                        setSyncNavigationRequest({
                                          id: Date.now() + 1,
                                          direction: "to-editor",
                                        });
                                      }}
                                    />
                                  ) : null}
                                </PanelResizeHandle>
                              </div>
                            </Hint>

                            <Panel
                              defaultSize={initialColumnSize("incoming")}
                              minSize={incomingPanelMinSize}
                              maxSize={100}
                            >
                              <WorkspacePanel
                                ref={incomingPanelRef}
                                expansion={panelExpansion(
                                  "incoming",
                                  "Incoming",
                                )}
                                data-workspace-column="incoming"
                                data-workspace-panel-screen="true"
                                className="h-full"
                              >
                                {fileConflict
                                  ? incomingConflictPane
                                  : (incomingAgentPane ?? incomingConflictPane)}
                              </WorkspacePanel>
                            </Panel>
                            <PanelResizeHandle
                              disabled
                              tabIndex={-1}
                              className="pointer-events-none w-0"
                            />

                            <Panel
                              defaultSize={initialColumnSize("pdf")}
                              minSize={pdfPanelMinSize}
                              maxSize={100}
                            >
                              <WorkspacePanel
                                ref={pdfPanelRef}
                                expansion={panelExpansion(
                                  "pdf",
                                  previewPanelLabel,
                                )}
                                data-workspace-column="preview"
                                data-workspace-panel-screen="true"
                                className="h-full"
                              >
                                <div className="flex h-full min-h-0 flex-col">
                                  <div
                                    ref={setPreviewReviewHost}
                                    className="shrink-0"
                                  />
                                  <div className="min-h-0 flex-1">
                                    {isCsvDocument ? (
                                      <CsvTable />
                                    ) : isMarkdownDocument ? (
                                      <MarkdownPreview
                                        editorVisible={
                                          isEditorVisible &&
                                          expandedPanel !== "pdf"
                                        }
                                        layoutAnimating={
                                          isColumnLayoutAnimating
                                        }
                                        syncNavigationRequest={
                                          syncNavigationRequest &&
                                          syncNavigationRequest.direction !==
                                            "to-pdf"
                                            ? {
                                                id: syncNavigationRequest.id,
                                                direction:
                                                  syncNavigationRequest.direction,
                                              }
                                            : null
                                        }
                                        onSyncNavigationHandled={(id) => {
                                          setSyncNavigationRequest((request) =>
                                            request?.id === id ? null : request,
                                          );
                                        }}
                                        outlineTrackingEnabled={
                                          isPreviewOnly &&
                                          !isColumnLayoutAnimating
                                        }
                                        scrollSyncPaused={
                                          isWorkspaceChat &&
                                          (!isPdfVisible ||
                                            isColumnLayoutAnimating)
                                        }
                                        scrollSyncEnabled={
                                          isScrollSyncLocked || isPreviewOnly
                                        }
                                        scrollSyncTarget={
                                          markdownPreviewScrollTarget
                                        }
                                        onScrollSyncToEditor={(position) => {
                                          if (isPreviewOnly)
                                            useDocumentStore.setState({
                                              outlineScrollPosition: position,
                                            });
                                          setMarkdownPreviewScrollTarget(null);
                                          setLatexPdfScrollTarget(null);
                                          editorScrollSyncRequestIdRef.current += 1;
                                          setEditorScrollSyncTarget({
                                            id: editorScrollSyncRequestIdRef.current,
                                            position,
                                          });
                                        }}
                                      />
                                    ) : (
                                      <PdfPreview
                                        layoutTarget={pdfLayoutTarget}
                                        aiEnabled={workspaceMode !== "artisan"}
                                        onRevealSource={() => {
                                          if (isWorkspaceChat)
                                            updateWorkspaceContentMode(
                                              "editor",
                                            );
                                          else setViewMode("split");
                                        }}
                                        editorVisible={
                                          isEditorVisible &&
                                          expandedPanel !== "pdf"
                                        }
                                        layoutAnimating={
                                          isColumnLayoutAnimating
                                        }
                                        syncNavigationRequest={
                                          syncNavigationRequest &&
                                          syncNavigationRequest.direction !==
                                            "to-preview"
                                            ? {
                                                id: syncNavigationRequest.id,
                                                direction:
                                                  syncNavigationRequest.direction,
                                              }
                                            : null
                                        }
                                        onSyncNavigationHandled={(id) => {
                                          setSyncNavigationRequest((request) =>
                                            request?.id === id ? null : request,
                                          );
                                        }}
                                        outlineTrackingEnabled={
                                          isPreviewOnly &&
                                          !isColumnLayoutAnimating
                                        }
                                        scrollSyncPaused={
                                          isWorkspaceChat &&
                                          (!isPdfVisible ||
                                            isColumnLayoutAnimating)
                                        }
                                        scrollSyncEnabled={
                                          isLatexScrollSyncEnabled
                                        }
                                        scrollSyncSourceTarget={
                                          latexPdfScrollTarget
                                        }
                                        onScrollSyncToEditor={(position) => {
                                          if (isPreviewOnly)
                                            useDocumentStore.setState({
                                              outlineScrollPosition: position,
                                            });
                                          if (!isLatexScrollSyncEnabled) return;
                                          setMarkdownPreviewScrollTarget(null);
                                          setLatexPdfScrollTarget(null);
                                          editorScrollSyncRequestIdRef.current += 1;
                                          setEditorScrollSyncTarget({
                                            id: editorScrollSyncRequestIdRef.current,
                                            position,
                                          });
                                        }}
                                      />
                                    )}
                                  </div>
                                </div>
                              </WorkspacePanel>
                            </Panel>
                          </PanelGroup>
                        )}
                      </AgentFileReview>
                    )}
                  </GitFileConflictView>
                </div>
                {shouldRenderGlobalChatDrawer ? (
                  <div
                    data-chat-drawer-overlay="true"
                    data-assistant-mode={workspaceMode}
                    data-chat-layout={chatLayout}
                    data-drawer-presence={drawerPresence}
                    data-mode-transition-phase={modeTransitionPhase}
                    data-composer-transfer-phase={composerTransferPhase}
                    className="pointer-events-none absolute inset-0 z-20"
                  >
                    <div
                      data-chat-drawer-transition-shell="true"
                      ref={drawerTransitionShellRef}
                      className={cn(
                        "absolute origin-center transform-gpu will-change-[transform,opacity]",
                        disableDrawerAnchorTransition
                          ? "transition-none"
                          : "transition-[top,left,width,height,border-radius,box-shadow] duration-280 ease-out",
                      )}
                      style={{
                        ...(renderedDrawerAnchor
                          ? {
                              top: `${renderedDrawerAnchor.shellTop}px`,
                              left: `${renderedDrawerAnchor.shellLeft}px`,
                              width: `${renderedDrawerAnchor.shellWidth}px`,
                              height: `${renderedDrawerAnchor.shellHeight}px`,
                            }
                          : { inset: 0 }),
                        transform:
                          artisanToDuetFadeActive ||
                          drawerPresence === "visible" ||
                          drawerPresence === "exiting" ||
                          drawerPresence === "transfer"
                            ? "translate3d(0, 0, 0) scale(1, 1)"
                            : "translate3d(0, calc(100% + 24px), 0) scale(1, 1)",
                        opacity: drawerPresence === "hidden" ? 0 : 1,
                        visibility:
                          drawerIntroPhase === "preparing"
                            ? "hidden"
                            : undefined,
                        borderRadius:
                          drawerPresence === "transfer" ? "16px" : "16px",
                        boxShadow:
                          drawerPresence === "transfer"
                            ? frontMorphToPanel
                              ? "none"
                              : "0 22px 46px hsl(var(--foreground) / 0.18)"
                            : undefined,
                        transition:
                          drawerPresence === "exiting"
                            ? "none"
                            : drawerPresence === "hidden"
                              ? "none"
                              : drawerPresence === "transfer"
                                ? `top ${FRONT_MORPH_DURATION_MS}ms ${FRONT_MORPH_EASE} ${frontMorphGeometryDelayMs}ms, left ${FRONT_MORPH_DURATION_MS}ms ${FRONT_MORPH_EASE} ${frontMorphGeometryDelayMs}ms, width ${FRONT_MORPH_DURATION_MS}ms ${FRONT_MORPH_EASE} ${frontMorphGeometryDelayMs}ms, height ${FRONT_MORPH_DURATION_MS}ms ${FRONT_MORPH_EASE} ${frontMorphGeometryDelayMs}ms, border-radius ${FRONT_MORPH_DURATION_MS}ms ${FRONT_MORPH_EASE} ${frontMorphGeometryDelayMs}ms, box-shadow ${FRONT_MORPH_DURATION_MS}ms ${FRONT_MORPH_EASE} ${frontMorphGeometryDelayMs}ms, opacity ${FRONT_MORPH_DURATION_MS}ms ${FRONT_MORPH_EASE}`
                                : "none",
                      }}
                    >
                      <div
                        className="absolute inset-0 overflow-hidden"
                        style={{ borderRadius: "inherit" }}
                      >
                        <div
                          data-chat-drawer-clip="true"
                          className={cn(
                            "absolute inset-x-0 origin-center overflow-hidden will-change-[clip-path,opacity,filter]",
                            disableDrawerAnchorTransition
                              ? "transition-none"
                              : "transition-[top,height] duration-280 ease-out",
                          )}
                          style={
                            renderedDrawerAnchor
                              ? {
                                  top: `${shouldForceFullDrawerClip ? 0 : renderedDrawerAnchor.clipTop}px`,
                                  height: `${shouldForceFullDrawerClip ? renderedDrawerAnchor.shellHeight : renderedDrawerAnchor.clipHeight}px`,
                                  transition:
                                    drawerPresence === "transfer"
                                      ? `top ${FRONT_MORPH_DURATION_MS}ms ${FRONT_MORPH_EASE} ${frontMorphGeometryDelayMs}ms, height ${FRONT_MORPH_DURATION_MS}ms ${FRONT_MORPH_EASE} ${frontMorphGeometryDelayMs}ms`
                                      : undefined,
                                }
                              : {
                                  inset: 0,
                                }
                          }
                        >
                          <AgentChatDrawer
                            displayControl={chatDisplayControl}
                            open={chatDrawerOpen}
                            onOpenChange={setChatDrawerOpen}
                            preferredHeight={chatDrawerHeight}
                            onHeightChange={setChatDrawerHeight}
                            isExiting={drawerPresence === "exiting"}
                            transitionMorphActive={
                              drawerPresence === "transfer"
                            }
                            morphToPanel={frontMorphToPanel}
                            composerTransferPhase={drawerComposerTransferPhase}
                            introRevealActive={isDrawerRevealActive}
                          />
                        </div>
                      </div>
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
