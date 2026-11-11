import { useActionTarget } from "@/hooks/use-action-target";
import { useAppAction } from "@/hooks/use-app-actions";
import {
  pdfFileCommentTargets,
  validPdfCommentRegions,
  emptyPdfCommentLookup,
} from "./pdf-file-comments";
import { PROJECT_COMMENTS_REFRESH_EVENT } from "@/lib/workspace-events";
import { exportPdfSource, type PdfSource } from "@/lib/mupdf/pdf-source";
import { pdfSelectionKey } from "@/lib/chat-context";
import { CoalescedScrollTask } from "@/lib/coalesced-scroll-task";
import { createSourceLineIndex } from "@/lib/source-line-index";
import { createCompiledPdfMap } from "./pdf-source-map";
import { clampPdfScale, MIN_PDF_SCALE, MAX_PDF_SCALE } from "./pdf-zoom";
import {
  captureCompileContext,
  captureAutomaticCompileContext,
  COMPILATION_STOP_EVENT,
  stopCompilation,
  compileWorkspace,
} from "@/lib/workspace-compile";
import { isComposingKey } from "@/lib/keyboard-events";
import { DocumentZoomControl } from "../document-zoom-control";
import {
  documentBarFindControlWidth,
  documentCounterClassName,
  documentStepButtonClassName,
} from "../document-navigation-styles";
import { setCommentDraft } from "../editor/comment-draft-history";
import { attachCommentToChat } from "@/lib/comment-chat-context";
import { isReferencePanelWindow } from "@/lib/panel-window-runtime";
import { Hint } from "@/components/ui/tooltip";
import {
  WorkspacePanelHeader,
  useWorkspacePanelMotion,
} from "../workspace-panel";
import { CommentsPanel, CommentsSummaryButton } from "../editor/comments-panel";
import { ProblemsMotion } from "../editor/problems-motion";
import { pickPdfCommentRange } from "./pdf-comment-selection";
import { toast } from "sonner";
import { createPdfCommentLookup } from "./pdf-comment-lookup";
import {
  useState,
  useEffect,
  useLayoutEffect,
  useRef,
  useCallback,
  useMemo,
  type ReactNode,
  type PointerEvent,
  type MouseEvent,
} from "react";
import {
  FileTextIcon,
  CheckIcon,
  MessageSquareTextIcon,
  AlertCircleIcon,
  LoaderIcon,
  RefreshCwIcon,
  SquareIcon,
  MoveHorizontalIcon,
  MoveVerticalIcon,
  DownloadIcon,
  MousePointerClickIcon,
  ChevronUpIcon,
  ChevronDownIcon,
} from "lucide-react";
import {
  useDocumentStore,
  getCurrentPdfBytes,
  hasPdfData,
} from "@/stores/document-store";
import { offsetToLineCol, useAgentChatStore } from "@/stores/agent-chat-store";
import {
  useSettingsStore,
  type ConcreteCompilerEngine,
  type RootCompilerChoice,
} from "@/stores/settings-store";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ButtonGroup } from "@/components/ui/button-group";
import { SettingsSwitch } from "@/components/settings/settings-switch";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuCheckboxItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";

import {
  detectTexEngineFromContent,
  getPublishedCompilation,
  synctexEdit,
  synctexView,
  type SynctexResult,
} from "@/lib/latex-compiler";
import { MERGE_PREVIEW_REFRESH_EVENT } from "@/lib/workspace-events";
import { ErrorBoundary } from "react-error-boundary";
import {
  SelectionToolbar,
  type ToolbarAction,
} from "@/components/workspace/editor/selection-toolbar";
import { save } from "@/lib/desktop/dialog";
import {
  PdfViewer,
  type PdfTextSelection,
  type PdfScrollPosition,
  type PdfViewerSearch,
} from "./pdf-viewer";
import type {
  PdfReadingAnchor,
  PdfReadingAnchorControl,
} from "./pdf-reading-anchor";
import { resolveTexRoot } from "@/stores/document-store";

import { useProjectComments } from "../editor/use-project-comments";
import {
  PdfCommentInteraction,
  pdfCommentTargets,
  type PdfCommentTarget,
} from "./pdf-comments";
import { PDF_COMMENT_NAVIGATE_EVENT } from "@/lib/workspace-events";

function pdfSelectionFallbackLabel(
  selection: PdfTextSelection,
  documentPath: string,
) {
  const text = selection.text.replace(/\s+/g, " ").trim();
  const characters = Array.from(text);
  const excerpt =
    characters.length > 32 ? `${characters.slice(0, 32).join("")}…` : text;
  return `PDF p.${selection.pageNumber} · @${documentPath} · “${excerpt}”`;
}

type FitMode = "fit-width" | "fit-height" | null;
const DEFAULT_FIT_MODE: Exclude<FitMode, null> = "fit-width";
const RECOMPILE_BUTTON_WIDTH = 100;
const RECOMPILE_ICON_BUTTON_WIDTH = 28;
type CompilerChoice = `latexmk:${ConcreteCompilerEngine}` | "tectonic";

/** Per-root zoom state cache: rootFileId → { scale, fitMode } */
const zoomCache = new Map<string, { scale: number; fitMode: FitMode }>();

/** Max number of PdfViewer instances kept alive simultaneously. */
const MAX_ALIVE_VIEWERS = 5;

/** Clear zoom cache (e.g., on project close). */
export function clearZoomCache(): void {
  zoomCache.clear();
}

export interface PdfLayoutTarget {
  from: number;
  to: number;
  width: number;
  currentWidth: number;
}

export function PdfPreview({
  aiEnabled: requestedAiEnabled = false,
  editorVisible = false,
  layoutAnimating: columnLayoutAnimating = false,
  layoutTarget,
  standalonePdfData = null,
  standaloneRootFileId,
  isolatedSnapshot = false,
  toolbarContent,
  syncNavigationRequest: requestedSyncNavigation = null,
  onSyncNavigationHandled,
  scrollSyncEnabled: requestedScrollSyncEnabled = false,
  scrollSyncPaused = false,
  outlineTrackingEnabled = false,
  scrollSyncSourceTarget: requestedScrollSyncTarget = null,
  onScrollSyncToEditor,
  onRevealSource,
}: {
  aiEnabled?: boolean;
  onRevealSource?: () => void;
  editorVisible?: boolean;
  layoutAnimating?: boolean;
  layoutTarget?: PdfLayoutTarget;
  standalonePdfData?: PdfSource | null;
  standaloneRootFileId?: string;
  /** Historical bytes only; never navigate or write to the current workspace. */
  isolatedSnapshot?: boolean;
  toolbarContent?: ReactNode;
  syncNavigationRequest?: {
    id: number;
    direction: "to-editor" | "to-pdf";
  } | null;
  onSyncNavigationHandled?: (id: number) => void;
  scrollSyncEnabled?: boolean;
  scrollSyncPaused?: boolean;
  outlineTrackingEnabled?: boolean;
  scrollSyncSourceTarget?: { id: number; position: number } | null;
  onScrollSyncToEditor?: (position: number) => void;
}) {
  const panelMotion = useWorkspacePanelMotion();
  const layoutAnimating = columnLayoutAnimating || !!panelMotion?.animating;
  const aiEnabled =
    requestedAiEnabled && !isolatedSnapshot && !isReferencePanelWindow();
  const scrollSyncEnabled = requestedScrollSyncEnabled && !isolatedSnapshot;
  const scrollSyncSourceTarget = isolatedSnapshot
    ? null
    : requestedScrollSyncTarget;
  const syncNavigationRequest = isolatedSnapshot
    ? null
    : requestedSyncNavigation;
  const globalCompilerBackend = useSettingsStore((s) => s.compilerBackend);
  const globalCompilerEngine = useSettingsStore((s) => s.compilerEngine);
  const pdfRevision = useDocumentStore((s) => s.pdfRevision);
  const pdfSelectionContext = useDocumentStore((s) => s.pdfSelectionContext);
  const compileError = useDocumentStore((s) => s.compileError);
  const isCompiling = useDocumentStore((s) => s.isCompiling);
  const isStoppingCompilation = useDocumentStore(
    (s) => s.isStoppingCompilation,
  );
  const isSaving = useDocumentStore((s) => s.isSaving);
  const content = useDocumentStore((s) => s.content);
  const projectRoot = useDocumentStore((s) => s.projectRoot);
  const autoCompile = useSettingsStore((s) =>
    s.getProjectAutoCompile(projectRoot),
  );
  const setProjectAutoCompile = useSettingsStore(
    (s) => s.setProjectAutoCompile,
  );
  const files = useDocumentStore((s) => s.files);
  const setActiveFile = useDocumentStore((s) => s.setActiveFile);
  const activeFile = useDocumentStore((s) => {
    return s.files.find((f) => f.id === s.activeFileId) ?? null;
  });
  const requestJumpToPosition = useDocumentStore(
    (s) => s.requestJumpToPosition,
  );

  const [pdfError, setPdfError] = useState<string | null>(null);
  const [numPages, setNumPages] = useState<number>(0);
  const [currentPage, setCurrentPage] = useState<number>(1);
  const [pageInputValue, setPageInputValue] = useState<string>("1");
  const [isEditingPage, setIsEditingPage] = useState(false);
  const pageInputRef = useRef<HTMLInputElement>(null);
  const cancelledPageInputRef = useRef(false);
  useLayoutEffect(() => {
    if (!isEditingPage) return;
    pageInputRef.current?.focus();
    pageInputRef.current?.select();
  }, [isEditingPage]);
  const readingAnchorRef = useRef<PdfReadingAnchorControl | null>(null);
  const linkedReadingAnchorRef = useRef<{
    source: { fileId: string; content: string; position: number };
    pdf: PdfReadingAnchor;
    revision: number;
    sourceRequestId: number | undefined;
  } | null>(null);
  useLayoutEffect(() => {
    linkedReadingAnchorRef.current = null;
  }, [projectRoot, activeFile?.id, activeFile?.content, scrollSyncEnabled]);
  const scrollToPageRef = useRef<
    ((page: number, pdfY?: number) => void) | null
  >(null);
  const [scale, setScale] = useState<number>(1.0);
  const [{ level: toolbarCompactLevel, findInOverflow }, setToolbarLayout] =
    useState({ level: 0, findInOverflow: false });
  // Shrink Recompile first, then overflow page navigation, fits, and export.
  const hideRecompileLabel = toolbarCompactLevel >= 1;
  const hidePageNavigation = toolbarCompactLevel >= 2;
  const hideFitHeight = toolbarCompactLevel >= 3;
  const hideFitWidth = toolbarCompactLevel >= 4;
  const hideExport = toolbarCompactLevel >= 5;
  const [actionsOpen, setActionsOpen] = useState(false);
  const [fitMode, setFitMode] = useState<FitMode>(DEFAULT_FIT_MODE);
  const fitViewportRef = useRef<HTMLDivElement | null>(null);
  const viewportWidthInset = useRef(0);
  const [containerSize, setContainerSize] = useState<{
    width: number;
    height: number;
  } | null>(null);
  const handleContainerResize = useCallback(
    (_width: number, _height: number, viewport: HTMLDivElement) => {
      fitViewportRef.current = viewport;
      const minimapInset =
        Number.parseFloat(
          getComputedStyle(viewport).getPropertyValue("--pdf-minimap-inset"),
        ) || 0;
      if (viewport.offsetWidth > 1)
        viewportWidthInset.current = Math.max(
          0,
          (viewport.parentElement?.clientWidth ?? viewport.offsetWidth) -
            viewport.clientWidth +
            minimapInset,
        );
      const width = viewport.clientWidth - minimapInset;
      const height = viewport.clientHeight;
      const update = () =>
        setContainerSize((previous) =>
          previous?.width === width && previous.height === height
            ? previous
            : { width, height },
        );
      update();
    },
    [],
  );
  // Read this frame's viewport before paint so PDF geometry shares the panel's clock.
  useLayoutEffect(() => {
    const viewport = fitViewportRef.current;
    if (viewport && panelMotion) handleContainerResize(0, 0, viewport);
  }, [panelMotion, handleContainerResize]);
  const [firstPageSize, setFirstPageSize] = useState<{
    width: number;
    height: number;
  } | null>(null);
  const lastHandledSyncNavigationIdRef = useRef<number | null>(null);
  const syncDriverRef = useRef<"editor" | "pdf" | null>(null);
  const sourceScrollSyncRequestIdRef = useRef(0);
  const scrollSyncRequestIdRef = useRef(0);
  const ignorePdfScrollSyncUntilRef = useRef(0);
  const suppressPdfToEditorSyncRef = useRef(false);
  const lastObservedPdfRevisionRef = useRef(pdfRevision);
  const pendingEditorAuthoritativeRevisionRef = useRef<number | null>(null);
  const aligningEditorAuthoritativeRevisionRef = useRef<number | null>(null);
  const postCompileSyncFrameRef = useRef<number | null>(null);
  const postCompileReleaseFrameRef = useRef<number | null>(null);
  const scrollSyncEnabledRef = useRef(scrollSyncEnabled);
  const scrollSyncSourceTargetRef = useRef(scrollSyncSourceTarget);
  scrollSyncEnabledRef.current = scrollSyncEnabled;
  scrollSyncSourceTargetRef.current = scrollSyncSourceTarget;
  const toolbarRowRef = useRef<HTMLDivElement>(null);
  const toolbarLeftControlsRef = useRef<HTMLDivElement>(null);
  const toolbarRightControlsRef = useRef<HTMLDivElement>(null);
  const toolbarProbeRefs = useRef<(HTMLDivElement | null)[]>([]);
  const recompileButtonRef = useRef<HTMLButtonElement>(null);
  const hasInitialCompile = useRef(false);
  const autoCompileTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const forceNextAutoCompileRef = useRef(false);
  const initialized = useDocumentStore((s) => s.initialized);
  const contentGeneration = useDocumentStore((s) => s.contentGeneration);

  // Isolation remains active during loading/error states, even with no bytes.
  const isStandalonePdf = isolatedSnapshot || standalonePdfData != null;
  const effectiveCompileError = isStandalonePdf ? null : compileError;
  const [pdfFingerprintState, setPdfFingerprintState] = useState<{
    source: PdfSource;
    value: string;
  } | null>(null);
  const pdfFingerprint =
    standalonePdfData && !ArrayBuffer.isView(standalonePdfData)
      ? (standalonePdfData.fingerprint ?? null)
      : pdfFingerprintState?.source === standalonePdfData
        ? (pdfFingerprintState?.value ?? null)
        : null;
  useEffect(() => {
    if (!standalonePdfData || !ArrayBuffer.isView(standalonePdfData)) return;
    let cancelled = false;
    void crypto.subtle
      .digest("SHA-1", standalonePdfData.slice().buffer as ArrayBuffer)
      .then((hash) => {
        if (!cancelled)
          setPdfFingerprintState({
            source: standalonePdfData,
            value: Array.from(new Uint8Array(hash), (byte) =>
              byte.toString(16).padStart(2, "0"),
            ).join(""),
          });
      });
    return () => {
      cancelled = true;
    };
  }, [standalonePdfData]);
  useEffect(() => {
    if (pdfFingerprint && projectRoot && !isolatedSnapshot)
      window.dispatchEvent(
        new CustomEvent(PROJECT_COMMENTS_REFRESH_EVENT, {
          detail: { projectRoot },
        }),
      );
  }, [pdfFingerprint, projectRoot, isolatedSnapshot]);

  useEffect(() => {
    if (isolatedSnapshot) setPdfError(null);
  }, [isolatedSnapshot, standalonePdfData, pdfRevision]);

  // Keep compiled PDF bytes outside React-managed values. In dev, React 19 can
  // publish render metadata through the Performance API; large hook/prop values
  // can cause the browser to clone multi-MB PDFs on every relevant commit.
  const hasCurrentPdfData = isStandalonePdf
    ? standalonePdfData != null
    : hasPdfData();

  // A new compiled PDF can reset or restore its own scroll position while its
  // pages are being rebuilt. During that window the editor is authoritative:
  // discard PDF-to-editor feedback, then realign the ready PDF from the latest
  // editor viewport target. pdfRevision covers manual, automatic, and
  // agent-triggered compiles through the same path.
  useLayoutEffect(() => {
    const revisionChanged = pdfRevision !== lastObservedPdfRevisionRef.current;
    lastObservedPdfRevisionRef.current = pdfRevision;

    if (!scrollSyncEnabled || isStandalonePdf) {
      pendingEditorAuthoritativeRevisionRef.current = null;
      aligningEditorAuthoritativeRevisionRef.current = null;
      suppressPdfToEditorSyncRef.current = false;
      return;
    }
    if (!revisionChanged) return;

    sourceScrollSyncRequestIdRef.current += 1;
    scrollSyncRequestIdRef.current += 1;
    if (postCompileSyncFrameRef.current !== null) {
      cancelAnimationFrame(postCompileSyncFrameRef.current);
      postCompileSyncFrameRef.current = null;
    }
    if (postCompileReleaseFrameRef.current !== null) {
      cancelAnimationFrame(postCompileReleaseFrameRef.current);
      postCompileReleaseFrameRef.current = null;
    }

    pendingEditorAuthoritativeRevisionRef.current = pdfRevision;
    aligningEditorAuthoritativeRevisionRef.current = null;
    suppressPdfToEditorSyncRef.current = true;
    ignorePdfScrollSyncUntilRef.current = Number.POSITIVE_INFINITY;
  }, [isStandalonePdf, pdfRevision, scrollSyncEnabled]);

  useEffect(() => {
    if (!scrollSyncEnabled || isStandalonePdf) {
      suppressPdfToEditorSyncRef.current = false;
      return;
    }
    if (isCompiling) {
      suppressPdfToEditorSyncRef.current = true;
      scrollSyncRequestIdRef.current += 1;
      return;
    }
    if (
      pendingEditorAuthoritativeRevisionRef.current === null &&
      aligningEditorAuthoritativeRevisionRef.current === null
    ) {
      ignorePdfScrollSyncUntilRef.current = performance.now() + 400;
      suppressPdfToEditorSyncRef.current = false;
    }
  }, [isCompiling, isStandalonePdf, scrollSyncEnabled]);

  // Keep-alive: track which root files have PdfViewer instances alive (LRU order)
  const currentRootFileId = useMemo(
    () =>
      isolatedSnapshot
        ? `history-snapshot:${standaloneRootFileId ?? "preview"}`
        : (standaloneRootFileId ?? resolveTexRoot(activeFile?.id ?? "", files)),
    [isolatedSnapshot, standaloneRootFileId, activeFile?.id, files],
  );
  const currentRootFile = files.find((file) => file.id === currentRootFileId);
  const pdfDocumentPath = currentRootFile?.relativePath ?? currentRootFileId;
  const pdfDocumentKind = isStandalonePdf ? "file" : "compiled";
  const agentWorkspaceRoot = useDocumentStore((s) => s.agentWorkspaceRoot);
  const compiledGeneration = useDocumentStore((s) =>
    s.lastCompiledGenerations.get(currentRootFileId),
  );
  const [projectComments, setProjectComments, , commentsLoaded] =
    useProjectComments(
      isolatedSnapshot || agentWorkspaceRoot ? null : projectRoot,
    );
  const pdfCommentsVisible = useSettingsStore(
    (s) => s.displayComments && s.showPdfComments,
  );
  const pdfCommentFullWidth = useSettingsStore((s) => s.pdfCommentFullWidth);
  const setPdfCommentFullWidth = useSettingsStore(
    (s) => s.setPdfCommentFullWidth,
  );
  const [activeSearch, setActiveSearch] = useState<PdfViewerSearch | null>(
    null,
  );
  const searchOpen = activeSearch?.open ?? false;
  const showFind = !!activeSearch && !searchOpen && !editorVisible;
  const [newCommentId, setNewCommentId] = useState<string | null>(null);
  const [commentRequestRevision, setCommentRequestRevision] = useState(0);
  const [centerRequestedComment, setCenterRequestedComment] = useState(false);
  const commentNavigationToken = useRef(0);
  const panelsProjectKey = JSON.stringify(projectRoot);
  const commentsPanelOpen = useSettingsStore(
    (s) => s.editorCommentsPanelOpenByProject[panelsProjectKey] ?? false,
  );
  const commentFilter = useSettingsStore(
    (s) => s.editorCommentFilterByProject[panelsProjectKey] ?? "all",
  );
  const setEditorInfoBar = useSettingsStore((s) => s.setEditorInfoBar);
  const saveCommentFilter = useSettingsStore((s) => s.setEditorCommentFilter);
  const activeFileComments = activeFile
    ? (projectComments[activeFile.relativePath] ?? []).filter(
        (comment) =>
          !comment.resolved &&
          (!isStandalonePdf || comment.pdf?.fingerprint === pdfFingerprint),
      )
    : [];
  const showPdfCommentControls =
    pdfCommentsVisible &&
    !editorVisible &&
    !isolatedSnapshot &&
    !agentWorkspaceRoot &&
    activeFileComments.length > 0;
  const showPdfCommentSummary = showPdfCommentControls && !commentsPanelOpen;
  const selectedChatCommentsJson = useAgentChatStore((state) =>
    JSON.stringify(
      state.tabs
        .find((tab) => tab.id === state.activeTabId)
        ?.draft.pinnedContexts.filter((context) => context.comment)
        .map((context) => ({
          filePath: context.filePath,
          id: context.comment!.id,
        })) ?? [],
    ),
  );
  const selectedChatComments = useMemo<Array<{ filePath: string; id: string }>>(
    () => JSON.parse(selectedChatCommentsJson),
    [selectedChatCommentsJson],
  );
  const commentActions = useCallback(
    (target: PdfCommentTarget) => {
      const update = (
        change: (
          comment: PdfCommentTarget["comment"],
        ) => PdfCommentTarget["comment"] | null,
      ) => {
        setProjectComments((current) => ({
          ...current,
          [target.filePath]: (current[target.filePath] ?? []).flatMap(
            (comment) => {
              if (comment.id !== target.comment.id) return [comment];
              const next = change(comment);
              return next ? [next] : [];
            },
          ),
        }));
      };
      return {
        historyScope: projectRoot
          ? { root: projectRoot, filePath: target.filePath }
          : undefined,
        selectedCommentIds: selectedChatComments
          .filter((comment) => comment.filePath === target.filePath)
          .map((comment) => comment.id),
        onAttach: aiEnabled
          ? (comment: PdfCommentTarget["comment"]) =>
              attachCommentToChat(projectRoot, target.filePath, comment)
          : undefined,
        onResize: (
          id: string,
          range: { from: number; to: number; line: number },
        ) => {
          const document = useDocumentStore.getState();
          if (
            document.projectRoot !== projectRoot ||
            document.agentWorkspaceRoot ||
            document.contentGeneration !== compiledGeneration ||
            document.lastCompiledGenerations.get(currentRootFileId) !==
              compiledGeneration ||
            document.files.find((file) => file.relativePath === target.filePath)
              ?.content !== target.sourceContent
          )
            return;
          setProjectComments(
            (current) => ({
              ...current,
              [target.filePath]: (current[target.filePath] ?? []).map(
                (comment) =>
                  comment.id === id &&
                  comment.from === target.comment.from &&
                  comment.to === target.comment.to &&
                  comment.anchorRevision === target.comment.anchorRevision
                    ? {
                        ...comment,
                        ...range,
                        positionReset: false,
                        removedAnchor: undefined,
                      }
                    : comment,
              ),
            }),
            true,
          );
        },
        onSave: (_id: string, text: string) => {
          if (text.trim())
            update((comment) => ({ ...comment, text, isEditing: false }));
        },
        onEdit: () => update((comment) => ({ ...comment, isEditing: true })),
        onCancel: () =>
          update((comment) =>
            comment.text.trim() ? { ...comment, isEditing: false } : null,
          ),
        onResolve: () => update((comment) => ({ ...comment, resolved: true })),
        onDelete: () => update(() => null),
      };
    },
    [
      setProjectComments,
      projectRoot,
      selectedChatComments,
      aiEnabled,
      compiledGeneration,
      currentRootFileId,
    ],
  );
  const commentTargets = useMemo(
    () =>
      isStandalonePdf
        ? pdfFileCommentTargets(
            pdfDocumentPath,
            pdfFingerprint,
            projectComments[pdfDocumentPath] ?? [],
          )
        : pdfCommentTargets(files, projectComments),
    [files, projectComments, isStandalonePdf, pdfDocumentPath, pdfFingerprint],
  );
  const compiledMap = useMemo(
    () =>
      projectRoot
        ? createCompiledPdfMap(
            projectRoot,
            getPublishedCompilation(projectRoot),
          )
        : null,
    [projectRoot, pdfRevision, currentRootFileId],
  );
  const sourceLines = useMemo(
    () => createSourceLineIndex(activeFile?.content ?? ""),
    [activeFile?.content],
  );
  const sourceLinesRef = useRef(sourceLines);
  sourceLinesRef.current = sourceLines;
  const commentLookup = useMemo(
    () =>
      isStandalonePdf
        ? emptyPdfCommentLookup
        : projectRoot && compiledMap
          ? createPdfCommentLookup(projectRoot, compiledMap.load)
          : null,
    [projectRoot, compiledMap, isStandalonePdf],
  );
  useEffect(() => {
    if (
      scrollSyncEnabled &&
      !isCompiling &&
      compiledGeneration === contentGeneration
    )
      void compiledMap?.prepare().catch(() => {});
  }, [
    compiledMap,
    scrollSyncEnabled,
    isCompiling,
    compiledGeneration,
    contentGeneration,
  ]);
  const navigateCommentInPdf = useCallback(
    async (commentId: string, searchFilePath?: string) => {
      const token = ++commentNavigationToken.current;
      const isCurrentCompileContext = captureCompileContext();
      const target = commentTargets.find(
        (target) =>
          target.comment.id === commentId &&
          target.filePath === (searchFilePath ?? activeFile?.relativePath),
      );
      if (!target || !commentLookup) return;
      const reveal = (page: number, y: number) => {
        scrollToPageRef.current?.(page, y);
        if (searchFilePath) return;
        setCenterRequestedComment(true);
        setNewCommentId(commentId);
        setCommentRequestRevision((revision) => revision + 1);
      };
      if (target.comment.pdf) {
        const region = target.comment.pdf.regions[0];
        reveal(region.page, region.y);
        return;
      }
      const controller = new AbortController();
      for (let page = 1; page <= numPages; page++) {
        const boxes = await commentLookup(page, controller.signal);
        if (token !== commentNavigationToken.current) return;
        const box = boxes.find((box) =>
          box.sources.some(
            (source) =>
              source.file === target.filePath &&
              source.line >= target.firstLine &&
              source.line <= target.lastLine,
          ),
        );
        if (!box) continue;
        if (!searchFilePath && !target.comment.isEditing)
          commentActions(target).onAttach?.(target.comment);
        reveal(page, box.y);
        return;
      }
      if (!isCurrentCompileContext()) return;
      toast.error("This comment could not be located in the current PDF.", {
        id: "pdf-comment-location",
        action: {
          label: "Recompile",
          onClick: () => {
            if (!isCurrentCompileContext() || isStandalonePdf) return;
            setPdfError(null);
            void compileWorkspace({ force: true }).catch((error) =>
              toast.error(`Could not recompile: ${String(error)}`),
            );
          },
        },
      });
    },
    [
      commentTargets,
      commentLookup,
      activeFile?.relativePath,
      numPages,
      commentActions,
      isStandalonePdf,
    ],
  );
  const locateSearchComment = useCallback(
    (commentId: string | null, filePath: string) => {
      if (commentId) void navigateCommentInPdf(commentId, filePath);
      else commentNavigationToken.current += 1;
    },
    [navigateCommentInPdf],
  );
  const navigateComment = useCallback(
    (target: PdfCommentTarget) => {
      setPdfSelection(null);
      if (isStandalonePdf) {
        void navigateCommentInPdf(target.comment.id);
        return;
      }
      window.dispatchEvent(
        new CustomEvent(PDF_COMMENT_NAVIGATE_EVENT, {
          detail: {
            projectRoot,
            filePath: target.filePath,
            commentId: target.comment.id,
          },
        }),
      );
    },
    [projectRoot, isStandalonePdf, navigateCommentInPdf],
  );
  const pdfComments = useMemo(
    () =>
      pdfCommentsVisible &&
      !isolatedSnapshot &&
      !agentWorkspaceRoot &&
      (isStandalonePdf
        ? !!pdfFingerprint
        : !isCompiling && compiledGeneration === contentGeneration) &&
      commentLookup
        ? {
            targets: commentTargets,
            lookup: commentLookup,
            navigate: navigateComment,
            selectionEnabled: aiEnabled,
            clearSelection: () => {
              const store = useDocumentStore.getState();
              if (store.commentSelectionContext)
                store.setCommentSelectionContext(null);
            },
          }
        : null,
    [
      isStandalonePdf,
      isolatedSnapshot,
      pdfFingerprint,
      agentWorkspaceRoot,
      isCompiling,
      compiledGeneration,
      contentGeneration,
      commentTargets,
      commentLookup,
      pdfCommentsVisible,
      navigateComment,
      aiEnabled,
    ],
  );
  const detectedRootEngine = useMemo(
    () =>
      currentRootFile?.content
        ? detectTexEngineFromContent(currentRootFile.content)
        : null,
    [currentRootFile?.content],
  );
  const storedCompilerChoice = useSettingsStore((s) =>
    projectRoot && currentRootFileId
      ? s.getCompilerChoiceForRoot(projectRoot, currentRootFileId)
      : undefined,
  );
  const fallbackCompilerChoice: RootCompilerChoice =
    globalCompilerBackend === "tectonic"
      ? { backend: "tectonic", engine: detectedRootEngine ?? "xelatex" }
      : {
          backend: "latexmk",
          engine:
            globalCompilerEngine === "auto"
              ? (detectedRootEngine ?? "pdflatex")
              : globalCompilerEngine,
        };
  const resolvedCompilerChoice = storedCompilerChoice ?? fallbackCompilerChoice;
  const compilerChoice: CompilerChoice =
    resolvedCompilerChoice.backend === "tectonic"
      ? "tectonic"
      : `latexmk:${resolvedCompilerChoice.engine}`;
  const setCompilerChoice = useCallback(
    (choice: CompilerChoice) => {
      if (!projectRoot || !currentRootFileId) return;
      if (choice === "tectonic") {
        useSettingsStore
          .getState()
          .setCompilerChoiceForRoot(projectRoot, currentRootFileId, {
            backend: "tectonic",
            engine: resolvedCompilerChoice.engine,
          });
        return;
      }
      useSettingsStore
        .getState()
        .setCompilerChoiceForRoot(projectRoot, currentRootFileId, {
          backend: "latexmk",
          engine: choice.replace("latexmk:", "") as ConcreteCompilerEngine,
        });
    },
    [projectRoot, currentRootFileId, resolvedCompilerChoice.engine],
  );
  const hasTexProject = files.some((file) => file.type === "tex");
  const [aliveOrder, setAliveOrder] = useState<string[]>([]);
  const prevRootRef = useRef(currentRootFileId);
  const hasAutoCompileBaseline = useRef(false);
  const hasBackendBaseline = useRef(false);
  const lastAutoCompileGenerationRef = useRef(0);

  const measureToolbarOverflow = useCallback(() => {
    const row = toolbarRowRef.current;
    const left = toolbarLeftControlsRef.current;
    if (!row || !left || actionsOpen || isEditingPage) return;

    // Measure the full left group, even when export or the compile label is hidden.
    const compileButton = recompileButtonRef.current;
    const labelWidth = compileButton
      ? RECOMPILE_BUTTON_WIDTH - RECOMPILE_ICON_BUTTON_WIDTH
      : 0;
    const exportWidth = hasCurrentPdfData ? 32 : 0;
    const fullLeftWidth =
      left.getBoundingClientRect().width +
      (compileButton
        ? RECOMPILE_BUTTON_WIDTH - compileButton.getBoundingClientRect().width
        : 0) +
      (hideExport ? exportWidth : 0);
    const commentWidth =
      toolbarRightControlsRef.current
        ?.querySelector<HTMLElement>("[data-pdf-comments-summary]")
        ?.closest<HTMLElement>("[data-problems-motion]")
        ?.getBoundingClientRect().width ?? 0;
    const rowStyle = getComputedStyle(row);
    // Reserve a 56px gesture area and the menu (24px plus its 17px separator).
    // Keep this budget stable when the menu enters/leaves during expansion.
    const available =
      row.clientWidth -
      Number.parseFloat(rowStyle.paddingLeft) -
      Number.parseFloat(rowStyle.paddingRight) -
      commentWidth -
      56 -
      41;
    setToolbarLayout((previous) => {
      const findWidth = showFind ? documentBarFindControlWidth : 0;
      for (let level = 0; level <= 5; level++) {
        const rightWidth = hasCurrentPdfData
          ? (toolbarProbeRefs.current[Math.max(0, Math.min(level - 1, 3))]
              ?.scrollWidth ?? 0)
          : 0;
        const required =
          fullLeftWidth +
          rightWidth -
          (level >= 5 ? exportWidth : 0) -
          (level >= 1 ? labelWidth : 0);
        // Collapse as needed during a morph, but only reveal controls after it settles.
        if (level < previous.level && layoutAnimating) continue;
        const expanding = level < previous.level || previous.findInOverflow;
        if (required + findWidth + (expanding ? 16 : 0) > available) continue;
        return level === previous.level && !previous.findInOverflow
          ? previous
          : { level, findInOverflow: false };
      }
      return previous.level === 5 && previous.findInOverflow === showFind
        ? previous
        : { level: 5, findInOverflow: showFind };
    });
  }, [
    hasCurrentPdfData,
    hideExport,
    actionsOpen,
    isEditingPage,
    layoutAnimating,
    showFind,
  ]);

  useLayoutEffect(() => {
    const raf = requestAnimationFrame(() => measureToolbarOverflow());
    return () => cancelAnimationFrame(raf);
  }, [
    measureToolbarOverflow,
    hasCurrentPdfData,
    currentPage,
    numPages,
    scale,
    fitMode,
    isEditingPage,
  ]);

  useEffect(() => {
    const row = toolbarRowRef.current;
    const left = toolbarLeftControlsRef.current;
    const right = toolbarRightControlsRef.current;
    const container = previewContainerRef.current;
    const targets = [row, left, right, container].filter(Boolean) as Element[];
    if (targets.length === 0 || typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver(() => {
      requestAnimationFrame(() => measureToolbarOverflow());
    });
    for (const target of targets) observer.observe(target);
    return () => observer.disconnect();
  }, [measureToolbarOverflow]);

  // Save/restore zoom state per root file on switch
  useEffect(() => {
    const prev = prevRootRef.current;
    if (prev && prev !== currentRootFileId) {
      // Save previous root's zoom
      zoomCache.set(prev, { scale, fitMode });
    }
    // Restore new root's zoom
    const cached = zoomCache.get(currentRootFileId);
    if (cached) {
      setScale(cached.scale);
      setFitMode(cached.fitMode);
    } else {
      setScale(1.0);
      setFitMode(DEFAULT_FIT_MODE);
    }
    prevRootRef.current = currentRootFileId;
  }, [currentRootFileId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Update alive set when active root changes and has PDF data
  useEffect(() => {
    if (!currentRootFileId || !hasCurrentPdfData) return;
    setAliveOrder((prev) => {
      if (prev[0] === currentRootFileId) return prev; // already at front
      const without = prev.filter((id) => id !== currentRootFileId);
      return [currentRootFileId, ...without].slice(0, MAX_ALIVE_VIEWERS);
    });
  }, [currentRootFileId, hasCurrentPdfData]);

  // PDF text selection toolbar
  const [pdfSelection, setPdfSelection] = useState<PdfTextSelection | null>(
    null,
  );
  const previewContainerRef = useRef<HTMLDivElement>(null);

  const handleTextClick = useCallback(
    (text: string) => {
      if (isolatedSnapshot) return;
      let index = content.indexOf(text);
      if (index === -1) {
        const cleanText = text.replace(/[{}\\$]/g, "");
        if (cleanText.length > 2) index = content.indexOf(cleanText);
      }
      if (index === -1 && text.length > 5) {
        const words = text.split(/\s+/).filter((w) => w.length > 3);
        for (const word of words) {
          index = content.indexOf(word);
          if (index !== -1) break;
        }
      }
      if (index !== -1) requestJumpToPosition(index);
    },
    [content, isolatedSnapshot, requestJumpToPosition],
  );

  const navigateSynctexResultToSource = useCallback(
    (result: SynctexResult, navigation: "locate" | "sync") => {
      if (isolatedSnapshot) return;
      const normalize = (path: string) =>
        path.replace(/\\/g, "/").replace(/^\.\//, "");
      const normalizedTarget = normalize(result.file);
      const targetFile = files.find(
        (file) => normalize(file.relativePath) === normalizedTarget,
      );
      if (!targetFile) return;

      const state = useDocumentStore.getState();
      const needsSwitch = state.activeFileId !== targetFile.id;
      if (navigation === "sync" && !scrollSyncEnabled && needsSwitch) return;
      if (needsSwitch) setActiveFile(targetFile.id);

      const fileContent = targetFile.content ?? "";
      const lines =
        targetFile.id === activeFile?.id
          ? sourceLinesRef.current
          : createSourceLineIndex(fileContent);
      const offset = lines.offset(result.line, Math.max(0, result.column));

      const navigate = () => {
        if (navigation === "locate") {
          const current = useDocumentStore.getState();
          if (
            current.projectRoot !== state.projectRoot ||
            current.activeFileId !== targetFile.id
          )
            return;
        }
        if (navigation === "sync") {
          onScrollSyncToEditor?.(offset);
        } else {
          requestJumpToPosition(offset, navigation === "locate");
        }
      };
      if (needsSwitch) setTimeout(navigate, 100);
      else navigate();
      return { fileId: targetFile.id, content: fileContent, position: offset };
    },
    [
      files,
      activeFile?.id,
      isolatedSnapshot,
      onScrollSyncToEditor,
      requestJumpToPosition,
      setActiveFile,
      scrollSyncEnabled,
    ],
  );

  const handleSynctexClick = useCallback(
    async (page: number, x: number, y: number) => {
      if (isolatedSnapshot || !projectRoot) return;
      const isCurrentContext = captureCompileContext();
      const result = await synctexEdit(projectRoot, page, x, y);
      if (!result || !isCurrentContext()) return;
      navigateSynctexResultToSource(result, "locate");
    },
    [isolatedSnapshot, navigateSynctexResultToSource, projectRoot],
  );

  // Resolved source location from synctex
  const [resolvedSource, setResolvedSource] = useState<{
    file: string;
    line: number;
    column: number;
  } | null>(null);

  const handleTextSelect = useCallback(
    (selection: PdfTextSelection | null) => {
      if (isolatedSnapshot) return;
      setPdfSelection(selection);
      setResolvedSource(null);
      if (selection) {
        const pdf = {
          documentPath: pdfDocumentPath,
          kind: pdfDocumentKind,
          page: selection.pageNumber,
        } as const;
        useDocumentStore.getState().setPdfSelectionContext({
          selectionKey: pdfSelectionKey(
            pdf,
            selection.pdfX,
            selection.pdfY,
            selection.text,
          ),
          pdf,
          label: pdfSelectionFallbackLabel(selection, pdfDocumentPath),
          filePath: pdfDocumentPath,
          selectedText: selection.text,
        });
      } else {
        useDocumentStore.getState().setPdfSelectionContext(null);
      }
    },
    [isolatedSnapshot, pdfDocumentPath, pdfDocumentKind],
  );

  const canMapPdfComment = Boolean(pdfComments && projectRoot);
  const canCommentOnPdfFile =
    isStandalonePdf &&
    canMapPdfComment &&
    !!pdfFingerprint &&
    pdfSelection?.source === standalonePdfData &&
    validPdfCommentRegions(pdfSelection?.regions);
  const [commentCheck, setCommentCheck] = useState<{
    selection: PdfTextSelection;
    files: typeof files;
    root: typeof projectRoot;
    activePath: string | undefined;
    generation: number;
    compiledGeneration: typeof compiledGeneration;
    choice: ReturnType<typeof pickPdfCommentRange>;
  } | null>(null);
  const checkedSelection =
    commentCheck?.selection === pdfSelection &&
    commentCheck?.files === files &&
    commentCheck?.root === projectRoot &&
    commentCheck?.activePath === activeFile?.relativePath &&
    commentCheck?.generation === contentGeneration &&
    commentCheck?.compiledGeneration === compiledGeneration
      ? commentCheck
      : null;
  const commentStatus = isStandalonePdf
    ? canCommentOnPdfFile
      ? "ready"
      : "unavailable"
    : !canMapPdfComment
      ? "unavailable"
      : !checkedSelection
        ? "checking"
        : checkedSelection.choice
          ? "ready"
          : "unavailable";
  const commentReason = isStandalonePdf
    ? canCommentOnPdfFile
      ? "Add comment"
      : "Select text in the current PDF to comment."
    : !canMapPdfComment
      ? "Recompile to enable comments."
      : commentStatus === "checking"
        ? "Finding source…"
        : commentStatus === "ready"
          ? "Add comment"
          : "Couldn’t locate the source. Select more surrounding text.";

  // Selection detection is already debounced. Resolve once when its toolbar
  // opens, and discard results for an old selection or document snapshot.
  useEffect(() => {
    if (isStandalonePdf || isolatedSnapshot || !pdfSelection || !projectRoot)
      return;
    let cancelled = false;
    setCommentCheck(null);
    setResolvedSource(null);
    void (async () => {
      const sourceLocation = await synctexEdit(
        projectRoot,
        pdfSelection.pageNumber,
        pdfSelection.pdfX,
        pdfSelection.pdfY,
      ).catch(() => null);
      if (cancelled) return;
      setResolvedSource(sourceLocation);
      if (!canMapPdfComment) return;
      const sourceFile =
        sourceLocation &&
        files.find(
          (file) =>
            file.relativePath === sourceLocation.file ||
            sourceLocation.file.endsWith(`/${file.relativePath}`),
        );
      const choice = pickPdfCommentRange(
        files
          .filter((file) => file.relativePath.endsWith(".tex") && file.content)
          .map((file) => ({
            filePath: file.relativePath,
            content: file.content!,
          })),
        pdfSelection.text,
        {
          context: pdfSelection.context,
          source:
            sourceFile && sourceLocation
              ? { filePath: sourceFile.relativePath, line: sourceLocation.line }
              : undefined,
          activeFilePath: activeFile?.relativePath,
        },
      );
      // Reuse the availability result as optional source context. The PDF text
      // itself remains usable when no source match can be found.
      const chatContext = useDocumentStore.getState().pdfSelectionContext;
      if (
        choice &&
        chatContext?.label ===
          pdfSelectionFallbackLabel(pdfSelection, pdfDocumentPath) &&
        chatContext.selectedText === pdfSelection.text
      ) {
        const content = files.find(
          (file) => file.relativePath === choice.filePath,
        )!.content!;
        const start = offsetToLineCol(content, choice.range.from);
        const end = offsetToLineCol(content, choice.range.to);
        useDocumentStore.getState().setPdfSelectionContext({
          ...chatContext,
          label: `PDF p.${pdfSelection.pageNumber} · @${choice.filePath}:${start.line}:${start.col}-${end.line}:${end.col}`,
          filePath: choice.filePath,
          selectedText: `${pdfSelection.text}\n\n[${choice.approximate ? "Approximate source" : "Source"}: ${choice.filePath}, line ${choice.range.line}, offsets ${choice.range.from}–${choice.range.to}]`,
        });
      }
      if (!cancelled)
        setCommentCheck({
          selection: pdfSelection,
          files,
          root: projectRoot,
          activePath: activeFile?.relativePath,
          generation: contentGeneration,
          compiledGeneration,
          choice,
        });
    })();
    return () => {
      cancelled = true;
    };
  }, [
    isStandalonePdf,
    isolatedSnapshot,
    pdfSelection,
    projectRoot,
    files,
    activeFile?.relativePath,
    contentGeneration,
    compiledGeneration,
    canMapPdfComment,
    pdfDocumentPath,
  ]);

  const pdfContextLabel = resolvedSource
    ? `~@${resolvedSource.file}:${resolvedSource.line}`
    : pdfSelection
      ? `~@PDF page ${pdfSelection.pageNumber}`
      : "";

  const pdfToolbarActions: ToolbarAction[] = useMemo(
    () => [
      ...(pdfCommentsVisible &&
      !isolatedSnapshot &&
      !agentWorkspaceRoot &&
      projectRoot
        ? [
            {
              id: "comment",
              isAI: false,
              label: "Comment",
              icon:
                commentStatus === "checking" ? (
                  <LoaderIcon className="size-4 animate-spin" />
                ) : (
                  <MessageSquareTextIcon className="size-4" />
                ),
              disabled: commentStatus !== "ready" || !commentsLoaded,
              busy: commentStatus === "checking",
              description: commentReason,
            },
          ]
        : []),
    ],
    [
      isolatedSnapshot,
      agentWorkspaceRoot,
      projectRoot,
      pdfCommentsVisible,
      commentStatus,
      commentReason,
      commentsLoaded,
    ],
  );

  const handlePdfToolbarAction = useCallback(
    async (actionId: string) => {
      if (!pdfSelection || actionId !== "comment") return;
      if (!commentsLoaded) return;
      const fileComment =
        canCommentOnPdfFile && pdfSelection.regions && pdfFingerprint
          ? {
              fingerprint: pdfFingerprint,
              text: pdfSelection.text,
              regions: pdfSelection.regions,
            }
          : undefined;
      const choice = fileComment
        ? {
            filePath: pdfDocumentPath,
            range: { from: 0, to: 0, line: pdfSelection.pageNumber },
            approximate: false,
          }
        : commentStatus === "ready"
          ? checkedSelection?.choice
          : null;
      const document = useDocumentStore.getState();
      if (
        !choice ||
        (!fileComment && !checkedSelection) ||
        document.projectRoot !== projectRoot ||
        document.agentWorkspaceRoot ||
        (!fileComment &&
          (document.files !== checkedSelection?.files ||
            document.contentGeneration !== checkedSelection?.generation ||
            document.lastCompiledGenerations.get(currentRootFileId) !==
              checkedSelection?.compiledGeneration))
      )
        return;
      const filePath = choice.filePath;
      const range = choice.range;
      const id = crypto.randomUUID();
      const draftComment = {
        id,
        pdf: fileComment,
        ...range,
        text: "",
        createdAt: new Date().toISOString(),

        isEditing: true,
      };
      setProjectComments((current) => ({
        ...current,
        [filePath]: [
          ...(current[filePath] ?? []).filter(
            (comment) => comment.text.trim() || !comment.isEditing,
          ),
          draftComment,
        ],
      }));
      if (projectRoot)
        setCommentDraft({ root: projectRoot, filePath }, id, {
          comment: draftComment,
          text: "",
        });
      setCenterRequestedComment(false);
      setNewCommentId(id);
      setCommentRequestRevision((revision) => revision + 1);
      if (choice.approximate) {
        toast.info("Matched approximately—check the highlighted source.", {
          duration: 10000,
          action: {
            label: "Show source",
            onClick: () => {
              if (useDocumentStore.getState().projectRoot !== projectRoot)
                return;
              onRevealSource?.();
              window.dispatchEvent(
                new CustomEvent(PDF_COMMENT_NAVIGATE_EVENT, {
                  detail: { projectRoot, filePath, commentId: id },
                }),
              );
            },
          },
        });
      }
      const sel = pdfSelection;
      setPdfSelection(null);
      sel.clear();
    },
    [
      pdfSelection,
      canCommentOnPdfFile,
      pdfFingerprint,
      pdfDocumentPath,
      commentStatus,
      checkedSelection,
      currentRootFileId,
      setProjectComments,
      commentsLoaded,
      activeFile?.relativePath,
      projectRoot,
      onRevealSource,
    ],
  );

  const commentTarget = useActionTarget(
    () => previewContainerRef.current,
    activeFile?.id ?? "",
  );
  const commentTool = pdfToolbarActions.find(
    (action) => action.id === "comment",
  );
  const addCommentAction = useAppAction(
    {
      id: "add-comment",
      label: commentTool?.label ?? "Comment",
      visible: !!commentTool,
      enabled: !!pdfSelection && !commentTool?.disabled,
      run: () => handlePdfToolbarAction("comment"),
      menu: { group: "Edit", section: 0, order: 0, submenu: "Comments" },
    },
    commentTarget ? "active" : "inactive",
  );

  const handlePdfToolbarDismiss = useCallback(
    (reason?: "outside" | "escape") => {
      if (reason !== "outside") {
        pdfSelection?.clear();
        useDocumentStore.getState().setPdfSelectionContext(null);
      }
      setPdfSelection(null);
    },
    [pdfSelection],
  );

  const getPdfToolbarAnchor = useCallback(() => {
    if (!pdfSelection) return null;
    const rect = pdfSelection.getBounds();
    if (!rect) return null;
    const viewport = pdfSelection.viewport.getBoundingClientRect();
    const bounds = {
      top: Math.max(0, viewport.top) + 8,
      bottom: Math.min(window.innerHeight, viewport.bottom) - 8,
      left: Math.max(0, viewport.left) + 8,
      right: Math.min(window.innerWidth, viewport.right) - 8,
    };
    if (
      rect.width <= 0 ||
      rect.height <= 0 ||
      bounds.right <= bounds.left ||
      bounds.bottom <= bounds.top ||
      rect.bottom <= Math.max(0, viewport.top) ||
      rect.top >= Math.min(window.innerHeight, viewport.bottom) ||
      rect.right <= Math.max(0, viewport.left) ||
      rect.left >= Math.min(window.innerWidth, viewport.right)
    )
      return null;
    return { top: rect.top, left: rect.left - 42 - 8, bounds };
  }, [pdfSelection]);

  useEffect(() => {
    hasInitialCompile.current = false;
  }, [projectRoot, currentRootFileId]);

  useEffect(() => {
    hasAutoCompileBaseline.current = false;
    hasBackendBaseline.current = false;
  }, [projectRoot]);

  useEffect(() => {
    if (isStandalonePdf) return;
    if (!projectRoot || !currentRootFileId || !currentRootFile?.content) return;
    useSettingsStore
      .getState()
      .initializeCompilerChoiceForRoot(
        projectRoot,
        currentRootFileId,
        detectedRootEngine,
      );
  }, [
    isStandalonePdf,
    projectRoot,
    currentRootFileId,
    currentRootFile?.content,
    detectedRootEngine,
  ]);

  const fittedScale = useCallback(
    (width: number, height: number) => {
      if (!fitMode || !firstPageSize) return scale;
      return clampPdfScale(
        fitMode === "fit-width"
          ? Math.round(width - 32) / firstPageSize.width
          : Math.round(height - 32) / firstPageSize.height,
      );
    },
    [fitMode, firstPageSize, scale],
  );
  const openingPdf =
    columnLayoutAnimating &&
    layoutTarget &&
    layoutTarget.from <= 0.5 &&
    layoutTarget.to > 0.5;
  const closingPdf =
    columnLayoutAnimating && layoutTarget && layoutTarget.to <= 0.5;
  const motionScale =
    fitMode &&
    containerSize &&
    (openingPdf || containerSize.width > 1) &&
    !closingPdf
      ? fittedScale(
          columnLayoutAnimating && layoutTarget
            ? (openingPdf ? layoutTarget.width : layoutTarget.currentWidth) -
                viewportWidthInset.current
            : containerSize.width,
          containerSize.height,
        )
      : scale;
  const renderScale = openingPdf ? motionScale : scale;

  // Panel motion changes only CSS geometry. Commit the sharp raster at the end.
  useLayoutEffect(() => {
    if (layoutAnimating || !fitMode || !containerSize || !firstPageSize) return;
    const viewport = fitViewportRef.current;
    if (viewport && viewport.clientWidth <= 1) return;
    setScale(
      fittedScale(
        viewport
          ? viewport.clientWidth -
              (Number.parseFloat(
                getComputedStyle(viewport).getPropertyValue(
                  "--pdf-minimap-inset",
                ),
              ) || 0)
          : containerSize.width,
        viewport?.clientHeight ?? containerSize.height,
      ),
    );
  }, [fitMode, containerSize, firstPageSize, layoutAnimating, fittedScale]);

  const selectFitMode = (mode: FitMode) => setFitMode(mode);

  const zoomIn = useCallback(() => {
    setFitMode(null);
    setScale((s) => clampPdfScale(s + 0.1));
  }, []);
  const zoomOut = useCallback(() => {
    setFitMode(null);
    setScale((s) => clampPdfScale(s - 0.1));
  }, []);

  const exportFileName = files.find(
    (f) => f.name === "main.tex" || f.name === "document.tex",
  )?.name;
  const handleExport = useCallback(async () => {
    const currentPdf = isStandalonePdf
      ? standalonePdfData
      : getCurrentPdfBytes();
    if (!currentPdf) return;
    const defaultName = exportFileName
      ? exportFileName.replace(/\.tex$/, ".pdf")
      : "document.pdf";
    const filePath = await save({
      title: "Export PDF",
      defaultPath: defaultName,
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    if (!filePath) return;
    await exportPdfSource(currentPdf, filePath);
  }, [isStandalonePdf, standalonePdfData, exportFileName]);

  const exportAction = useAppAction(
    {
      id: "export-pdf",
      label: "Export PDF",
      visible: hasCurrentPdfData,
      enabled: hasCurrentPdfData,
      run: handleExport,
      menu: { group: "File", section: 2, order: 1 },
    },
    commentTarget ? "active" : "fallback",
  );

  const handleCurrentPageChange = useCallback(
    (page: number) => {
      setCurrentPage((prev) => {
        if (prev === page) return prev;
        if (!isEditingPage) setPageInputValue(String(page));
        return page;
      });
    },
    [isEditingPage],
  );

  const goToPage = useCallback(
    (page: number) => {
      const clamped = Math.max(1, Math.min(numPages, page));
      scrollToPageRef.current?.(clamped);
    },
    [numPages],
  );

  const navigateCurrentPageToSource = useCallback(async () => {
    if (isolatedSnapshot || !projectRoot || currentPage < 1) return;
    const requestId = ++scrollSyncRequestIdRef.current;
    sourceScrollSyncRequestIdRef.current += 1;
    const isCurrentContext = captureCompileContext();
    const result = await synctexEdit(
      projectRoot,
      currentPage,
      firstPageSize ? firstPageSize.width / 2 : 0,
      firstPageSize ? firstPageSize.height / 2 : 0,
    );
    if (
      !result ||
      requestId !== scrollSyncRequestIdRef.current ||
      !isCurrentContext()
    )
      return;
    setResolvedSource(result);
    navigateSynctexResultToSource(result, "locate");
  }, [
    isolatedSnapshot,
    projectRoot,
    currentPage,
    firstPageSize,
    navigateSynctexResultToSource,
  ]);

  const navigateSourcePositionToPdf = useCallback(
    async (
      position: number,
      suppressFeedback = false,
      expectedRequestId?: number,
    ) => {
      if (
        isolatedSnapshot ||
        !projectRoot ||
        (expectedRequestId !== undefined &&
          expectedRequestId !== sourceScrollSyncRequestIdRef.current)
      )
        return;
      const state = useDocumentStore.getState();
      const currentFile = state.files.find((f) => f.id === state.activeFileId);
      if (!currentFile || currentFile.type !== "tex") return;

      const content = currentFile.content ?? "";
      const sourceRequestId = scrollSyncSourceTargetRef.current?.id;
      const clampedPosition = Math.max(0, Math.min(position, content.length));
      const linked = linkedReadingAnchorRef.current;
      if (
        linked?.source.fileId === currentFile.id &&
        linked.revision === state.pdfRevision &&
        linked.source.content === content &&
        linked.source.position === clampedPosition
      ) {
        if (suppressFeedback) {
          ignorePdfScrollSyncUntilRef.current = performance.now() + 400;
        }
        readingAnchorRef.current?.align(linked.pdf, !suppressFeedback);
        return;
      }
      const { line, column } =
        sourceLinesRef.current.lineAndColumn(clampedPosition);

      const result = await synctexView(
        projectRoot,
        currentFile.relativePath,
        line,
        column,
      );
      if (!result) return;
      const latest = useDocumentStore.getState();
      if (
        latest.projectRoot !== projectRoot ||
        latest.activeFileId !== currentFile.id ||
        latest.files.find((file) => file.id === currentFile.id)?.content !==
          currentFile.content ||
        latest.pdfRevision !== state.pdfRevision
      )
        return;
      if (
        expectedRequestId !== undefined &&
        expectedRequestId !== sourceScrollSyncRequestIdRef.current
      ) {
        return;
      }
      if (suppressFeedback) {
        ignorePdfScrollSyncUntilRef.current = performance.now() + 400;
      }
      const pdf = { page: result.page, pdfX: result.x, pdfY: result.y };
      linkedReadingAnchorRef.current = {
        source: { fileId: currentFile.id, content, position: clampedPosition },
        pdf,
        revision: state.pdfRevision,
        sourceRequestId,
      };
      readingAnchorRef.current?.align(pdf, !suppressFeedback);
    },
    [isolatedSnapshot, projectRoot],
  );

  const navigateEditorToPdf = useCallback(async () => {
    const requestId = ++sourceScrollSyncRequestIdRef.current;
    scrollSyncRequestIdRef.current += 1;
    const state = useDocumentStore.getState();
    const position = state.selectionRange?.start ?? state.cursorPosition;
    await navigateSourcePositionToPdf(position, false, requestId);
  }, [navigateSourcePositionToPdf]);

  type NativeScrollRequest =
    | { kind: "source"; position: number; epoch: number }
    | { kind: "pdf"; position: PdfScrollPosition; epoch: number };
  const nativeScrollRunRef = useRef<
    (request: NativeScrollRequest) => Promise<unknown>
  >(async () => {});
  const nativeScrollTask = useMemo(
    () =>
      new CoalescedScrollTask<NativeScrollRequest>((request) =>
        nativeScrollRunRef.current(request),
      ),
    [],
  );
  const processedSourceTargetRef = useRef<typeof scrollSyncSourceTarget>(null);
  const sourceFallback = useMemo(
    () => ({
      push: (request: { position: number; epoch: number }) =>
        nativeScrollTask.push({ ...request, kind: "source" }),
      clear: () => nativeScrollTask.clear(),
    }),
    [nativeScrollTask],
  );

  useEffect(() => {
    if (
      !scrollSyncEnabled ||
      isCompiling ||
      !Number.isFinite(ignorePdfScrollSyncUntilRef.current) ||
      !scrollSyncSourceTarget ||
      !hasCurrentPdfData
    )
      return;
    if (processedSourceTargetRef.current === scrollSyncSourceTarget) return;
    processedSourceTargetRef.current = scrollSyncSourceTarget;
    if (syncDriverRef.current !== "editor") {
      syncDriverRef.current = "editor";
      sourceScrollSyncRequestIdRef.current += 1;
    }
    scrollSyncRequestIdRef.current += 1;
    const position = scrollSyncSourceTarget.position;
    const mapped =
      compiledGeneration === contentGeneration && activeFile
        ? compiledMap?.index?.forward(
            activeFile.relativePath,
            sourceLines.coordinate(position),
          )
        : null;
    const anchor = readingAnchorRef.current;
    if (mapped && anchor) {
      sourceFallback.clear();
      // A valid compiled mapping owns this position through idle as well.
      // Switching to a native box origin after release causes a visible jump.
      sourceScrollSyncRequestIdRef.current += 1;
      const pdf = anchor.interpolate(mapped.from, mapped.to, mapped.fraction);
      ignorePdfScrollSyncUntilRef.current = performance.now() + 400;
      linkedReadingAnchorRef.current = {
        source: {
          fileId: activeFile!.id,
          content: activeFile!.content ?? "",
          position,
        },
        pdf,
        revision: pdfRevision,
        sourceRequestId: scrollSyncSourceTarget.id,
      };
      anchor.align(pdf);
    } else
      sourceFallback.push({
        position,
        epoch: sourceScrollSyncRequestIdRef.current,
      });
  }, [
    hasCurrentPdfData,
    sourceFallback,
    scrollSyncEnabled,
    scrollSyncSourceTarget,
    isCompiling,
    compiledGeneration,
    contentGeneration,
    compiledMap,
    activeFile,
    sourceLines,
    pdfRevision,
  ]);

  useEffect(
    () => () => {
      sourceFallback.clear();
      sourceScrollSyncRequestIdRef.current += 1;
    },
    [sourceFallback],
  );

  useLayoutEffect(() => {
    // Ignore reflow-generated editor/PDF scroll events in both directions.
    ignorePdfScrollSyncUntilRef.current = performance.now() + 400;
  }, [layoutAnimating]);

  const inverseNavigationRef = useRef(navigateSynctexResultToSource);
  inverseNavigationRef.current = navigateSynctexResultToSource;
  const onScrollSyncToEditorRef = useRef(onScrollSyncToEditor);
  onScrollSyncToEditorRef.current = onScrollSyncToEditor;
  const pdfFallback = useMemo(
    () => ({
      push: (request: { position: PdfScrollPosition; epoch: number }) =>
        nativeScrollTask.push({ ...request, kind: "pdf" }),
      clear: () => nativeScrollTask.clear(),
    }),
    [nativeScrollTask],
  );
  nativeScrollRunRef.current = async (request) => {
    if (request.kind === "source")
      return navigateSourcePositionToPdf(request.position, true, request.epoch);
    const { position, epoch } = request;
    if (!projectRoot || epoch !== scrollSyncRequestIdRef.current) return;
    const result = await synctexEdit(
      projectRoot,
      position.page,
      position.pdfX,
      position.pdfY,
    );
    if (!result || epoch !== scrollSyncRequestIdRef.current) return;
    const source = inverseNavigationRef.current(result, "sync");
    if (source)
      linkedReadingAnchorRef.current = {
        source,
        pdf: position,
        revision: pdfRevision,
        sourceRequestId: scrollSyncSourceTargetRef.current?.id,
      };
  };

  useEffect(
    () => () => {
      pdfFallback.clear();
      scrollSyncRequestIdRef.current += 1;
    },
    [pdfFallback],
  );

  const handlePdfScrollIntent = useCallback(() => {
    ignorePdfScrollSyncUntilRef.current = 0;
    sourceScrollSyncRequestIdRef.current += 1;
    sourceFallback.clear();
  }, [sourceFallback]);

  const handlePdfScrollPositionChange = useCallback(
    (position: PdfScrollPosition) => {
      if (
        (!scrollSyncEnabled && !outlineTrackingEnabled) ||
        scrollSyncPaused ||
        layoutAnimating ||
        isStandalonePdf ||
        !projectRoot ||
        suppressPdfToEditorSyncRef.current ||
        performance.now() < ignorePdfScrollSyncUntilRef.current
      )
        return;
      const linked = linkedReadingAnchorRef.current;
      if (
        linked &&
        linked.revision === pdfRevision &&
        linked.pdf.page === position.page &&
        Math.abs(linked.pdf.pdfX - position.pdfX) < 1 &&
        Math.abs(linked.pdf.pdfY - position.pdfY) < 1
      )
        return;
      if (syncDriverRef.current !== "pdf") {
        syncDriverRef.current = "pdf";
        scrollSyncRequestIdRef.current += 1;
      }
      sourceScrollSyncRequestIdRef.current += 1;
      sourceFallback.clear();
      const coordinate =
        compiledGeneration === contentGeneration && activeFile
          ? compiledMap?.index?.inverse(activeFile.relativePath, position)
          : null;
      if (coordinate != null && activeFile) {
        pdfFallback.clear();
        scrollSyncRequestIdRef.current += 1;
        const offset = sourceLines.offset(coordinate);
        onScrollSyncToEditorRef.current?.(offset);
        linkedReadingAnchorRef.current = {
          source: {
            fileId: activeFile.id,
            content: activeFile.content ?? "",
            position: offset,
          },
          pdf: position,
          revision: pdfRevision,
          sourceRequestId: scrollSyncSourceTargetRef.current?.id,
        };
      } else
        pdfFallback.push({ position, epoch: scrollSyncRequestIdRef.current });
    },
    [
      scrollSyncEnabled,
      outlineTrackingEnabled,
      scrollSyncPaused,
      layoutAnimating,
      isStandalonePdf,
      projectRoot,
      sourceFallback,
      pdfFallback,
      compiledGeneration,
      contentGeneration,
      activeFile,
      compiledMap,
      sourceLines,
      pdfRevision,
    ],
  );

  useLayoutEffect(() => {
    syncDriverRef.current = null;
    sourceScrollSyncRequestIdRef.current += 1;
    scrollSyncRequestIdRef.current += 1;
    sourceFallback.clear();
    pdfFallback.clear();
  }, [
    projectRoot,
    activeFile?.id,
    activeFile?.content,
    pdfRevision,
    scrollSyncEnabled,
    scrollSyncPaused,
    isCompiling,
    layoutAnimating,
    sourceFallback,
    pdfFallback,
  ]);

  useEffect(() => {
    if (!outlineTrackingEnabled || layoutAnimating || !hasCurrentPdfData)
      return;
    // Wait for the existing layout/scale synchronization suppression to expire.
    const timer = setTimeout(() => {
      const position = readingAnchorRef.current?.read();
      if (position) handlePdfScrollPositionChange(position);
    }, 550);
    return () => {
      clearTimeout(timer);
      scrollSyncRequestIdRef.current += 1;
    };
  }, [
    outlineTrackingEnabled,
    layoutAnimating,
    hasCurrentPdfData,
    handlePdfScrollPositionChange,
  ]);

  useEffect(() => {
    sourceScrollSyncRequestIdRef.current += 1;
    scrollSyncRequestIdRef.current += 1;
    if (scrollSyncEnabled) {
      ignorePdfScrollSyncUntilRef.current = performance.now() + 500;
      return;
    }
    pendingEditorAuthoritativeRevisionRef.current = null;
    aligningEditorAuthoritativeRevisionRef.current = null;
    suppressPdfToEditorSyncRef.current = false;
  }, [scrollSyncEnabled]);

  useEffect(
    () => () => {
      if (postCompileSyncFrameRef.current !== null) {
        cancelAnimationFrame(postCompileSyncFrameRef.current);
      }
      if (postCompileReleaseFrameRef.current !== null) {
        cancelAnimationFrame(postCompileReleaseFrameRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    if (!syncNavigationRequest) return;
    sourceFallback.clear();
    pdfFallback.clear();
    if (lastHandledSyncNavigationIdRef.current === syncNavigationRequest.id)
      return;
    lastHandledSyncNavigationIdRef.current = syncNavigationRequest.id;
    if (syncNavigationRequest.direction === "to-pdf") {
      void navigateEditorToPdf();
    } else {
      void navigateCurrentPageToSource();
    }
    onSyncNavigationHandled?.(syncNavigationRequest.id);
  }, [
    syncNavigationRequest,
    sourceFallback,
    pdfFallback,
    navigateEditorToPdf,
    navigateCurrentPageToSource,
    onSyncNavigationHandled,
  ]);

  const handlePageInputCommit = useCallback(() => {
    setIsEditingPage(false);
    if (cancelledPageInputRef.current) return;
    const parsed = parseInt(pageInputValue, 10);
    if (!Number.isNaN(parsed) && parsed >= 1 && parsed <= numPages) {
      goToPage(parsed);
    } else {
      setPageInputValue(String(currentPage));
    }
  }, [pageInputValue, numPages, currentPage, goToPage]);

  const handleLoadSuccess = useCallback(
    (pages: number) => {
      setNumPages(pages);

      const revision = pendingEditorAuthoritativeRevisionRef.current;
      if (
        revision === null ||
        revision !== lastObservedPdfRevisionRef.current ||
        !scrollSyncEnabledRef.current ||
        aligningEditorAuthoritativeRevisionRef.current === revision
      ) {
        return;
      }
      aligningEditorAuthoritativeRevisionRef.current = revision;

      if (postCompileSyncFrameRef.current !== null) {
        cancelAnimationFrame(postCompileSyncFrameRef.current);
      }
      postCompileSyncFrameRef.current = requestAnimationFrame(() => {
        postCompileSyncFrameRef.current = null;
        if (
          pendingEditorAuthoritativeRevisionRef.current !== revision ||
          !scrollSyncEnabledRef.current
        ) {
          return;
        }

        // Use the latest editor viewport target, not the cursor captured when
        // compilation started. The editor may have scrolled while compiling.
        const state = useDocumentStore.getState();
        const sourceTarget = scrollSyncSourceTargetRef.current;
        const linked = linkedReadingAnchorRef.current;
        const position =
          (sourceTarget && sourceTarget.id !== linked?.sourceRequestId
            ? sourceTarget.position
            : (linked?.source.position ?? sourceTarget?.position)) ??
          state.selectionRange?.start ??
          state.cursorPosition;
        const requestId = ++sourceScrollSyncRequestIdRef.current;

        void navigateSourcePositionToPdf(position, true, requestId).finally(
          () => {
            if (pendingEditorAuthoritativeRevisionRef.current !== revision) {
              return;
            }
            if (postCompileReleaseFrameRef.current !== null) {
              cancelAnimationFrame(postCompileReleaseFrameRef.current);
            }
            // Let the viewer commit its programmatic scroll before restoring
            // bidirectional synchronization. The time guard absorbs the
            // resulting native scroll event after the explicit phase ends.
            postCompileReleaseFrameRef.current = requestAnimationFrame(() => {
              postCompileReleaseFrameRef.current = requestAnimationFrame(() => {
                postCompileReleaseFrameRef.current = null;
                if (
                  pendingEditorAuthoritativeRevisionRef.current !== revision
                ) {
                  return;
                }
                pendingEditorAuthoritativeRevisionRef.current = null;
                aligningEditorAuthoritativeRevisionRef.current = null;
                ignorePdfScrollSyncUntilRef.current = performance.now() + 400;
                if (!useDocumentStore.getState().isCompiling) {
                  suppressPdfToEditorSyncRef.current = false;
                }
              });
            });
          },
        );
      });
    },
    [navigateSourcePositionToPdf],
  );
  const handleScaleChange = (newScale: number) => {
    setFitMode(null);
    setScale(newScale);
  };

  const handleCompile = useCallback(
    async (force = false, automatic = false) => {
      if (isStandalonePdf) return;
      setPdfError(null);
      await compileWorkspace({ force, automatic });
    },
    [isStandalonePdf],
  );

  const handleStopCompilation = useCallback(() => {
    void stopCompilation().catch((error) => {
      toast.error("Could not stop compilation", {
        description: error instanceof Error ? error.message : String(error),
      });
    });
  }, []);

  const [stopHovered, setStopHovered] = useState(false);
  const [stopFocused, setStopFocused] = useState(false);
  const stopHoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suppressStopHover = useRef(false);
  const compilePointerType = useRef("mouse");
  const clearStopHoverTimer = useCallback(() => {
    if (stopHoverTimer.current !== null) {
      clearTimeout(stopHoverTimer.current);
      stopHoverTimer.current = null;
    }
  }, []);
  const enterCompileButton = useCallback(
    (event: PointerEvent<HTMLButtonElement>) => {
      if (event.pointerType === "touch") return;
      clearStopHoverTimer();
      if (!isCompiling || isStoppingCompilation || suppressStopHover.current)
        return;
      // Match the chat drawer's brief reveal delay.
      stopHoverTimer.current = setTimeout(() => {
        stopHoverTimer.current = null;
        setStopHovered(true);
      }, 50);
    },
    [clearStopHoverTimer, isCompiling, isStoppingCompilation],
  );
  const leaveCompileButton = useCallback(
    (event: PointerEvent<HTMLButtonElement>) => {
      if (event.pointerType === "touch") return;
      suppressStopHover.current = false;
      clearStopHoverTimer();
      setStopHovered(false);
    },
    [clearStopHoverTimer],
  );
  useEffect(() => {
    clearStopHoverTimer();
    setStopHovered(false);
    setStopFocused(
      recompileButtonRef.current?.matches(":focus-visible") ?? false,
    );
    if (
      isCompiling &&
      !isStoppingCompilation &&
      !suppressStopHover.current &&
      recompileButtonRef.current?.matches(":hover")
    ) {
      stopHoverTimer.current = setTimeout(() => {
        stopHoverTimer.current = null;
        setStopHovered(true);
      }, 50);
    }
    return clearStopHoverTimer;
  }, [
    clearStopHoverTimer,
    isCompiling,
    isStoppingCompilation,
    projectRoot,
    currentRootFileId,
  ]);
  const showCompileStop =
    isCompiling && !isStoppingCompilation && (stopHovered || stopFocused);
  const activateCompileButton = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      if (isCompiling) {
        // A double click on Recompile must not cancel the build it just started.
        if (
          showCompileStop ||
          !suppressStopHover.current ||
          event.detail === 0 ||
          compilePointerType.current === "touch"
        )
          handleStopCompilation();
        return;
      }
      clearStopHoverTimer();
      setStopHovered(false);
      // Like the diagnostic controls, require leaving before hover can reveal
      // the changed action under a pointer that stayed here after activation.
      suppressStopHover.current =
        event.detail > 0 &&
        compilePointerType.current !== "touch" &&
        event.currentTarget.matches(":hover");
      void handleCompile(true);
    },
    [isCompiling, handleStopCompilation, clearStopHoverTimer, handleCompile],
  );

  const cancelScheduledAutoCompile = useCallback(() => {
    if (autoCompileTimerRef.current !== null) {
      clearTimeout(autoCompileTimerRef.current);
      autoCompileTimerRef.current = null;
    }
    forceNextAutoCompileRef.current = false;
  }, []);

  const scheduleAutoCompile = useCallback(
    (force = false) => {
      if (
        !useSettingsStore
          .getState()
          .getProjectAutoCompile(useDocumentStore.getState().projectRoot)
      )
        return;
      forceNextAutoCompileRef.current ||= force;
      if (autoCompileTimerRef.current !== null) {
        clearTimeout(autoCompileTimerRef.current);
      }
      const isCurrentContext = captureAutomaticCompileContext();
      autoCompileTimerRef.current = setTimeout(() => {
        autoCompileTimerRef.current = null;
        const shouldForce = forceNextAutoCompileRef.current;
        forceNextAutoCompileRef.current = false;
        if (isCurrentContext()) void handleCompile(shouldForce, true);
      }, 800);
    },
    [handleCompile],
  );

  useEffect(() => cancelScheduledAutoCompile, [cancelScheduledAutoCompile]);
  useEffect(() => {
    const stopped = () => {
      cancelScheduledAutoCompile();
      // Stopping the first build must not trigger another initial build.
      hasInitialCompile.current = true;
    };
    window.addEventListener(COMPILATION_STOP_EVENT, stopped);
    return () => window.removeEventListener(COMPILATION_STOP_EVENT, stopped);
  }, [cancelScheduledAutoCompile]);

  useEffect(() => {
    cancelScheduledAutoCompile();
  }, [
    cancelScheduledAutoCompile,
    autoCompile,
    resolvedCompilerChoice.backend,
    resolvedCompilerChoice.engine,
    resolvedCompilerChoice.autoEngine,
    projectRoot,
    agentWorkspaceRoot,
    currentRootFileId,
  ]);

  useEffect(() => {
    if (isStandalonePdf) return;

    const handleMergePreviewRefresh = () => {
      const state = useDocumentStore.getState();
      if (!state.initialized || !state.projectRoot || !hasTexProject) return;
      scheduleAutoCompile(true);
    };

    window.addEventListener(
      MERGE_PREVIEW_REFRESH_EVENT,
      handleMergePreviewRefresh,
    );
    return () => {
      window.removeEventListener(
        MERGE_PREVIEW_REFRESH_EVENT,
        handleMergePreviewRefresh,
      );
    };
  }, [hasTexProject, isStandalonePdf, scheduleAutoCompile]);

  useEffect(() => {
    if (isStandalonePdf) return;
    if (!autoCompile || hasInitialCompile.current) return;
    if (!initialized || !projectRoot || !hasTexProject) return;
    if (hasCurrentPdfData || isCompiling || compileError) return;

    hasInitialCompile.current = true;
    scheduleAutoCompile(true);
  }, [
    autoCompile,
    isStandalonePdf,
    compileError,
    scheduleAutoCompile,
    hasTexProject,
    initialized,
    isCompiling,
    hasCurrentPdfData,
    projectRoot,
    currentRootFileId,
  ]);

  useEffect(() => {
    if (isStandalonePdf) return;
    if (!initialized || !projectRoot || !hasTexProject) return;
    if (!hasBackendBaseline.current) {
      hasBackendBaseline.current = true;
      return;
    }
    scheduleAutoCompile(true);
  }, [
    autoCompile,
    isStandalonePdf,
    resolvedCompilerChoice.backend,
    resolvedCompilerChoice.engine,
    resolvedCompilerChoice.autoEngine,
    scheduleAutoCompile,
    hasTexProject,
    initialized,
    projectRoot,
  ]);

  useEffect(() => {
    if (isStandalonePdf) return;
    if (!initialized || !projectRoot || !hasTexProject) return;
    if (!hasAutoCompileBaseline.current) {
      hasAutoCompileBaseline.current = true;
      lastAutoCompileGenerationRef.current = contentGeneration;
      return;
    }
    if (
      !autoCompile ||
      contentGeneration === lastAutoCompileGenerationRef.current
    )
      return;

    lastAutoCompileGenerationRef.current = contentGeneration;
    scheduleAutoCompile(false);
  }, [
    autoCompile,
    isStandalonePdf,
    resolvedCompilerChoice.backend,
    resolvedCompilerChoice.engine,
    resolvedCompilerChoice.autoEngine,
    contentGeneration,
    hasTexProject,
    initialized,
    projectRoot,
    scheduleAutoCompile,
  ]);

  const renderContent = () => {
    if (effectiveCompileError) {
      const errors = [
        ...new Set(
          effectiveCompileError
            .split(/\s*!\s*/)
            .map((s) => s.trim())
            .filter((s) => s.length > 0 && s !== "Compilation failed"),
        ),
      ];

      const handleFixWithChat = () => {
        if (isReferencePanelWindow()) return;
        const errorList = errors.map((e) => `- ${e}`).join("\n");
        useAgentChatStore
          .getState()
          .sendPrompt(
            `[Compilation errors]\n${errorList}\n\nFix these LaTeX compilation errors.`,
          );
      };

      return (
        <div className="flex flex-1 flex-col items-center justify-center bg-muted/30 p-6">
          <div className="w-full max-w-lg">
            <div className="mb-4 flex items-center gap-2 text-destructive">
              <AlertCircleIcon className="size-5" />
              <h2 className="font-semibold text-base">Compilation Failed</h2>
              <span className="ml-auto rounded-full bg-destructive/15 px-2 py-0.5 font-medium text-xs">
                {errors.length} {errors.length === 1 ? "error" : "errors"}
              </span>
            </div>
            <div className="rounded-lg border border-destructive/20 bg-background">
              <div className="app-scrollbar max-h-60 divide-y divide-border overflow-y-auto">
                {errors.map((error, i) => (
                  <div key={i} className="flex items-start gap-2.5 px-3 py-2.5">
                    <AlertCircleIcon className="mt-0.5 size-3.5 shrink-0 text-destructive/70" />
                    <span className="text-foreground text-sm">{error}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="mt-3 flex items-center gap-2">
              {!isStandalonePdf ? (
                <>
                  {!isReferencePanelWindow() && (
                    <button
                      onClick={handleFixWithChat}
                      className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 font-medium text-primary-foreground text-xs shadow-sm transition-colors hover:bg-primary/90"
                    >
                      <MousePointerClickIcon className="size-3.5" />
                      Fix with Chat
                    </button>
                  )}
                  <button
                    onClick={() => handleCompile(true)}
                    className="flex items-center gap-1.5 rounded-lg border border-border bg-background px-3 py-1.5 font-medium text-foreground text-xs transition-colors hover:bg-muted"
                  >
                    <RefreshCwIcon className="size-3.5" />
                    Retry
                  </button>
                </>
              ) : null}
            </div>
          </div>
        </div>
      );
    }
    if (!hasCurrentPdfData) {
      return (
        <div className="flex flex-1 flex-col items-center justify-center bg-muted/30 p-8">
          <FileTextIcon className="mb-4 size-16 text-muted-foreground/50" />
          <h2 className="mb-2 font-medium text-lg text-muted-foreground">
            PDF Preview
          </h2>
          <p className="mb-4 text-center text-muted-foreground text-sm">
            {isStandalonePdf
              ? "Loading PDF..."
              : autoCompile
                ? "Edit your source to update the preview automatically"
                : "Click Compile to preview your document"}
          </p>
          {!isStandalonePdf && hasTexProject && (
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              onClick={() => handleCompile(true)}
            >
              <RefreshCwIcon className="size-3.5" />
              Compile
            </Button>
          )}
        </div>
      );
    }
    if (pdfError) {
      return (
        <div className="flex flex-1 flex-col items-center justify-center bg-muted/30 p-8">
          <AlertCircleIcon className="mb-4 size-12 text-destructive" />
          <h2 className="mb-2 font-medium text-destructive text-lg">
            PDF Load Error
          </h2>
          <p className="max-w-md text-center text-muted-foreground text-sm">
            {pdfError}
          </p>
        </div>
      );
    }

    // Keep-alive rendering: one PdfViewer per root file, toggle via CSS.
    // Use visibility:hidden + absolute positioning instead of display:none
    // so that the browser preserves scrollTop on the overflow container.
    return (
      <div className="relative flex min-h-0 flex-1">
        {aliveOrder.map((rootId) => {
          if (isStandalonePdf && rootId !== currentRootFileId) return null;
          if (isStandalonePdf && !standalonePdfData) return null;
          const isActive = rootId === currentRootFileId;
          const dataSource =
            standalonePdfData != null
              ? {
                  kind: "standalone" as const,
                  data: standalonePdfData,
                }
              : {
                  kind: "compiled" as const,
                  rootFileId: rootId,
                  revision: isActive ? pdfRevision : 0,
                };
          return (
            <ErrorBoundary
              key={rootId}
              fallback={
                <div className="flex h-full flex-col items-center justify-center gap-3 bg-muted/30 p-8">
                  <AlertCircleIcon className="size-10 text-destructive" />
                  <p className="text-muted-foreground text-sm">
                    {isStandalonePdf
                      ? "PDF viewer crashed."
                      : "PDF viewer crashed. Try recompiling."}
                  </p>
                  {!isStandalonePdf ? (
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-1.5"
                      onClick={() => handleCompile(true)}
                    >
                      <RefreshCwIcon className="size-3.5" />
                      Recompile
                    </Button>
                  ) : null}
                </div>
              }
            >
              <div
                className={
                  isActive
                    ? "absolute inset-0 flex flex-col"
                    : "pointer-events-none invisible absolute inset-0 flex flex-col"
                }
              >
                <PdfCommentInteraction
                  fullWidth={pdfCommentFullWidth}
                  onToggleFullWidth={
                    editorVisible
                      ? undefined
                      : () => setPdfCommentFullWidth(!pdfCommentFullWidth)
                  }
                  context={isActive ? pdfComments : null}
                  editorVisible={editorVisible}
                  layoutAnimating={layoutAnimating}
                  actionsFor={commentActions}
                  requestedCommentId={newCommentId}
                  requestRevision={commentRequestRevision}
                  centerRequested={centerRequestedComment}
                  onSearchNavigate={locateSearchComment}
                  searchActive={isActive}
                >
                  <PdfViewer
                    dataSource={dataSource}
                    scale={renderScale}
                    displayScale={motionScale}
                    layoutAnimating={layoutAnimating}
                    rootFileId={rootId}
                    isolatedSelection={isolatedSnapshot}
                    documentReloadRevision={isolatedSnapshot ? pdfRevision : 0}
                    isActive={isActive}
                    searchAvailable={!editorVisible}
                    infoBarProjectKey={
                      isolatedSnapshot ? undefined : panelsProjectKey
                    }
                    onSearchChange={setActiveSearch}
                    isCompiling={!isStandalonePdf && isCompiling}
                    onError={isActive ? setPdfError : undefined}
                    onLoadSuccess={isActive ? handleLoadSuccess : undefined}
                    onScaleChange={isActive ? handleScaleChange : undefined}
                    onTextClick={
                      isActive && !isolatedSnapshot
                        ? handleTextClick
                        : undefined
                    }
                    onSynctexClick={
                      isActive && !isolatedSnapshot
                        ? handleSynctexClick
                        : undefined
                    }
                    onTextSelect={
                      isActive && !isolatedSnapshot
                        ? handleTextSelect
                        : undefined
                    }
                    onFirstPageSize={
                      isActive
                        ? (w, h) => setFirstPageSize({ width: w, height: h })
                        : undefined
                    }
                    onContainerResize={
                      isActive ? handleContainerResize : undefined
                    }
                    onCurrentPageChange={
                      isActive ? handleCurrentPageChange : undefined
                    }
                    onScrollIntent={
                      isActive && !isolatedSnapshot
                        ? handlePdfScrollIntent
                        : undefined
                    }
                    onScrollPositionChange={
                      isActive && !isolatedSnapshot
                        ? handlePdfScrollPositionChange
                        : undefined
                    }
                    readingAnchorRef={isActive ? readingAnchorRef : undefined}
                    scrollToPageRef={isActive ? scrollToPageRef : undefined}
                  />
                </PdfCommentInteraction>
              </div>
            </ErrorBoundary>
          );
        })}
      </div>
    );
  };

  const compilerControls = useMemo(
    () =>
      toolbarContent ??
      (!isStandalonePdf ? (
        <ButtonGroup
          variant="plain"
          aria-label="Compilation"
          className="flex h-7 shrink-0 items-center rounded-md border border-border/70 bg-muted/50 transition-opacity"
        >
          <Hint
            content={
              hideRecompileLabel && !isStoppingCompilation
                ? isCompiling
                  ? "Stop compilation"
                  : "Recompile"
                : null
            }
          >
            <Button
              ref={recompileButtonRef}
              variant="ghost"
              size="sm"
              className={cn(
                "group/compile h-7 shrink-0 gap-1 rounded-md rounded-r-none text-xs transition-colors duration-150 ease-out motion-reduce:transition-none",
                showCompileStop &&
                  "text-red-600 hover:text-red-600 dark:text-red-400 dark:hover:text-red-400",
                hideRecompileLabel
                  ? "justify-center px-0"
                  : "justify-start px-2",
              )}
              style={{
                width: hideRecompileLabel
                  ? RECOMPILE_ICON_BUTTON_WIDTH
                  : RECOMPILE_BUTTON_WIDTH,
              }}
              data-stop-visible={showCompileStop}
              onPointerEnter={enterCompileButton}
              onPointerLeave={leaveCompileButton}
              onPointerDown={(event) => {
                compilePointerType.current = event.pointerType;
                if (!isCompiling) setStopFocused(false);
              }}
              onFocus={(event) =>
                setStopFocused(event.currentTarget.matches(":focus-visible"))
              }
              onBlur={() => setStopFocused(false)}
              onClick={activateCompileButton}
              disabled={
                isStoppingCompilation ||
                (!isCompiling && (!hasTexProject || isSaving))
              }
              aria-label={
                isStoppingCompilation
                  ? "Stopping compilation"
                  : isCompiling
                    ? "Stop compilation"
                    : "Recompile"
              }
            >
              <span className="inline-grid size-3.5 shrink-0 place-items-center">
                <RefreshCwIcon
                  className={cn(
                    "col-start-1 row-start-1 size-3.5 transition-opacity duration-150 ease-out motion-reduce:transition-none",
                    (isSaving || isCompiling) && "animate-spin",
                    isCompiling &&
                      !isStoppingCompilation &&
                      "group-data-[stop-visible=true]/compile:opacity-0",
                  )}
                />
                {isCompiling && !isStoppingCompilation && (
                  <SquareIcon className="col-start-1 row-start-1 size-3.5 opacity-0 transition-opacity duration-150 ease-out group-data-[stop-visible=true]/compile:opacity-100 motion-reduce:transition-none" />
                )}
              </span>
              <span
                className={
                  hideRecompileLabel ? "hidden" : "inline-grid text-left"
                }
              >
                {isStoppingCompilation ? (
                  "Stopping..."
                ) : isCompiling ? (
                  <>
                    <span className="col-start-1 row-start-1 transition-opacity duration-150 ease-out group-data-[stop-visible=true]/compile:opacity-0 motion-reduce:transition-none">
                      Compiling...
                    </span>
                    <span className="col-start-1 row-start-1 opacity-0 transition-opacity duration-150 ease-out group-data-[stop-visible=true]/compile:opacity-100 motion-reduce:transition-none">
                      Stop
                    </span>
                  </>
                ) : isSaving ? (
                  "Saving..."
                ) : (
                  "Recompile"
                )}
              </span>
            </Button>
          </Hint>
          <span
            aria-hidden="true"
            className="button-group-separator [--button-group-separator-inset:6px]"
          />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-5 rounded-l-none"
                aria-label="Compilation options"
              >
                <ChevronDownIcon className="size-3" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {isCompiling && (
                <>
                  <DropdownMenuItem
                    onSelect={handleStopCompilation}
                    disabled={isStoppingCompilation}
                  >
                    <SquareIcon className="size-3.5" />
                    {isStoppingCompilation ? "Stopping..." : "Stop compilation"}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                </>
              )}
              <DropdownMenuLabel>
                <span className="inline-flex items-center gap-1.5">
                  {/* Material Design Icons engine-outline; see public/licenses/material-design-icons.txt. */}
                  <svg
                    aria-hidden="true"
                    viewBox="0 0 24 24"
                    fill="currentColor"
                    className="size-3.5 text-muted-foreground"
                  >
                    <path d="M8,10H16V18H11L9,16H7V11M7,4V6H10V8H7L5,10V13H3V10H1V18H3V15H5V18H8L10,20H18V16H20V19H23V9H20V12H18V8H12V6H15V4H7Z" />
                  </svg>
                  <span>Compiler settings</span>
                </span>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuRadioGroup
                value={compilerChoice}
                onValueChange={(value) =>
                  setCompilerChoice(value as CompilerChoice)
                }
              >
                <DropdownMenuRadioItem
                  value="latexmk:pdflatex"
                  indicatorPosition="end"
                  indicator={<CheckIcon className="size-4" />}
                  onSelect={(event) => event.preventDefault()}
                >
                  pdfLaTeX
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem
                  value="latexmk:xelatex"
                  indicatorPosition="end"
                  indicator={<CheckIcon className="size-4" />}
                  onSelect={(event) => event.preventDefault()}
                >
                  XeLaTeX
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem
                  value="latexmk:lualatex"
                  indicatorPosition="end"
                  indicator={<CheckIcon className="size-4" />}
                  onSelect={(event) => event.preventDefault()}
                >
                  LuaLaTeX
                </DropdownMenuRadioItem>
                <DropdownMenuSeparator />
                <DropdownMenuRadioItem
                  value="tectonic"
                  indicatorPosition="end"
                  indicator={<CheckIcon className="size-4" />}
                  onSelect={(event) => event.preventDefault()}
                >
                  Tectonic
                </DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
              <DropdownMenuSeparator />
              <DropdownMenuCheckboxItem
                className="justify-between gap-8"
                indicator={null}
                checked={autoCompile}
                onCheckedChange={(enabled) => {
                  if (projectRoot) setProjectAutoCompile(projectRoot, enabled);
                }}
                onSelect={(event) => event.preventDefault()}
              >
                <span>Auto compile</span>
                <SettingsSwitch checked={autoCompile} size="sm" indicatorOnly />
              </DropdownMenuCheckboxItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </ButtonGroup>
      ) : null),
    [
      toolbarContent,
      isStandalonePdf,
      compilerChoice,
      setCompilerChoice,
      autoCompile,
      setProjectAutoCompile,
      projectRoot,
      isSaving,
      isCompiling,
      isStoppingCompilation,
      handleStopCompilation,
      showCompileStop,
      enterCompileButton,
      leaveCompileButton,
      activateCompileButton,
      effectiveCompileError,
      hasTexProject,
      hasCurrentPdfData,
      hideRecompileLabel,
      handleCompile,
    ],
  );
  const pageCounterLabel = useMemo(
    () => (
      <>
        <span data-pdf-page-current>{currentPage}</span>
        <span>/</span>
        <span>{numPages}</span>
      </>
    ),
    [currentPage, numPages],
  );
  const pageControls = useMemo(
    () =>
      hasCurrentPdfData && (
        <>
          {!hidePageNavigation && (
            <>
              <div
                role="group"
                aria-label="PDF pages"
                className="flex shrink-0 items-center"
              >
                <Hint content="Page Up">
                  <Button
                    variant="ghost"
                    size="icon"
                    className={documentStepButtonClassName}
                    onClick={() => goToPage(currentPage - 1)}
                    disabled={currentPage <= 1}
                    aria-label="Page Up"
                  >
                    <ChevronUpIcon className="size-3.5" />
                  </Button>
                </Hint>

                <div data-pdf-page-indicator className="relative flex shrink-0">
                  <Hint content="Click to jump to page">
                    <button
                      type="button"
                      className={`${documentCounterClassName} rounded-md text-muted-foreground hover:bg-muted ${isEditingPage ? "invisible" : ""}`}
                      onClick={() => {
                        cancelledPageInputRef.current = false;
                        setIsEditingPage(true);
                        setPageInputValue(String(currentPage));
                      }}
                      aria-label="Click to jump to page"
                    >
                      {pageCounterLabel}
                    </button>
                  </Hint>
                  {isEditingPage && (
                    <input
                      ref={pageInputRef}
                      type="text"
                      inputMode="numeric"
                      aria-label="Page number"
                      className="absolute inset-0 h-7 w-full min-w-0 rounded-md border border-input bg-background px-1 text-center text-foreground text-xs tabular-nums outline-none focus:border-ring"
                      value={pageInputValue}
                      onChange={(e) => setPageInputValue(e.target.value)}
                      onBlur={handlePageInputCommit}
                      onKeyDown={(e) => {
                        if (isComposingKey(e) || e.defaultPrevented) return;
                        if (e.key === "Enter" || e.key === "Escape") {
                          e.preventDefault();
                          e.stopPropagation();
                        }
                        if (e.key === "Enter") handlePageInputCommit();
                        if (e.key === "Escape") {
                          setIsEditingPage(false);
                          setPageInputValue(String(currentPage));
                        }
                      }}
                    />
                  )}
                </div>

                <Hint content="Page Down">
                  <Button
                    variant="ghost"
                    size="icon"
                    className={documentStepButtonClassName}
                    onClick={() => goToPage(currentPage + 1)}
                    disabled={currentPage >= numPages}
                    aria-label="Page Down"
                  >
                    <ChevronDownIcon className="size-3.5" />
                  </Button>
                </Hint>
              </div>
              <div
                data-pdf-page-separator
                aria-hidden="true"
                className="mx-1 h-4 w-px shrink-0 bg-border"
              />
            </>
          )}
          <DocumentZoomControl
            label="PDF zoom"
            minScale={MIN_PDF_SCALE}
            maxScale={MAX_PDF_SCALE}
            fitMode={fitMode}
            onFitModeChange={selectFitMode}
            hideFitWidth={hideFitWidth}
            hideFitHeight={hideFitHeight}
            scale={scale}
            onChange={(value) => {
              setFitMode(null);
              setScale(value);
            }}
            zoomIn={zoomIn}
            zoomOut={zoomOut}
          />
        </>
      ),
    [
      hasCurrentPdfData,
      hidePageNavigation,
      hideFitHeight,
      hideFitWidth,
      currentPage,
      numPages,
      pageCounterLabel,
      goToPage,
      isEditingPage,
      pageInputValue,
      handlePageInputCommit,
      zoomOut,
      zoomIn,
      scale,
      fitMode,
    ],
  );

  // Stable intrinsic widths for each overflow stage; never measure the shrunken layout.
  const toolbarWidthProbes = useMemo(
    () => (
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -z-10 h-0 overflow-hidden opacity-0"
      >
        {[0, 1, 2, 3].map((level) => (
          <div
            key={level}
            ref={(element) => {
              toolbarProbeRefs.current[level] = element;
            }}
            className="flex w-max shrink-0 items-center gap-1"
          >
            {level === 0 && (
              <>
                <div className="flex shrink-0 items-center">
                  <div className={documentStepButtonClassName} />
                  <div className={documentCounterClassName}>
                    {pageCounterLabel}
                  </div>
                  <div className={documentStepButtonClassName} />
                </div>
                <div className="mx-1 h-4 w-px shrink-0" />
              </>
            )}
            {level < 3 && <div className="size-7 shrink-0" />}
            {level < 2 && <div className="size-7 shrink-0" />}
            <div className="h-7 w-[98px] shrink-0" />
          </div>
        ))}
      </div>
    ),
    [pageCounterLabel],
  );

  const overflowContent =
    hasCurrentPdfData && hidePageNavigation ? (
      <>
        <DropdownMenuItem
          aria-label={`Page ${currentPage} / ${numPages}`}
          onSelect={(event) => {
            event.preventDefault();
            cancelledPageInputRef.current = false;
            setPageInputValue(String(currentPage));
            setIsEditingPage(true);
          }}
        >
          <FileTextIcon className="size-3.5" />
          Page
          <span
            data-pdf-menu-page-count
            className="relative ml-auto inline-flex h-5 min-w-12 shrink-0 items-center justify-end text-muted-foreground text-xs tabular-nums"
          >
            <span
              className={cn(
                documentCounterClassName,
                "h-full px-1",
                isEditingPage && "invisible",
              )}
            >
              {pageCounterLabel}
            </span>
            {isEditingPage && (
              <input
                ref={pageInputRef}
                aria-label="Page number"
                inputMode="numeric"
                className="absolute inset-0 h-full w-full min-w-0 rounded border border-input bg-background px-1 text-right text-foreground text-xs tabular-nums outline-none focus:border-ring"
                value={pageInputValue}
                onChange={(event) => setPageInputValue(event.target.value)}
                onBlur={handlePageInputCommit}
                onPointerMove={(event) => event.stopPropagation()}
                onClick={(event) => event.stopPropagation()}
                onKeyDown={(event) => {
                  event.stopPropagation();
                  if (isComposingKey(event)) return;
                  if (event.key === "Enter") {
                    event.preventDefault();
                    handlePageInputCommit();
                    const item =
                      event.currentTarget.closest<HTMLElement>(
                        '[role="menuitem"]',
                      );
                    // Let the input unmount before restoring focus, so blur cannot
                    // commit a cancelled edit from this render's value.
                    requestAnimationFrame(() => item?.focus());
                  }
                  if (event.key === "Escape") {
                    event.preventDefault();
                    setIsEditingPage(false);
                    setPageInputValue(String(currentPage));
                    const item =
                      event.currentTarget.closest<HTMLElement>(
                        '[role="menuitem"]',
                      );
                    // Let the input unmount before restoring focus, so blur cannot
                    // commit a cancelled edit from this render's value.
                    requestAnimationFrame(() => item?.focus());
                  }
                }}
              />
            )}
          </span>
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={currentPage <= 1}
          onSelect={(event) => {
            event.preventDefault();
            goToPage(currentPage - 1);
          }}
        >
          <ChevronUpIcon className="size-3.5" />
          Previous page
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={currentPage >= numPages}
          onSelect={(event) => {
            event.preventDefault();
            goToPage(currentPage + 1);
          }}
        >
          <ChevronDownIcon className="size-3.5" />
          Next page
        </DropdownMenuItem>
        {(hideFitHeight || hideFitWidth || hideExport) && (
          <DropdownMenuSeparator />
        )}
        {hideFitHeight && (
          <DropdownMenuItem onSelect={() => selectFitMode("fit-height")}>
            <MoveVerticalIcon className="size-3.5" />
            Fit height
          </DropdownMenuItem>
        )}
        {hideFitWidth && (
          <DropdownMenuItem onSelect={() => selectFitMode("fit-width")}>
            <MoveHorizontalIcon className="size-3.5" />
            Fit width
          </DropdownMenuItem>
        )}
        {hideExport && (
          <DropdownMenuItem onSelect={exportAction.run}>
            <DownloadIcon className="size-3.5" />
            {exportAction.label}
          </DropdownMenuItem>
        )}
      </>
    ) : undefined;

  return (
    <div
      ref={previewContainerRef}
      data-preview-pane
      className="@container/pv pdf-panel-surface relative flex h-full flex-col"
    >
      <WorkspacePanelHeader
        actionsLabel="PDF"
        findAction={editorVisible ? undefined : activeSearch?.show}
        findOpen={searchOpen}
        findInOverflow={findInOverflow}
        overflowContent={overflowContent}
        onActionsEscapeKeyDown={(event) => {
          if (!isEditingPage) return;
          // Radix handles Escape at document capture, before the input handler.
          event.preventDefault();
          cancelledPageInputRef.current = true;
          const item =
            pageInputRef.current?.closest<HTMLElement>('[role="menuitem"]');
          setIsEditingPage(false);
          setPageInputValue(String(currentPage));
          requestAnimationFrame(() => item?.focus());
        }}
        onActionsOpenChange={(open) => {
          if (!open && isEditingPage) handlePageInputCommit();
          setActionsOpen(open);
        }}
        trailingContent={
          <div
            ref={toolbarRightControlsRef}
            className="flex shrink-0 items-center"
          >
            <div className="flex items-center gap-1">{pageControls}</div>
            <ProblemsMotion kind="button" open={showPdfCommentSummary}>
              <div
                data-pdf-comments-summary
                className="flex shrink-0 items-center"
              >
                <div
                  aria-hidden="true"
                  className="mx-2 h-4 w-px shrink-0 bg-border"
                />
                <CommentsSummaryButton
                  comments={activeFileComments}
                  onOpen={() => {
                    if (searchOpen) activeSearch?.close();
                    setEditorInfoBar(panelsProjectKey, "comments");
                  }}
                />
              </div>
            </ProblemsMotion>
          </div>
        }
        hasTrailingContent={hasCurrentPdfData || showPdfCommentSummary}
        ref={toolbarRowRef}
        data-pdf-toolbar
        className={
          toolbarContent
            ? "h-auto min-h-12 flex-wrap gap-x-2 gap-y-1 py-1.5"
            : undefined
        }
      >
        <div
          ref={toolbarLeftControlsRef}
          className={
            toolbarContent
              ? "flex min-w-[180px] flex-1 items-center gap-1"
              : "flex items-center gap-1"
          }
        >
          {compilerControls}
          {exportAction.visible && !hideExport && (
            <Hint content={exportAction.label}>
              <Button
                variant="ghost"
                size="icon"
                className="size-7 shrink-0"
                onClick={exportAction.run}
                aria-label={exportAction.label}
              >
                <DownloadIcon className="size-3.5" />
              </Button>
            </Hint>
          )}
        </div>
        {!toolbarContent && (
          <div data-window-drag-region className="flex-1 self-stretch" />
        )}
      </WorkspacePanelHeader>
      <ProblemsMotion
        kind="bar"
        open={showPdfCommentControls && commentsPanelOpen}
      >
        <CommentsPanel
          comments={activeFileComments}
          filter={commentFilter}
          onFilter={(filter) => saveCommentFilter(panelsProjectKey, filter)}
          onClose={() => setEditorInfoBar(panelsProjectKey, null)}
          onNavigate={(comment) => void navigateCommentInPdf(comment.id)}
        />
      </ProblemsMotion>
      {toolbarWidthProbes}
      {renderContent()}
      {/* PDF selection toolbar */}
      {!isolatedSnapshot && pdfSelection && (
        <SelectionToolbar
          position={pdfSelection.position}
          getAnchor={getPdfToolbarAnchor}
          contextLabel={pdfContextLabel}
          selectionContext={pdfSelectionContext}
          actions={pdfToolbarActions}
          onAction={addCommentAction.run}
          onDismiss={handlePdfToolbarDismiss}
        />
      )}
    </div>
  );
}
