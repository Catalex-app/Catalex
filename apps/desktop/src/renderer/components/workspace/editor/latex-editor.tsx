import { spellCheckExtension } from "@/lib/spelling/extension";
import {
  normalizeDocumentText,
  normalizeReviewText,
  encodeDocumentText,
} from "@/lib/document-text";
import {
  createThreeWayMergeExtension,
  chooseThreeWayVersion,
  getThreeWayRegions,
  getThreeWaySelections,
  type ThreeWayRegion,
} from "./three-way-merge-extension";
import type { AgentMergeSegment } from "@/lib/agent-workspace";
import { compileWorkspace } from "@/lib/workspace-compile";
import {
  COMMENT_PATHS_CHANGED_EVENT,
  remapCommentPath,
  type CommentPathChange,
} from "./comment-paths";
import { COMMENTS_RESTORED_EVENT } from "./inline-comment-storage";
import { toast } from "sonner";
import {
  computeGitLineChanges,
  type GitLineChange,
  type GitLineChangeKind,
} from "./git-line-changes";
import { EditorMinimap, editorMinimapUpdateListener } from "./editor-minimap";
import { canCloseSearchOnEscape } from "@/lib/search-escape";
import {
  cancelReviewViewport,
  captureReviewViewport,
  mapReviewViewport,
  restoreReviewViewport,
  type ReviewViewport,
} from "./review-viewport";
import {
  countMarkdownCharacters,
  countMarkdownWords,
  useDocumentStatistics,
} from "./use-document-statistics";
import {
  breakCommentTypingGroup,
  clearCommentDraftHistory,
  type CommentHistoryScope,
} from "./comment-draft-history";
import { getActiveComment } from "./active-comment";
import { attachCommentToChat } from "@/lib/comment-chat-context";
import {
  commentChangeTransaction,
  commentHistoryEffect,
  canApplyCommentHistory,
  commentHistory,
  recordCommentChange,
} from "./comment-history";
import { WorkspacePanel } from "../workspace-panel";
import { SELECTION_OWNER_EVENT } from "@/lib/workspace-events";
import { PDF_COMMENT_NAVIGATE_EVENT } from "@/lib/workspace-events";
import {
  cancelNavigationScroll,
  isNavigationScrolling,
} from "@/lib/navigation-scroll";
import { scrollToEditorPosition } from "./editor-navigation";
import {
  diagnosticChatMode,
  type DiagnosticChatIssue,
} from "./diagnostic-chat";
import { diagnosticGutter } from "./diagnostic-gutter";
import { diagnosticTooltipPosition } from "./diagnostic-tooltip-position";
import { ProblemsMotion } from "./problems-motion";
import {
  CommentsPanel,
  CommentsSummaryButton,
  type CommentFilter,
} from "./comments-panel";
import { useFileCompileDiagnostics } from "@/hooks/use-file-compile-diagnostics";
import { FilePreview } from "./file-preview";
import {
  type ConflictFile,
  type ConflictOverview,
  advanceAfterGitConflictResolution,
  isTextEditorConflict,
} from "@/lib/git-conflicts";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
  useMemo,
  useLayoutEffect,
} from "react";
import { createPortal } from "react-dom";
import { invoke } from "@/lib/desktop/core";
import {
  Annotation,
  Compartment,
  EditorState,
  EditorSelection,
  Prec,
  RangeSetBuilder,
  Transaction,
  type Extension,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  GutterMarker,
  type ViewUpdate,
  ViewPlugin,
  gutter,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  scrollPastEnd,
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentMore,
  indentLess,
  insertNewline,
  toggleComment,
  undo,
  redo,
} from "@codemirror/commands";
import { useTheme } from "next-themes";
import {
  search,
  SearchQuery,
  getSearchQuery,
  setSearchQuery as setSearchQueryEffect,
  replaceNext,
  replaceAll,
} from "@codemirror/search";
import { unifiedMergeView, getChunks, getOriginalDoc } from "@codemirror/merge";
import { latexLinter } from "codemirror-lang-latex";
import { forEachDiagnostic, type Diagnostic } from "@codemirror/lint";
import { useDocumentStore, type ProjectFile } from "@/stores/document-store";
import {
  useProposedChangesStore,
  settleFileReview,
  type ProposedChange,
} from "@/stores/proposed-changes-store";
import { useAgentChatStore } from "@/stores/agent-chat-store";
import { useHistoryStore, type FileDiff } from "@/stores/history-store";
import { type CompileDiagnostic } from "@/lib/latex-compiler";
import { cn } from "@/lib/utils";
import { useSettingsStore } from "@/stores/settings-store";
import { EditorToolbar } from "./editor-toolbar";
import {
  MarkdownEditorHeader,
  type MarkdownBlockFormat,
  type MarkdownInlineFormat,
} from "./markdown-editor-header";
import {
  LatexEditorHeader,
  type LatexBlockFormat,
  type LatexInlineFormat,
} from "./latex-editor-header";
import { SelectionToolbar, type ToolbarAction } from "./selection-toolbar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  SpellCheckIcon,
  MousePointerClickIcon,
  MessageSquareTextIcon,
  RotateCcwIcon,
  TagIcon,
  CopyIcon,
  XIcon,
} from "lucide-react";
import { ProposedChangesPanel } from "@/components/agent-chat/proposed-changes-panel";
import { GitConflictPanel } from "./git-conflict-panel";
import { ImagePreview } from "./image-preview";
import { SearchPanel } from "./search-panel";
import {
  ProblemsPanel,
  ProblemsSummaryButton,
  type DiagnosticItem,
} from "./problems-panel";
import {
  type CompilerMarkerSnapshot,
  restoreCompilerMarkers,
  compileDiagnosticExtension,
  compileDiagnosticField,
  locateCompileDiagnostics,
  replaceCompileDiagnostics,
} from "./compile-diagnostics";
import { documentLinter } from "./document-linter";
import { PdfPreview } from "@/components/workspace/preview/pdf-preview";
import { openPdfSource, type PdfSource } from "@/lib/mupdf/pdf-source";
import { createLogger } from "@/lib/debug/logger";
import { isMarkdownFile } from "@/lib/markdown";
import { isIncludedLatexFile } from "@/lib/latex-project";
import {
  createEditorColorSchemeExtensions,
  createEditorFontSizeTheme,
  createEditorLanguageExtension,
  createEditorSurfaceExtensions,
  type EditorResolvedTheme,
} from "./editor-appearance";
import { MERGE_PREVIEW_REFRESH_EVENT } from "@/lib/workspace-events";
import {
  captureEditorHistory,
  createDocumentChangeSet,
  createReviewedEditState,
  retainEditorHistory,
  reviewDecisionHistory,
  type EditorHistorySnapshot,
} from "./editor-history";
import {
  createInlineCommentExtension,
  readCommentDocument,
  updateInlineCommentsEffect,
  isInlineCommentRangeAllowed,
  commentsAfterEditorUpdate,
  normalizeInlineCommentRange,
  type InlineEditorComment,
} from "./inline-comments";
import {
  applyCommentPatch,
  type InlineCommentsByFile,
} from "./inline-comment-storage";
import { useProjectComments } from "./use-project-comments";

const log = createLogger("merge-view");
const GIT_STATS_REFRESH_EVENT = "catalex:git-stats-refresh";
const diskRefresh = Annotation.define<boolean>();
const gitConflictMergeClass = EditorView.editorAttributes.of({
  class: "cm-gitConflictMerge",
});

interface GitHeadFileContent {
  repo_found: boolean;
  head_content: string | null;
  ignored: boolean;
}

interface GitConflictFileContent {
  conflicted: boolean;
  version?: string | null;
  conflict_contents?: AgentMergeSegment[];
  ancestor_content?: string | null;
  current_content: string | null;
  incoming_content: string | null;
}

interface GitCommandResult {
  success: boolean;
  message: string;
}

function getReviewRanges(
  state: EditorState,
): Array<{ fromB: number; toB: number }> {
  const regions = getThreeWayRegions(state);
  const chunks = getChunks(state)?.chunks ?? [];
  return [
    ...regions,
    ...chunks.filter(
      (chunk) =>
        !regions.some(
          (region) =>
            (region.fromB < chunk.toB && region.toB > chunk.fromB) ||
            (region.fromB === region.toB && region.fromB === chunk.fromB),
        ),
    ),
  ].sort((a, b) => a.fromB - b.fromB);
}

interface EditorMergeChange extends ProposedChange {
  conflictVersion?: string;
  ancestorContent?: string | null;
  source: "proposal" | "git-conflict" | "external";
}

interface GitConflictResolutionAction {
  change: EditorMergeChange;
  beforeState: EditorState;
  historySnapshot: EditorHistorySnapshot;
  resultingContent: string;
  finalizedContent?: string;
}

function renderGitConflictControl(
  type: "reject" | "accept",
  action: (event: MouseEvent) => void,
) {
  const button = document.createElement("button");
  button.type = "button";
  button.name = type;
  button.textContent = type === "accept" ? "Use Incoming" : "Keep Current";
  button.setAttribute(
    "aria-label",
    type === "accept"
      ? "Use incoming for this conflict"
      : "Keep current for this conflict",
  );
  button.onmousedown = action;
  return button;
}

interface SearchRange {
  from: number;
  to: number;
}

interface EditorSearchState {
  findText: string;
  replaceText: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  useRegex: boolean;
  showReplace: boolean;
  preserveCase: boolean;
  findInSelection: boolean;
}

type HistoryField = "find" | "replace";
type HistoryDirection = "up" | "down";

const SEARCH_HISTORY_LIMIT = 20;
const SEARCH_SELECTION_SEED_WINDOW_MS = 1000;
const SEARCH_SELECTION_SEED_MAX_CHARS = 200;
const SEARCH_FOCUS_VIEWPORT_RATIO = 0.38;
const SEARCH_PANEL_ANIMATION_MS = 180;
const SEARCH_PANEL_ANIMATION_EASE = "cubic-bezier(0.4, 0, 0.2, 1)";

const gitGutterMarkerClasses: Record<GitLineChangeKind, string> = {
  add: "cm-gitLineAdd",
  delete: "cm-gitLineDelete",
  modify: "cm-gitLineModify",
};

class GitLineChangeMarker extends GutterMarker {
  elementClass: string;

  constructor(readonly kind: GitLineChangeKind) {
    super();
    this.elementClass = gitGutterMarkerClasses[kind];
  }
}

const gitLineChangeMarkers = {
  add: new GitLineChangeMarker("add"),
  delete: new GitLineChangeMarker("delete"),
  modify: new GitLineChangeMarker("modify"),
};

function createGitLineChangeGutter(changes: GitLineChange[]) {
  const changeMap = new Map<number, GitLineChangeKind>();
  for (const change of changes) {
    changeMap.set(change.line, change.kind);
  }

  return gutter({
    class: "cm-gitChangeGutter",
    lineMarkerChange: (update) =>
      getChunks(update.startState)?.chunks !== getChunks(update.state)?.chunks,
    lineMarker(view, line) {
      // Pending review changes own this visual lane until accepted/rejected.
      const review = getChunks(view.state);
      if (
        review?.chunks.some(
          (chunk) => line.from >= chunk.fromB && line.from < chunk.toB,
        )
      )
        return null;
      const kind = changeMap.get(view.state.doc.lineAt(line.from).number);
      return kind ? gitLineChangeMarkers[kind] : null;
    },
    initialSpacer() {
      return gitLineChangeMarkers.modify;
    },
  });
}

function buildSearchQuery(
  state: EditorSearchState,
  selectionScope: SearchRange | null,
): SearchQuery {
  const scope =
    state.findInSelection && selectionScope
      ? {
          from: Math.min(selectionScope.from, selectionScope.to),
          to: Math.max(selectionScope.from, selectionScope.to),
        }
      : null;

  return new SearchQuery({
    search: state.findText,
    replace: state.replaceText,
    caseSensitive: state.caseSensitive,
    wholeWord: state.wholeWord,
    regexp: state.useRegex,
    literal: !state.useRegex,
    test: scope
      ? (_match, _state, from, to) => from >= scope.from && to <= scope.to
      : undefined,
  });
}

function countSearchMatches(
  editorState: EditorState,
  query: SearchQuery,
): number {
  let count = 0;
  const cursor = query.getCursor(editorState);
  for (let step = cursor.next(); !step.done; step = cursor.next()) {
    count += 1;
  }
  return count;
}

function getCurrentMatchIndex(
  editorState: EditorState,
  query: SearchQuery,
  selection: { from: number; to: number },
): number {
  let index = 0;
  const cursor = query.getCursor(editorState);
  for (let step = cursor.next(); !step.done; step = cursor.next()) {
    const match = step.value;
    index += 1;
    if (match.from === selection.from && match.to === selection.to)
      return index;
  }
  return 0;
}

function getNextMatch(
  editorState: EditorState,
  query: SearchQuery,
  startPos: number,
): { from: number; to: number } | null {
  const cursor = query.getCursor(editorState, startPos);
  const step = cursor.next();
  if (!step.done) return step.value;
  if (startPos > 0) {
    const wrappedCursor = query.getCursor(editorState, 0, startPos);
    const wrappedStep = wrappedCursor.next();
    if (!wrappedStep.done) return wrappedStep.value;
  }
  return null;
}

function getPreviousMatch(
  editorState: EditorState,
  query: SearchQuery,
  startPos: number,
): { from: number; to: number } | null {
  const cursor = query.getCursor(editorState);
  let previous: { from: number; to: number } | null = null;
  for (let step = cursor.next(); !step.done; step = cursor.next()) {
    const match = step.value;
    if (match.to <= startPos) {
      previous = match;
      continue;
    }
    break;
  }
  if (previous) return previous;

  const wrapCursor = query.getCursor(editorState);
  let last: { from: number; to: number } | null = null;
  for (let step = wrapCursor.next(); !step.done; step = wrapCursor.next()) {
    last = step.value;
  }
  return last;
}

function scrollSearchFocusIntoView(view: EditorView, pos: number): void {
  const scroll = view.scrollDOM;
  const maxScrollTop = Math.max(0, scroll.scrollHeight - scroll.clientHeight);

  const apply = () => {
    const block = view.lineBlockAt(pos);
    const desiredTop =
      block.top -
      scroll.clientHeight * SEARCH_FOCUS_VIEWPORT_RATIO +
      block.height / 2;
    const nextScrollTop = Math.max(0, Math.min(maxScrollTop, desiredTop));
    scroll.scrollTop = nextScrollTop;
  };

  requestAnimationFrame(() => {
    apply();
    requestAnimationFrame(apply);
  });
}

function centerInlineCommentCard(view: EditorView, commentId: string): boolean {
  const card = Array.from(
    view.dom.querySelectorAll<HTMLElement>(".cm-inlineCommentCard"),
  ).find((candidate) => candidate.dataset.inlineCommentId === commentId);
  if (!card) return false;

  const scroll = view.scrollDOM;
  const scrollRect = scroll.getBoundingClientRect();
  const cardRect = card.getBoundingClientRect();
  const maxScrollTop = Math.max(0, scroll.scrollHeight - scroll.clientHeight);
  const delta =
    cardRect.top +
    cardRect.height / 2 -
    (scrollRect.top + scrollRect.height / 2);
  scroll.scrollTop = Math.max(
    0,
    Math.min(maxScrollTop, scroll.scrollTop + delta),
  );
  return true;
}

// Keep one style module; viewport-dependent values belong to each editor.
const searchViewportTheme = EditorView.theme({
  ".cm-content": {
    paddingTop: "var(--catalex-search-padding-top)",
    paddingBottom: "var(--catalex-search-padding-bottom)",
  },
});

function getSearchViewportPadding(view: EditorView): {
  top: number;
  bottom: number;
} {
  return {
    top: Math.min(view.scrollDOM.clientHeight * 0.18, 140),
    bottom: Math.min(view.scrollDOM.clientHeight * 0.22, 180),
  };
}

function selectSearchMatch(
  view: EditorView,
  match: { from: number; to: number },
) {
  view.dispatch({
    selection: { anchor: match.from, head: match.to },
  });
  scrollSearchFocusIntoView(view, match.from);
}

function pushHistoryEntry(entries: string[], nextValue: string): string[] {
  const trimmed = nextValue.trim();
  if (!trimmed) return entries;
  const deduped = [trimmed, ...entries.filter((entry) => entry !== trimmed)];
  return deduped.slice(0, SEARCH_HISTORY_LIMIT);
}

function normalizeSearchSeed(value: string): string {
  if (!value) return "";
  if (value.trim().length === 0) return "";
  if (value.length > SEARCH_SELECTION_SEED_MAX_CHARS) return "";
  return value;
}

function applyPreserveCase(matchText: string, replaceText: string): string {
  if (!replaceText) return replaceText;
  if (matchText.toUpperCase() === matchText && /[A-Z]/i.test(matchText)) {
    return replaceText.toUpperCase();
  }
  if (matchText.toLowerCase() === matchText && /[A-Z]/i.test(matchText)) {
    return replaceText.toLowerCase();
  }
  if (/^[A-Z][a-z0-9]+$/.test(matchText)) {
    return (
      replaceText.charAt(0).toUpperCase() + replaceText.slice(1).toLowerCase()
    );
  }
  return replaceText;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const selectionExactHighlight = Decoration.mark({ class: "cm-selectionMatch" });
const selectionActiveHighlight = Decoration.mark({
  class: "cm-selectionMatchActive",
});
const selectionVariantHighlight = Decoration.mark({
  class: "cm-selectionMatchVariant",
});
const selectionChipPreviewHighlight = Decoration.mark({
  class: "cm-selectionChipPreview",
});

function createSelectionChipPreviewHighlight(
  range: { start: number; end: number } | null,
  docLength: number,
): Extension {
  if (!range) return [];
  const from = Math.max(0, Math.min(range.start, docLength));
  const to = Math.max(from, Math.min(range.end, docLength));
  if (from === to) return [];
  const builder = new RangeSetBuilder<Decoration>();
  builder.add(from, to, selectionChipPreviewHighlight);
  return EditorView.decorations.of(builder.finish());
}

function buildSelectionHighlights(
  state: EditorState,
  includeActiveSelection: boolean,
  useSearchQuery: boolean,
): DecorationSet {
  if (useSearchQuery) {
    const query = getSearchQuery(state);
    if (!query.search || !query.valid) {
      return Decoration.none;
    }

    const selection = state.selection.main;
    const builder = new RangeSetBuilder<Decoration>();
    const cursor = query.getCursor(state);

    for (let step = cursor.next(); !step.done; step = cursor.next()) {
      const match = step.value;
      const isActiveSelection =
        match.from === selection.from && match.to === selection.to;
      if (!includeActiveSelection && isActiveSelection) {
        continue;
      }
      builder.add(
        match.from,
        match.to,
        isActiveSelection ? selectionActiveHighlight : selectionExactHighlight,
      );
    }

    return builder.finish();
  }

  const selection = state.selection.main;
  if (selection.empty || state.selection.ranges.length !== 1) {
    return Decoration.none;
  }

  const selectedText = state.sliceDoc(selection.from, selection.to);
  if (!selectedText || selectedText.length > 200) {
    return Decoration.none;
  }
  if (!/[\p{L}\p{N}]/u.test(selectedText)) {
    return Decoration.none;
  }

  const pattern = new RegExp(escapeRegExp(selectedText), "gi");
  const docText = state.doc.toString();
  const builder = new RangeSetBuilder<Decoration>();
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(docText))) {
    const from = match.index;
    const to = from + match[0].length;
    const isActiveSelection = from === selection.from && to === selection.to;
    if (!includeActiveSelection && isActiveSelection) {
      continue;
    }
    const isExactCase = match[0] === selectedText;
    const decoration = isActiveSelection
      ? selectionActiveHighlight
      : isExactCase
        ? selectionExactHighlight
        : selectionVariantHighlight;
    builder.add(from, to, decoration);

    // Guard against zero-length regex loops.
    if (match[0].length === 0) {
      pattern.lastIndex += 1;
    }
  }

  return builder.finish();
}

function createSelectionCaseAwareHighlights(
  includeActiveSelection: boolean,
  useSearchQuery: boolean,
): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = buildSelectionHighlights(
          view.state,
          includeActiveSelection,
          useSearchQuery,
        );
      }

      update(update: ViewUpdate) {
        if (
          update.docChanged ||
          update.selectionSet ||
          update.transactions.length
        ) {
          this.decorations = buildSelectionHighlights(
            update.state,
            includeActiveSelection,
            useSearchQuery,
          );
        }
      }
    },
    {
      decorations: (value) => value.decorations,
    },
  );
}

function isInScrollbarGutter(event: MouseEvent, view: EditorView): boolean {
  const scroll = view.scrollDOM;
  const rect = scroll.getBoundingClientRect();
  if (
    event.clientX < rect.left ||
    event.clientX > rect.right ||
    event.clientY < rect.top ||
    event.clientY > rect.bottom
  ) {
    return false;
  }

  const gutterWidth = 24;
  const hasVertical = scroll.scrollHeight > scroll.clientHeight + 1;
  const hasHorizontal = scroll.scrollWidth > scroll.clientWidth + 1;
  const inVertical = hasVertical && event.clientX >= rect.right - gutterWidth;
  const inHorizontal =
    hasHorizontal && event.clientY >= rect.bottom - gutterWidth;
  return inVertical || inHorizontal;
}

function destroyInternalMouseSelection(view: EditorView): void {
  const inputState = (
    view as EditorView & {
      inputState?: {
        mouseSelection?: { destroy?: () => void } | null;
        draggedContent?: unknown;
      };
    }
  ).inputState;
  const mouseSelection = inputState?.mouseSelection;
  if (mouseSelection?.destroy) {
    mouseSelection.destroy();
  }
  if (inputState) {
    inputState.mouseSelection = null;
    inputState.draggedContent = null;
  }
}

function createSelectionReactivationGuard(): Extension {
  return ViewPlugin.fromClass(
    class {
      private onMouseDown = (event: MouseEvent) => {
        const target = event.target;
        if (
          this.view.hasFocus ||
          !this.view.state.selection.ranges.some((range) => !range.empty) ||
          event.button !== 0 ||
          event.shiftKey ||
          event.altKey ||
          event.metaKey ||
          event.ctrlKey ||
          !(target instanceof Element) ||
          target.closest(
            '.cm-inlineCommentCard, button, input, textarea, select, a, [contenteditable="false"]',
          ) ||
          isInScrollbarGutter(event, this.view)
        ) {
          return;
        }

        // Consume the return click before CodeMirror starts a new selection.
        event.preventDefault();
        event.stopPropagation();
        this.view.focus();
      };

      constructor(readonly view: EditorView) {
        view.scrollDOM.addEventListener("mousedown", this.onMouseDown, true);
      }

      destroy() {
        this.view.scrollDOM.removeEventListener(
          "mousedown",
          this.onMouseDown,
          true,
        );
      }
    },
  );
}

function createScrollbarSelectionGuard(): Extension {
  return ViewPlugin.fromClass(
    class {
      private pointerDownInScrollbar = false;
      private sawPointerMove = false;

      private clearPointerState = () => {
        this.pointerDownInScrollbar = false;
        this.sawPointerMove = false;
      };

      private onMouseDown = (event: MouseEvent) => {
        if (
          event.button !== 0 ||
          event.shiftKey ||
          event.altKey ||
          event.metaKey ||
          event.ctrlKey
        ) {
          this.clearPointerState();
          return;
        }
        this.pointerDownInScrollbar = isInScrollbarGutter(event, this.view);
        this.sawPointerMove = false;
      };

      private onMouseMove = (event: MouseEvent) => {
        if (!this.pointerDownInScrollbar || (event.buttons & 1) === 0) return;
        this.sawPointerMove = true;
      };

      private onScroll = () => {
        if (!this.pointerDownInScrollbar || this.sawPointerMove) return;
        destroyInternalMouseSelection(this.view);
        this.view.dom.ownerDocument.defaultView
          ?.getSelection()
          ?.removeAllRanges();
      };

      constructor(readonly view: EditorView) {
        view.scrollDOM.addEventListener("mousedown", this.onMouseDown, true);
        view.scrollDOM.addEventListener("scroll", this.onScroll, true);
        view.scrollDOM.ownerDocument.addEventListener(
          "mousemove",
          this.onMouseMove,
          true,
        );
        view.scrollDOM.ownerDocument.addEventListener(
          "mouseup",
          this.clearPointerState,
          true,
        );
      }

      destroy() {
        this.view.scrollDOM.removeEventListener(
          "mousedown",
          this.onMouseDown,
          true,
        );
        this.view.scrollDOM.removeEventListener("scroll", this.onScroll, true);
        this.view.scrollDOM.ownerDocument.removeEventListener(
          "mousemove",
          this.onMouseMove,
          true,
        );
        this.view.scrollDOM.ownerDocument.removeEventListener(
          "mouseup",
          this.clearPointerState,
          true,
        );
      }
    },
  );
}

function getActiveFileContent(): string {
  const state = useDocumentStore.getState();
  const activeFile = state.files.find((f) => f.id === state.activeFileId);
  return activeFile?.content ?? "";
}

const editorInteractionTheme = EditorView.theme({
  ".cm-searchMatch": {
    backgroundColor: "#facc15 !important",
    color: "#000 !important",
    borderRadius: "2px",
    boxShadow: "0 0 0 1px #eab308",
  },
  ".cm-searchMatch-selected": {
    backgroundColor: "#f97316 !important",
    color: "#fff !important",
    borderRadius: "2px",
    boxShadow: "0 0 0 2px #ea580c",
  },
  ".cm-selectionMatch": {
    backgroundColor: "rgba(250, 204, 21, 0.55)",
    borderRadius: "2px",
    boxShadow: "0 0 0 1px rgba(234, 179, 8, 0.9)",
  },
  ".cm-selectionMatchActive": {
    backgroundColor: "transparent",
    borderRadius: "2px",
    boxShadow: "0 0 0 1px rgba(234, 179, 8, 0.9)",
  },
  ".cm-selectionMatchVariant": {
    backgroundColor: "rgba(250, 204, 21, 0.28)",
    borderRadius: "2px",
    boxShadow: "0 0 0 1px rgba(234, 179, 8, 0.45)",
  },
  ".cm-selectionChipPreview": {
    backgroundColor: "rgba(59, 130, 246, 0.18)",
    borderRadius: "2px",
    boxShadow:
      "0 0 0 1px rgba(59, 130, 246, 0.7), inset 0 -1px 0 rgba(59, 130, 246, 0.45)",
  },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground": {
    backgroundColor: "rgba(118, 186, 247, 0.44) !important",
  },
  "&:not(.cm-focused) > .cm-scroller > .cm-selectionLayer .cm-selectionBackground":
    {
      backgroundColor: "rgba(225, 227, 231, 0.55) !important",
    },
  ".cm-activeLine, .cm-activeLineGutter": {
    backgroundColor: "transparent !important",
  },
  ".cm-content ::selection": {
    backgroundColor: "transparent !important",
  },
  ".cm-content ::-moz-selection": {
    backgroundColor: "transparent !important",
  },
  // Original-text widgets use native selection, unlike the editable document's
  // CodeMirror selection layer. Do not hide their browser selection highlight.
  ".cm-deletedLine::selection, .cm-deletedLine ::selection": {
    backgroundColor: "rgba(118, 186, 247, 0.44) !important",
  },
  ".cm-deletedLine::-moz-selection, .cm-deletedLine ::-moz-selection": {
    backgroundColor: "rgba(118, 186, 247, 0.44) !important",
  },
  ".cm-changedLine": {
    backgroundColor: "rgba(34, 197, 94, 0.08) !important",
  },
  ".cm-deletedChunk": {
    backgroundColor: "rgba(239, 68, 68, 0.12) !important",
    paddingLeft: "6px",
    position: "relative",
  },
  ".cm-insertedLine": {
    backgroundColor: "rgba(34, 197, 94, 0.15) !important",
  },
  ".cm-deletedLine": {
    userSelect: "text",
    WebkitUserSelect: "text",
    backgroundColor: "rgba(239, 68, 68, 0.15) !important",
  },
  ".cm-changedText": {
    backgroundColor: "rgba(34, 197, 94, 0.25) !important",
  },
  ".cm-chunkButtons, .cm-deletedChunk .cm-chunkButtons": {
    position: "absolute",
    insetInlineEnd: "0",
    top: "2px",
    display: "flex",
    alignItems: "center",
    gap: "8px",
    transform: "translateY(calc(-100% - 4px))",
    zIndex: "10",
  },
  ".cm-chunkButtons button": {
    border: "none",
    cursor: "pointer",
    color: "white",
    margin: "0",
    borderRadius: "3px",
    padding: "2px 8px",
    fontSize: "12px",
    lineHeight: "1.4",
  },
  ".cm-chunkButtons button[name=accept]": {
    backgroundColor: "#36ad5e",
  },
  ".cm-chunkButtons button[name=reject]": {
    backgroundColor: "#ef4444",
    order: "-1",
  },
  "&.cm-gitConflictMerge .cm-changedLine": {
    backgroundColor: "rgba(139, 92, 246, 0.08) !important",
  },
  "&.cm-gitConflictMerge .cm-deletedChunk": {
    backgroundColor: "rgba(59, 130, 246, 0.10) !important",
  },
  "&.cm-gitConflictMerge .cm-insertedLine": {
    backgroundColor: "rgba(139, 92, 246, 0.15) !important",
  },
  "&.cm-gitConflictMerge .cm-deletedLine:not(.cm-threeWayAncestorLine)": {
    backgroundColor: "rgba(59, 130, 246, 0.15) !important",
  },
  "&.cm-gitConflictMerge .cm-changedText": {
    backgroundColor: "rgba(139, 92, 246, 0.25) !important",
  },
  "&.cm-gitConflictMerge .cm-deletedText": {
    backgroundColor: "rgba(59, 130, 246, 0.25) !important",
  },
  "&.cm-gitConflictMerge .cm-deletedLineGutter": {
    backgroundColor: "#2563eb !important",
  },
  "&.cm-gitConflictMerge .cm-changedLineGutter": {
    backgroundColor: "#7c3aed !important",
  },
  "&.cm-gitConflictMerge .cm-chunkButtons button[name=accept]": {
    backgroundColor: "#7c3aed",
  },
  "&.cm-gitConflictMerge .cm-chunkButtons button[name=reject]": {
    backgroundColor: "#2563eb",
    order: "-1",
  },
  ".cm-changeGutter": {
    paddingLeft: "0",
    width: "4px",
    minWidth: "4px",
    marginRight: "2px",
  },
  // Merge's widget markers and Git's line markers share one visual lane.
  ".cm-gitChangeGutter ~ .cm-changeGutter": {
    marginLeft: "-6px",
  },
  ".cm-changedLineGutter": { backgroundColor: "#22c55e" },
  ".cm-deletedLineGutter": { backgroundColor: "#ef4444" },
  ".cm-gitChangeGutter": {
    width: "4px",
    minWidth: "4px",
    marginRight: "2px",
  },
  ".cm-gitLineAdd": {
    backgroundColor: "#22c55e !important",
  },
  ".cm-gitLineDelete": {
    backgroundColor: "#ef4444 !important",
  },
  ".cm-gitLineModify": {
    backgroundColor: "#3b82f6 !important",
  },
  ".cm-tooltip.cm-tooltip-lint, .cm-tooltip:has(.cm-tooltip-lint)": {
    width: "min(420px, calc(100vw - 24px))",
    maxWidth: "420px",
    border: "1px solid var(--popup-surface-border, var(--border))",
    borderRadius: "var(--radius)",
    backgroundColor: "var(--popup-surface-background, var(--popover))",
    backdropFilter: "var(--popup-surface-filter, none)",
    color: "var(--popover-foreground)",
    fontFamily: "var(--font-sans, system-ui, sans-serif)",
    fontSize: "13px",
    lineHeight: "1.5",
    boxShadow:
      "var(--popup-surface-shadow, 0 4px 16px rgb(0 0 0 / 0.12), 0 1px 3px rgb(0 0 0 / 0.08))",
    overflow: "hidden",
  },
  ".cm-tooltip-below.cm-tooltip-lint, .cm-tooltip-below:has(.cm-tooltip-lint)":
    {
      marginTop: "6px",
    },
  ".cm-tooltip-above.cm-tooltip-lint, .cm-tooltip-above:has(.cm-tooltip-lint)":
    {
      marginTop: "-6px",
    },
  ".cm-tooltip.cm-tooltip-lint.cm-tooltip-below, .cm-tooltip.cm-tooltip-lint.cm-tooltip-above":
    {
      marginTop: "0",
    },
  ".cm-tooltip-lint": {
    maxHeight: "min(320px, calc(100vh - 32px))",
    overflowY: "auto",
    overflowX: "hidden",
  },
  ".cm-tooltip-lint .cm-diagnostic": {
    padding: "10px 12px",
    marginLeft: "0",
    borderLeftWidth: "3px",
    overflowWrap: "anywhere",
  },
  ".cm-tooltip-lint .cm-diagnostic + .cm-diagnostic": {
    position: "relative",
    paddingTop: "11px",
  },
  // Keep both dividers inside the colored stripe, with identical geometry.
  ".cm-tooltip-lint .cm-diagnostic + .cm-diagnostic::before, .cm-tooltip-lint .cm-diagnosticChatFooter::before":
    {
      content: '""',
      position: "absolute",
      top: "0",
      left: "0",
      right: "0",
      borderTop: "1px solid var(--border)",
      pointerEvents: "none",
    },
  ".cm-tooltip-lint .cm-diagnostic-error": {
    borderLeftColor: "var(--color-red-600)",
  },
  ".cm-tooltip-lint .cm-diagnostic-warning": {
    borderLeftColor: "var(--color-amber-500)",
  },
  ".cm-tooltip-lint .cm-diagnosticSource": {
    marginTop: "6px",
    fontSize: "11px",
    lineHeight: "1.4",
    color: "var(--muted-foreground)",
    opacity: "1",
  },
  ".cm-diagnosticAction": {
    display: "inline-block",
    padding: "4px 12px",
    borderRadius: "6px",
    fontSize: "12px",
    fontWeight: "500",
    cursor: "pointer",
    backgroundColor: "var(--muted, rgba(255,255,255,0.08))",
    color: "var(--foreground, #e5e5e5)",
    border: "1px solid var(--border, rgba(255,255,255,0.1))",
    marginTop: "8px",
    transition: "background-color 0.15s, border-color 0.15s",
  },
  ".cm-diagnosticAction:hover": {
    backgroundColor: "var(--accent, rgba(255,255,255,0.15))",
    borderColor: "var(--foreground, rgba(255,255,255,0.3))",
  },
});

interface CachedEditorState {
  document?: string;
  history?: Extension;
  review?: {
    change: EditorMergeChange;
    original: string;
    baseline: EditorHistorySnapshot;
    threeWayRegions?: readonly ThreeWayRegion[];
    threeWaySelections?: Readonly<
      Record<number, "ancestor" | "current" | "agent">
    >;
  };
  compilerDiagnostics?: CompilerMarkerSnapshot;
  cursor: number;
  reviewViewport?: ReviewViewport;
  scrollTop: number;
  topLineFrom: number;
  topLineOffset: number;
}

/** Session-only editor state, isolated by project, draft workspace, and file. */
const editorStateCache = new Map<string, CachedEditorState>();

window.addEventListener(COMMENT_PATHS_CHANGED_EVENT, (event) => {
  const { projectRoot, changes } = (
    event as CustomEvent<{ projectRoot: string; changes: CommentPathChange[] }>
  ).detail;
  for (const [key, cached] of [...editorStateCache]) {
    const [root, workspace, file] = JSON.parse(key) as [
      string,
      string | null,
      string,
    ];
    if (root !== projectRoot || workspace) continue;
    const target = remapCommentPath(file, changes);
    if (target !== file) {
      editorStateCache.delete(key);
      editorStateCache.set(JSON.stringify([root, workspace, target]), cached);
    }
  }
});

function captureEditorState(view: EditorView): CachedEditorState {
  const scrollTop = view.scrollDOM.scrollTop;
  const topBlock = view.lineBlockAtHeight(scrollTop);
  return {
    cursor: view.state.selection.main.head,
    scrollTop,
    topLineFrom: topBlock.from,
    topLineOffset: scrollTop - topBlock.top,
  };
}

function restoreEditorScroll(
  view: EditorView,
  cached: CachedEditorState,
): void {
  if (cached.reviewViewport) {
    restoreReviewViewport(view, cached.reviewViewport);
    return;
  }
  // Anchor restoration to the top visible line to avoid drift across remount/layout timing.
  const anchorPos = Math.min(cached.topLineFrom, view.state.doc.length);
  const block = view.lineBlockAt(anchorPos);
  const target = Math.max(0, block.top + cached.topLineOffset);
  view.scrollDOM.scrollTop = Number.isFinite(target)
    ? target
    : cached.scrollTop;
}

/** Clear editor state cache (e.g., on project close). */
export function clearEditorStateCache(): void {
  editorStateCache.clear();
  clearCommentDraftHistory();
}

interface LatexEditorProps {
  fileConflict?: ConflictFile | null;
  currentConflictContent?: ReactNode;
  agentFileReviewContent?: ReactNode;
  useGlobalToolbar?: boolean;
  globalToolbarTarget?: HTMLElement | null;
  reviewToolbarTarget?: HTMLElement | null;
  assistantMode?: "duet" | "artisan";
  chatLayout?: "drawer" | "workspace";
  selectionAiEnabled?: boolean;
  suppressToolbar?: boolean;
  debugInlineCommentsByFile?: InlineCommentsByFile;
  scrollSyncEnabled?: boolean;
  scrollSyncPaused?: boolean;
  outlineTrackingEnabled?: boolean;
  scrollSyncTarget?: { id: number; position: number } | null;
  onScrollPositionChange?: (position: number) => void;
}

function sendDiagnosticToChat(view: EditorView, issues: DiagnosticChatIssue[]) {
  const state = useDocumentStore.getState();
  const file = state.files.find((file) => file.id === state.activeFileId);
  const fileName = file?.relativePath ?? "main.tex";
  if (issues.length === 1) {
    const { diagnostic, from } = issues[0];
    const line = view.state.doc.lineAt(from).number;
    const context = `[Problem in ${fileName}:${line}]\n[Problem: ${diagnostic.message}]`;
    useAgentChatStore.getState().sendPrompt(`${context}\n\nFix this problem.`);
    return;
  }
  const problems = issues
    .map(
      ({ diagnostic, from }) =>
        `- ${fileName}:${view.state.doc.lineAt(from).number} — ${diagnostic.message}`,
    )
    .join("\n");
  useAgentChatStore
    .getState()
    .sendPrompt(
      `[Problems in ${fileName}]\n${problems}\n\nFix these problems.`,
    );
}

export function LatexEditor({
  fileConflict = null,
  currentConflictContent,
  agentFileReviewContent,
  useGlobalToolbar = false,
  globalToolbarTarget = null,
  reviewToolbarTarget = null,
  assistantMode = "duet",
  chatLayout = "drawer",
  selectionAiEnabled = assistantMode === "duet",
  suppressToolbar = false,
  debugInlineCommentsByFile,
  scrollSyncEnabled = false,
  scrollSyncPaused = false,
  outlineTrackingEnabled = true,
  scrollSyncTarget = null,
  onScrollPositionChange,
}: LatexEditorProps = {}) {
  const renderReviewToolbar = (bar: ReactNode) =>
    reviewToolbarTarget ? createPortal(bar, reviewToolbarTarget) : bar;
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [editorMountNonce, setEditorMountNonce] = useState(0);
  const [editorReadyRevision, setEditorReadyRevision] = useState(0);
  const repairQueuedRef = useRef(false);
  const outlineTrackingEnabledRef = useRef(outlineTrackingEnabled);
  outlineTrackingEnabledRef.current = outlineTrackingEnabled;
  const scrollSyncEnabledRef = useRef(scrollSyncEnabled);
  const onScrollPositionChangeRef = useRef(onScrollPositionChange);
  const scrollSyncFrameRef = useRef<number | null>(null);
  const ignoreScrollSyncUntilRef = useRef(0);
  const lastScrollSyncPositionRef = useRef<number | null>(null);

  scrollSyncEnabledRef.current = scrollSyncEnabled && !scrollSyncPaused;
  onScrollPositionChangeRef.current = onScrollPositionChange;

  const files = useDocumentStore((s) => s.files);
  const activeFileId = useDocumentStore((s) => s.activeFileId);
  const projectRoot = useDocumentStore((s) => s.projectRoot);
  const agentWorkspaceRoot = useDocumentStore((s) => s.agentWorkspaceRoot);
  // These annotations belong to the source, not a potentially different draft.
  const commentProjectRoot = agentWorkspaceRoot ? null : projectRoot;
  const isEditorReadOnly = useDocumentStore(
    (s) =>
      s.isApplyingAgentDraft ||
      s.isAgentWorkspaceReadOnly ||
      s.isGitOperationRunning,
  );
  const setContent = useDocumentStore((s) => s.setContent);
  const setCursorPosition = useDocumentStore((s) => s.setCursorPosition);
  const setSelectionRange = useDocumentStore((s) => s.setSelectionRange);
  const selectionPreviewRange = useDocumentStore(
    (s) => s.selectionPreviewRange,
  );
  const jumpToPosition = useDocumentStore((s) => s.jumpToPosition);
  const jumpToSelectionRange = useDocumentStore((s) => s.jumpToSelectionRange);
  const clearJumpRequest = useDocumentStore((s) => s.clearJumpRequest);

  const activeFile = files.find((f) => f.id === activeFileId);
  const showSidecarUi = assistantMode === "duet" && chatLayout === "drawer";
  const selectedCommentIdsJson = useAgentChatStore((state) =>
    JSON.stringify(
      state.tabs
        .find((tab) => tab.id === state.activeTabId)
        ?.draft.pinnedContexts.filter(
          (context) =>
            context.comment && context.filePath === activeFile?.relativePath,
        )
        .map((context) => context.comment!.id) ?? [],
    ),
  );
  const selectedCommentIds = useMemo<string[]>(
    () => JSON.parse(selectedCommentIdsJson),
    [selectedCommentIdsJson],
  );
  const requestDrawerCollapse = useAgentChatStore(
    (s) => s.requestDrawerCollapse,
  );
  const isTextFile =
    !activeFile?.isBinary &&
    (activeFile?.type === "tex" ||
      activeFile?.type === "csv" ||
      activeFile?.type === "bib" ||
      activeFile?.type === "style" ||
      activeFile?.type === "other");
  const isMarkdownDocument = isTextFile && isMarkdownFile(activeFile);
  const isLatexDocument = isTextFile && activeFile?.type === "tex";
  const activeFileContent = activeFile?.content;
  const isLargeFileNotLoaded =
    isTextFile && activeFileContent === undefined && !!activeFile;
  const loadFileContent = useDocumentStore((s) => s.loadFileContent);

  // History review state
  const reviewingSnapshot = useHistoryStore((s) => s.reviewingSnapshot);
  const historyDiffResult = useHistoryStore((s) => s.diffResult);

  const [imageScale, setImageScale] = useState(1.0);
  const [cropMode, setCropMode] = useState(false);
  const [gitHeadRefreshNonce, setGitHeadRefreshNonce] = useState(0);
  const [editorSelectedText, setEditorSelectedText] = useState("");

  // Reset scale and crop mode when switching files
  useEffect(() => {
    setImageScale(1.0);
    setCropMode(false);
    setEditorSelectedText("");
    setSelectionRangeForSearch(null);
    setSearchScopeRange(null);
    setSearchState((prev) =>
      prev.findInSelection ? { ...prev, findInSelection: false } : prev,
    );
  }, [activeFileId]);

  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [isSearchPanelRendered, setIsSearchPanelRendered] = useState(false);
  const [isSearchPanelVisible, setIsSearchPanelVisible] = useState(false);
  const [searchState, setSearchState] = useState<EditorSearchState>({
    findText: "",
    replaceText: "",
    caseSensitive: false,
    wholeWord: false,
    useRegex: false,
    showReplace: false,
    preserveCase: false,
    findInSelection: false,
  });
  const [selectionRangeForSearch, setSelectionRangeForSearch] =
    useState<SearchRange | null>(null);
  const [searchScopeRange, setSearchScopeRange] = useState<SearchRange | null>(
    null,
  );
  const [findHistory, setFindHistory] = useState<string[]>([]);
  const [replaceHistory, setReplaceHistory] = useState<string[]>([]);
  const [findHistoryIndex, setFindHistoryIndex] = useState(-1);
  const [replaceHistoryIndex, setReplaceHistoryIndex] = useState(-1);
  const findHistoryDraftRef = useRef("");
  const replaceHistoryDraftRef = useRef("");
  const [matchCount, setMatchCount] = useState(0);
  const [currentMatch, setCurrentMatch] = useState(0);
  const [mergeChunkInfo, setMergeChunkInfo] = useState({
    total: 0,
    current: 0,
  });
  const panelsProjectKey = JSON.stringify(projectRoot);
  const problemsPanelPreference = useSettingsStore(
    (s) => s.editorProblemsPanelOpenByProject[panelsProjectKey],
  );
  const saveProblemsPanelOpen = useSettingsStore(
    (s) => s.setEditorProblemsPanelOpen,
  );
  const setProblemsPanelOpen = (open: boolean) =>
    saveProblemsPanelOpen(panelsProjectKey, open);
  const displayComments = useSettingsStore((s) => s.displayComments);
  const commentsPanelOpen = useSettingsStore(
    (s) =>
      s.displayComments &&
      (s.editorCommentsPanelOpenByProject[panelsProjectKey] ?? false),
  );
  const saveCommentsPanelOpen = useSettingsStore(
    (s) => s.setEditorCommentsPanelOpen,
  );
  const setCommentsPanelOpen = (open: boolean) =>
    saveCommentsPanelOpen(panelsProjectKey, open);
  const commentFilter = useSettingsStore(
    (s) => s.editorCommentFilterByProject[panelsProjectKey] ?? "all",
  );
  const saveCommentFilter = useSettingsStore((s) => s.setEditorCommentFilter);
  const setCommentFilter = (filter: CommentFilter) =>
    saveCommentFilter(panelsProjectKey, filter);
  const [commentNavigationSelection, setCommentNavigationSelection] = useState<{
    fileId: string;
    id: string;
  }>();
  const [minimapProblemSelection, setMinimapProblemSelection] = useState<{
    fileId: string;
    diagnostics: DiagnosticItem[];
  }>();
  const [diagnostics, setDiagnostics] = useState<DiagnosticItem[]>([]);
  const [gitHeadContent, setGitHeadContent] = useState<
    string | null | undefined
  >(undefined);
  const [activeGitConflict, setActiveGitConflict] =
    useState<EditorMergeChange | null>(null);
  const [activeGitDeletionConflict, setActiveGitDeletionConflict] =
    useState<ConflictFile | null>(null);
  const activeGitFileConflict =
    fileConflict?.document_path === activeFile?.relativePath
      ? fileConflict
      : null;
  // Proposed changes for active file
  const proposedChanges = useProposedChangesStore((s) => s.changes);
  const workspaceSettlementError = useProposedChangesStore(
    (s) => s.workspaceReview?.settlementError ?? null,
  );
  const activeFileChange = useMemo(() => {
    if (!activeFile) return null;
    return (
      proposedChanges.find(
        (c) =>
          c.filePath === activeFile.relativePath &&
          (!c.workspaceSessionId ||
            c.workspaceSessionId ===
              useDocumentStore.getState().agentWorkspaceSessionId),
      ) ?? null
    );
  }, [proposedChanges, activeFile]);

  const isReviewDisplay = Boolean(
    activeFileChange ||
      activeGitFileConflict ||
      (activeGitConflict &&
        activeGitConflict.filePath === activeFile?.relativePath) ||
      (activeGitDeletionConflict &&
        activeGitDeletionConflict.document_path === activeFile?.relativePath),
  );
  const suppressSyntaxDiagnostics = isReviewDisplay;
  const compileDiagnostics = useFileCompileDiagnostics(activeFileId);
  const [unlocatedCompileDiagnostics, setUnlocatedCompileDiagnostics] =
    useState<CompileDiagnostic[]>([]);
  const problemDiagnostics = useMemo<DiagnosticItem[]>(
    () => [
      ...(suppressSyntaxDiagnostics ? [] : diagnostics),
      ...(suppressSyntaxDiagnostics ? [] : unlocatedCompileDiagnostics).map(
        (diagnostic) => ({
          ...diagnostic,
          from: null,
          to: null,
          line: null,
          source: "compile" as const,
        }),
      ),
    ],
    [diagnostics, unlocatedCompileDiagnostics, suppressSyntaxDiagnostics],
  );
  const suppressSyntaxDiagnosticsRef = useRef(suppressSyntaxDiagnostics);
  const hasProblemErrors = problemDiagnostics.some(
    (diagnostic) => diagnostic.severity === "error",
  );
  const problemsPanelOpen =
    !commentsPanelOpen && (problemsPanelPreference ?? hasProblemErrors);

  suppressSyntaxDiagnosticsRef.current = suppressSyntaxDiagnostics;
  const lintCompartmentRef = useRef(new Compartment());
  const diagnosticChatCompartmentRef = useRef(new Compartment());
  const lintExtensionsRef = useRef<Extension>([]);
  const [gitConflictError, setGitConflictError] = useState<string | null>(null);
  const [isResolvingGitConflict, setIsResolvingGitConflict] = useState(false);
  const [
    inlineCommentsByFile,
    setInlineCommentsByFile,
    replayComment,
    inlineCommentsLoaded,
    canReplayComment,
  ] = useProjectComments(projectRoot, (patch) => {
    const view = viewRef.current;
    if (
      view &&
      !agentWorkspaceRoot &&
      !isMergeActiveRef.current &&
      activeFile?.relativePath === patch.filePath
    ) {
      recordCommentChange(view, patch);
      return;
    }
    // Comments belong to the source even while a draft or another file is open.
    const documents = useDocumentStore.getState();
    const sourceFile = (
      documents.sourceViewSnapshot?.files ?? documents.files
    ).find((file) => file.relativePath === patch.filePath);
    if (!sourceFile || sourceFile.content == null) return;
    const key = JSON.stringify([projectRoot, null, sourceFile.id]);
    const cached = editorStateCache.get(key);
    const pending =
      pendingChangeRef.current?.filePath === patch.filePath
        ? pendingHistoryRef.current
        : null;
    const baseline = pending ?? cached?.review?.baseline;
    const document = baseline?.document ?? sourceFile.content;
    const retained =
      baseline?.retained ??
      (cached?.document === document ? cached.history : undefined);
    const state = EditorState.create({
      doc: document,
      extensions: [retained ?? history(), commentHistory(() => {})],
    });
    const next = commentChangeTransaction(state, patch).state;
    if (baseline) {
      const comments = applyCommentPatch(
        { [patch.filePath]: baseline.comments ?? [] },
        patch,
      )[patch.filePath];
      Object.assign(baseline, captureEditorHistory(next, document, comments));
    } else {
      editorStateCache.set(key, {
        cursor: 0,
        scrollTop: 0,
        topLineFrom: 0,
        topLineOffset: 0,
        ...cached,
        document,
        history: retainEditorHistory(next),
      });
    }
  });
  const replayCommentRef = useRef(replayComment);
  replayCommentRef.current = replayComment;
  const canReplayCommentRef = useRef(canReplayComment);
  canReplayCommentRef.current = canReplayComment;
  const [selectionCoords, setSelectionCoords] = useState<{
    top: number;
    left: number;
  } | null>(null);
  // When the selection toolbar is visible, prevent CM selection changes from clearing it.
  // Only explicit dismiss/send/action should clear the toolbar.
  const toolbarStickyRef = useRef(false);
  const parentRef = useRef<HTMLDivElement>(null);

  const { resolvedTheme } = useTheme();
  const editorColorScheme = useSettingsStore((s) => s.editorColorScheme);
  const editorFontSize = useSettingsStore((s) => s.editorFontSize);
  const showEditorMinimap = useSettingsStore((s) => s.showEditorMinimap);
  const effectiveEditorTheme: EditorResolvedTheme =
    resolvedTheme === "dark" ? "dark" : "light";

  const compileRef = useRef<() => void>(() => {});
  const isSearchOpenRef = useRef(false);
  const themeCompartmentRef = useRef(new Compartment());
  const fontSizeCompartmentRef = useRef(new Compartment());
  const historyCompartmentRef = useRef(new Compartment());
  useEffect(() => {
    const restored = (event: Event) => {
      if (
        (event as CustomEvent<{ projectRoot: string }>).detail.projectRoot !==
        projectRoot
      )
        return;
      clearEditorStateCache();
      const view = viewRef.current;
      if (view) {
        view.dispatch({
          effects: historyCompartmentRef.current.reconfigure([]),
        });
        view.dispatch({
          effects: historyCompartmentRef.current.reconfigure(history()),
        });
        gitConflictResolutionUndoStackRef.current = [];
      }
    };
    window.addEventListener(COMMENTS_RESTORED_EVENT, restored);
    return () => window.removeEventListener(COMMENTS_RESTORED_EVENT, restored);
  }, [projectRoot]);

  const readOnlyCompartmentRef = useRef(new Compartment());
  const mergeCompartmentRef = useRef(new Compartment());
  const gitGutterCompartmentRef = useRef(new Compartment());
  const inlineCommentsCompartmentRef = useRef(new Compartment());
  const pendingInlineCommentCenterIdRef = useRef<string | null>(null);
  const commentSelectionRef = useRef<{
    commentId: string;
    view: EditorView;
    selection: EditorSelection;
  } | null>(null);
  const selectionHighlightsCompartmentRef = useRef(new Compartment());
  const selectionChipPreviewCompartmentRef = useRef(new Compartment());
  const searchPaddingCompartmentRef = useRef(new Compartment());
  const isMergeActiveRef = useRef(false);
  const pendingChangeRef = useRef<EditorMergeChange | null>(null);
  const pendingHistoryRef = useRef<EditorHistorySnapshot | null>(null);
  const reviewViewportRef = useRef<ReviewViewport | null>(null);
  const editorCacheKey = JSON.stringify([
    projectRoot,
    agentWorkspaceRoot,
    activeFileId,
  ]);
  const isConflictResolutionPendingRef = useRef(false);
  const failedGitConflictResolutionRef = useRef<EditorMergeChange | null>(null);
  const gitConflictResolutionUndoStackRef = useRef<
    GitConflictResolutionAction[]
  >([]);
  const resolveGitConflictRef = useRef<
    (
      view: EditorView,
      change: EditorMergeChange,
      historySnapshot: EditorHistorySnapshot,
      finalContent: string,
    ) => void
  >(() => {});
  const undoLastGitConflictResolutionRef = useRef<
    (view: EditorView) => boolean
  >(() => false);
  const mergeAutoCenterTokenRef = useRef(0);
  const handleKeepAllRef = useRef<() => void>(() => {});
  const handleUndoAllRef = useRef<() => void>(() => {});
  const diagnosticsRef = useRef<DiagnosticItem[]>([]);
  const searchStateRef = useRef(searchState);
  const lastNonEmptySelectionTextRef = useRef("");
  const lastNonEmptySelectionAtRef = useRef(0);
  const searchPaddingRef = useRef({ top: 0, bottom: 0 });
  const activeFileRelativePathRef = useRef<string | null>(null);

  activeFileRelativePathRef.current = activeFile?.relativePath ?? null;

  const clearSelectionUiState = useCallback(() => {
    toolbarStickyRef.current = false;
    setSelectionCoords(null);
    setSelectionRange(null);
    setSelectionRangeForSearch(null);
    setSearchScopeRange(null);
    setSearchState((prev) =>
      prev.findInSelection ? { ...prev, findInSelection: false } : prev,
    );
  }, [setSelectionRange]);

  useEffect(() => {
    isSearchOpenRef.current = isSearchOpen;
  }, [isSearchOpen]);

  const activeFileDocumentComments = useMemo(() => {
    if (!activeFile) return [];
    if (agentWorkspaceRoot && !debugInlineCommentsByFile) return [];
    const commentsByFile = debugInlineCommentsByFile ?? inlineCommentsByFile;
    return commentsByFile[activeFile.relativePath] ?? [];
  }, [
    activeFile?.relativePath,
    debugInlineCommentsByFile,
    inlineCommentsByFile,
    agentWorkspaceRoot,
  ]);
  const allActiveFileInlineComments = useMemo(
    () =>
      displayComments
        ? activeFileDocumentComments.filter((c) => !c.resolved)
        : [],
    [activeFileDocumentComments, displayComments],
  );

  useEffect(() => {
    let animationFrame = 0;
    let hideTimer: ReturnType<typeof setTimeout> | null = null;

    if (isSearchOpen) {
      setIsSearchPanelRendered(true);
      animationFrame = requestAnimationFrame(() => {
        setIsSearchPanelVisible(true);
      });
    } else if (isSearchPanelRendered) {
      setIsSearchPanelVisible(false);
      hideTimer = setTimeout(() => {
        setIsSearchPanelRendered(false);
      }, SEARCH_PANEL_ANIMATION_MS);
    }

    return () => {
      if (animationFrame) cancelAnimationFrame(animationFrame);
      if (hideTimer) clearTimeout(hideTimer);
    };
  }, [isSearchOpen, isSearchPanelRendered]);

  useEffect(() => {
    searchStateRef.current = searchState;
  }, [searchState]);

  const searchQueryObject = useMemo(
    () => buildSearchQuery(searchState, searchScopeRange),
    [searchState, searchScopeRange],
  );

  const pushFindHistory = useCallback((value: string) => {
    setFindHistory((prev) => pushHistoryEntry(prev, value));
  }, []);

  const pushReplaceHistory = useCallback((value: string) => {
    setReplaceHistory((prev) => pushHistoryEntry(prev, value));
  }, []);

  const updateSearchMetrics = useCallback(
    (view: EditorView | null, query: SearchQuery = searchQueryObject) => {
      if (!view || !query.search || !query.valid) {
        setMatchCount(0);
        setCurrentMatch(0);
        return;
      }
      const totalMatches = countSearchMatches(view.state, query);
      setMatchCount(totalMatches);
      if (totalMatches === 0) {
        setCurrentMatch(0);
        return;
      }
      const selected = view.state.selection.main;
      const index = getCurrentMatchIndex(view.state, query, {
        from: selected.from,
        to: selected.to,
      });
      setCurrentMatch(index > 0 ? index : 1);
    },
    [searchQueryObject],
  );

  const openSearch = useCallback(
    (showReplace = false, seedFindText?: string) => {
      if (isSearchOpenRef.current) {
        if (showReplace) {
          setSearchState((previous) => ({ ...previous, showReplace: true }));
        }
        const input = parentRef.current?.querySelector<HTMLInputElement>(
          '[data-testid="editor-search-panel"] input[aria-label="Search"]',
        );
        input?.focus();
        input?.select();
        return;
      }
      const view = viewRef.current;
      const liveSelectionText =
        view && !view.state.selection.main.empty
          ? view.state.sliceDoc(
              view.state.selection.main.from,
              view.state.selection.main.to,
            )
          : "";
      const domSelectionText =
        view?.dom.ownerDocument.defaultView?.getSelection?.()?.toString() ?? "";
      const recentSelectionText =
        Date.now() - lastNonEmptySelectionAtRef.current <=
        SEARCH_SELECTION_SEED_WINDOW_MS
          ? lastNonEmptySelectionTextRef.current
          : "";
      const selectedText = normalizeSearchSeed(
        seedFindText ||
          liveSelectionText ||
          domSelectionText ||
          recentSelectionText,
      );
      if (showSidecarUi) {
        requestDrawerCollapse();
      }
      setIsSearchOpen(true);
      setSearchState((prev) => {
        const nextShowReplace = showReplace || prev.showReplace;
        if (
          nextShowReplace === prev.showReplace &&
          (!selectedText || selectedText === prev.findText)
        ) {
          return prev;
        }
        return {
          ...prev,
          showReplace: nextShowReplace,
          findText: selectedText || prev.findText,
        };
      });
      if (selectedText) {
        setFindHistoryIndex(-1);
        findHistoryDraftRef.current = "";
      }
    },
    [requestDrawerCollapse, showSidecarUi],
  );

  const closeSearch = useCallback(() => {
    pushFindHistory(searchStateRef.current.findText);
    pushReplaceHistory(searchStateRef.current.replaceText);
    setIsSearchOpen(false);
    setSearchScopeRange(null);
    setSearchState((prev) => ({
      ...prev,
      findText: "",
      findInSelection: false,
    }));
    setFindHistoryIndex(-1);
    setReplaceHistoryIndex(-1);
    findHistoryDraftRef.current = "";
    replaceHistoryDraftRef.current = "";
    setMatchCount(0);
    setCurrentMatch(0);
    viewRef.current?.focus();
  }, [pushFindHistory, pushReplaceHistory]);

  const navigateHistory = useCallback(
    (field: HistoryField, direction: HistoryDirection) => {
      const history = field === "find" ? findHistory : replaceHistory;
      if (history.length === 0) return;

      const index = field === "find" ? findHistoryIndex : replaceHistoryIndex;
      const currentValue =
        field === "find" ? searchState.findText : searchState.replaceText;

      if (direction === "up") {
        const nextIndex =
          index < 0 ? 0 : Math.min(index + 1, history.length - 1);
        if (index < 0) {
          if (field === "find") {
            findHistoryDraftRef.current = currentValue;
          } else {
            replaceHistoryDraftRef.current = currentValue;
          }
        }
        const nextValue = history[nextIndex] ?? currentValue;
        if (field === "find") {
          setFindHistoryIndex(nextIndex);
          setSearchState((prev) => ({ ...prev, findText: nextValue }));
        } else {
          setReplaceHistoryIndex(nextIndex);
          setSearchState((prev) => ({ ...prev, replaceText: nextValue }));
        }
        return;
      }

      if (index < 0) return;
      if (index === 0) {
        const draft =
          field === "find"
            ? findHistoryDraftRef.current
            : replaceHistoryDraftRef.current;
        if (field === "find") {
          setFindHistoryIndex(-1);
          setSearchState((prev) => ({ ...prev, findText: draft }));
        } else {
          setReplaceHistoryIndex(-1);
          setSearchState((prev) => ({ ...prev, replaceText: draft }));
        }
        return;
      }

      const nextIndex = index - 1;
      const nextValue = history[nextIndex] ?? currentValue;
      if (field === "find") {
        setFindHistoryIndex(nextIndex);
        setSearchState((prev) => ({ ...prev, findText: nextValue }));
      } else {
        setReplaceHistoryIndex(nextIndex);
        setSearchState((prev) => ({ ...prev, replaceText: nextValue }));
      }
    },
    [
      findHistory,
      replaceHistory,
      findHistoryIndex,
      replaceHistoryIndex,
      searchState.findText,
      searchState.replaceText,
    ],
  );

  const activeMergeChange = useMemo<EditorMergeChange | null>(() => {
    const prepare = (raw: EditorMergeChange): EditorMergeChange => {
      const change = normalizeReviewText(raw);
      return change.conflictContents && !change.resolvedConflict
        ? {
            ...change,
            newContent: change.conflictContents
              .map((segment) =>
                segment.kind === "resolved" ? segment.content : segment.agent,
              )
              .join(""),
          }
        : change;
    };
    if (activeGitConflict) return prepare(activeGitConflict);
    if (
      !activeFileChange &&
      activeFile?.externalChange &&
      activeFile.externalChange.disk !== null
    ) {
      return {
        id: activeFile.externalChange.id,
        filePath: activeFile.relativePath,
        absolutePath: activeFile.absolutePath,
        oldContent: activeFile.content ?? "",
        newContent: normalizeDocumentText(
          activeFile.externalChange.reviewContent ??
            activeFile.externalChange.disk,
        ),
        toolName: "External change",
        timestamp: 0,
        source: "external",
      };
    }
    if (!activeFileChange) return null;
    return prepare({ ...activeFileChange, source: "proposal" });
  }, [activeFileChange, activeGitConflict, activeFile]);

  const settleExternal = async (content: string | null) => {
    if (!activeFile?.externalChange) return;
    setIsResolvingGitConflict(true);
    setGitConflictError(null);
    try {
      await useDocumentStore
        .getState()
        .resolveExternalFile(
          activeFile.id,
          activeFile.externalChange.id,
          content,
        );
    } catch (error) {
      setGitConflictError(String(error));
    } finally {
      setIsResolvingGitConflict(false);
    }
  };

  resolveGitConflictRef.current = (
    view,
    change,
    historySnapshot,
    finalContent,
  ) => {
    if (
      change.source !== "git-conflict" ||
      isConflictResolutionPendingRef.current ||
      !projectRoot
    ) {
      return;
    }

    isConflictResolutionPendingRef.current = true;
    failedGitConflictResolutionRef.current = null;
    setIsResolvingGitConflict(true);
    setGitConflictError(null);
    const navigation = useDocumentStore.getState();
    const diskText = encodeDocumentText(
      finalContent,
      useDocumentStore
        .getState()
        .files.find((file) => file.relativePath === change.filePath)
        ?.diskContent ?? "",
    );
    const resolve = change.conflictVersion
      ? invoke<GitCommandResult>("git_panel_resolve_conflict", {
          projectRoot,
          filePath: change.filePath,
          expectedVersion: change.conflictVersion,
          content: diskText,
        })
      : (async () => {
          useDocumentStore
            .getState()
            .updateFileContent(change.filePath, finalContent);
          await useDocumentStore.getState().saveFile(change.filePath);
          return invoke<GitCommandResult>("git_panel_resolve_conflict", {
            projectRoot,
            filePath: change.filePath,
          });
        })();
    void resolve
      .then(async (result) => {
        if (!result.success) throw new Error(result.message);
        if (change.conflictVersion) {
          useDocumentStore.setState((state) =>
            state.projectRoot === projectRoot && !state.agentWorkspaceRoot
              ? {
                  files: state.files.map((file) =>
                    file.relativePath === change.filePath
                      ? {
                          ...file,
                          content: finalContent,
                          diskContent: diskText,
                          isDirty: false,
                        }
                      : file,
                  ),
                }
              : {},
          );
        }

        const actionStack = gitConflictResolutionUndoStackRef.current;
        const lastAction = actionStack[actionStack.length - 1];
        if (
          lastAction?.change.id === change.id &&
          lastAction.resultingContent === finalContent
        ) {
          lastAction.finalizedContent = finalContent;
        }

        if (
          viewRef.current === view &&
          pendingChangeRef.current?.id === change.id
        ) {
          clearSelectionUiState();
          setMergeChunkInfo({ total: 0, current: 0 });
          view.dispatch({
            effects: mergeCompartmentRef.current.reconfigure([]),
          });
          isMergeActiveRef.current = false;
          view.dispatch({
            effects: historyCompartmentRef.current.reconfigure(
              reviewedHistory(view, historySnapshot, finalContent),
            ),
          });
          pendingChangeRef.current = null;
          pendingHistoryRef.current = null;
          view.focus();
        }

        setActiveGitConflict((current) =>
          current?.filePath === change.filePath ? null : current,
        );
        window.dispatchEvent(new CustomEvent(GIT_STATS_REFRESH_EVENT));
        await advanceAfterGitConflictResolution(navigation, change.filePath);
      })
      .catch((error) => {
        failedGitConflictResolutionRef.current = change;
        setGitConflictError(
          error instanceof Error ? error.message : String(error),
        );
        if (
          viewRef.current === view &&
          activeFileRelativePathRef.current === change.filePath
        )
          view.focus();
      })
      .finally(() => {
        isConflictResolutionPendingRef.current = false;
        setIsResolvingGitConflict(false);
      });
  };

  undoLastGitConflictResolutionRef.current = (view) => {
    if (isMergeActiveRef.current && pendingChangeRef.current?.conflictContents)
      return false;
    const actions = gitConflictResolutionUndoStackRef.current;
    const action = actions[actions.length - 1];
    if (
      !action ||
      activeFileRelativePathRef.current !== action.change.filePath
    ) {
      return false;
    }

    if (isConflictResolutionPendingRef.current) return true;

    const expectedContent = isMergeActiveRef.current
      ? action.resultingContent
      : action.finalizedContent;
    if (
      expectedContent === undefined ||
      view.state.doc.toString() !== expectedContent
    ) {
      return false;
    }

    const restoreAction = () => {
      actions.pop();
      pendingChangeRef.current = action.change;
      pendingHistoryRef.current = action.historySnapshot;
      isMergeActiveRef.current = true;
      view.setState(action.beforeState);
      const chunks = getReviewRanges(view.state);
      setMergeChunkInfo({
        total: chunks.length,
        current: chunks.length > 0 ? 1 : 0,
      });
      if (action.change.conflictVersion) {
        useDocumentStore.setState((state) => ({
          files: state.files.map((file) =>
            file.relativePath === action.change.filePath
              ? { ...file, content: view.state.doc.toString(), isDirty: false }
              : file,
          ),
        }));
      } else {
        useDocumentStore
          .getState()
          .updateFileContent(action.change.filePath, view.state.doc.toString());
      }
      window.dispatchEvent(new CustomEvent(MERGE_PREVIEW_REFRESH_EVENT));
      view.focus();
    };

    if (isMergeActiveRef.current) {
      restoreAction();
      return true;
    }

    if (!projectRoot) return false;

    isConflictResolutionPendingRef.current = true;
    setIsResolvingGitConflict(true);
    setGitConflictError(null);

    void invoke<GitCommandResult>("git_panel_reopen_conflict", {
      projectRoot,
      filePath: action.change.filePath,
    })
      .then((result) => {
        if (!result.success) throw new Error(result.message);
        return invoke<GitConflictFileContent>("git_conflict_file_content", {
          projectRoot,
          filePath: action.change.filePath,
        });
      })
      .then((conflict) => {
        if (
          !conflict.conflicted ||
          conflict.current_content === null ||
          conflict.incoming_content === null
        ) {
          throw new Error("Git did not restore the previous conflict state");
        }

        if (activeFileRelativePathRef.current === action.change.filePath) {
          restoreAction();
          setActiveGitConflict({
            ...action.change,
            ancestorContent: conflict.ancestor_content,
            conflictVersion: conflict.version ?? undefined,
            oldContent: conflict.current_content,
            newContent: action.change.resolvedConflict
              ? action.change.newContent
              : conflict.incoming_content,
            timestamp: Date.now(),
          });
        }
        window.dispatchEvent(new CustomEvent(GIT_STATS_REFRESH_EVENT));
      })
      .catch((error) => {
        gitConflictResolutionUndoStackRef.current = [];
        log.error("failed to undo the last Git conflict action", {
          error: String(error),
        });
        if (viewRef.current === view) undo(view);
      })
      .finally(() => {
        isConflictResolutionPendingRef.current = false;
        setIsResolvingGitConflict(false);
        if (viewRef.current === view) view.focus();
      });

    return true;
  };

  const resolveGitDeletionConflict = async (
    choice: "ancestor" | "current" | "incoming",
  ) => {
    const conflict = activeGitDeletionConflict;
    if (!conflict || !projectRoot || isConflictResolutionPendingRef.current)
      return;
    const navigation = useDocumentStore.getState();
    isConflictResolutionPendingRef.current = true;
    setIsResolvingGitConflict(true);
    setGitConflictError(null);
    try {
      await useDocumentStore.getState().runGitOperation(
        projectRoot,
        {
          saveFiles: [],
          discardFiles: conflict.document_path ? [conflict.document_path] : [],
        },
        () =>
          invoke("git_panel_resolve_conflict_side", {
            projectRoot,
            filePath: conflict.path,
            choice,
            expectedVersion: conflict.version,
          }),
      );
      setActiveGitDeletionConflict(null);
      window.dispatchEvent(new CustomEvent(GIT_STATS_REFRESH_EVENT));
      await advanceAfterGitConflictResolution(navigation, conflict.path);
    } catch (error) {
      setGitConflictError(
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      isConflictResolutionPendingRef.current = false;
      setIsResolvingGitConflict(false);
    }
  };

  const retainSettledSourceHistory = (
    view: EditorView,
    change: EditorMergeChange,
  ) => {
    const anchor = reviewViewportRef.current;
    const viewport = anchor
      ? mapReviewViewport(anchor, view.state.doc.toString())
      : undefined;
    if (viewport) restoreReviewViewport(view, viewport);
    if (!change.workspaceSessionId) return;
    const sourceFile = useDocumentStore
      .getState()
      .sourceViewSnapshot?.files.find(
        (file) => file.relativePath === change.filePath,
      );
    if (!sourceFile) return;
    editorStateCache.set(JSON.stringify([projectRoot, null, sourceFile.id]), {
      ...captureEditorState(view),
      ...(viewport
        ? { reviewViewport: viewport, cursor: viewport.cursor }
        : {}),
      document: view.state.doc.toString(),
      history: retainEditorHistory(view.state),
    });
  };

  const renderProposalControl = (
    type: "accept" | "reject",
    action: (event: MouseEvent) => void,
  ) => {
    const button = document.createElement("button");
    button.type = "button";
    button.name = type;
    button.textContent = type === "accept" ? "Accept" : "Reject";
    button.onmousedown = (event) => {
      const view = viewRef.current;
      const widget = button.closest(".cm-deletedChunk");
      if (!view || !widget) return;
      const anchor = captureReviewViewport(view, view.posAtDOM(widget));
      reviewViewportRef.current = anchor;
      action(event);
      const mapped = mapReviewViewport(anchor, view.state.doc.toString());
      reviewViewportRef.current = mapped;
      view.dispatch({ selection: { anchor: mapped.cursor } });
      restoreReviewViewport(view, mapped);
    };
    return button;
  };

  const useGitStartingFile = () => {
    const view = viewRef.current;
    const change = pendingChangeRef.current;
    const historySnapshot = pendingHistoryRef.current;
    if (
      !view ||
      !change ||
      change.source !== "git-conflict" ||
      !historySnapshot ||
      change.ancestorContent == null ||
      isConflictResolutionPendingRef.current
    )
      return;
    const content = change.ancestorContent;
    gitConflictResolutionUndoStackRef.current.push({
      change,
      beforeState: view.state,
      historySnapshot,
      resultingContent: content,
    });
    view.dispatch({
      changes: createDocumentChangeSet(view.state.doc.toString(), content),
      annotations: Transaction.addToHistory.of(false),
    });
    window.dispatchEvent(new CustomEvent(MERGE_PREVIEW_REFRESH_EVENT));
    resolveGitConflictRef.current(view, change, historySnapshot, content);
  };

  const markThreeWayResolution = (
    view: EditorView,
    change: EditorMergeChange,
  ) => {
    if (!change.conflictContents || change.source !== "proposal") return;
    const selections = getThreeWaySelections(view.state);
    const deleteFile =
      view.state.doc.length === 0 &&
      !!change.conflictMissingVersions?.some((version) =>
        change.conflictContents!.every(
          (segment, index) =>
            segment.kind === "resolved" || selections[index] === version,
        ),
      );
    useProposedChangesStore
      .getState()
      .resolveConflict(change.id, view.state.doc.toString(), deleteFile);
  };

  const useStartingRegions = () => {
    const view = viewRef.current;
    if (!view || !pendingChangeRef.current?.conflictContents) return;
    chooseThreeWayVersion(view, "ancestor");
    handleKeepAllRef.current();
  };

  // Install the same final anchor geometry used to construct native undo before
  // a save acknowledgement can arrive. Otherwise immediate undo can start with
  // source ranges still attached to the accepted replacement document.
  function reviewedHistory(
    view: EditorView,
    snapshot: EditorHistorySnapshot,
    finalDocument: string,
  ): Extension {
    const restored = createReviewedEditState(
      view.state,
      snapshot,
      finalDocument,
    );
    if (!agentWorkspaceRoot && activeFile) {
      const filePath = activeFile.relativePath;
      useDocumentStore
        .getState()
        .updateFileContent(activeFile.id, finalDocument);
      const mapped = new Map(
        (readCommentDocument(restored)?.comments ?? []).map((comment) => [
          comment.id,
          comment,
        ]),
      );
      setInlineCommentsByFile((current) => {
        const comments = (current[filePath] ?? []).map((comment) => {
          const anchor = mapped.get(comment.id);
          return anchor
            ? {
                ...comment,
                from: anchor.from,
                to: anchor.to,
                line: anchor.line,
                positionReset: anchor.positionReset,
                removedAnchor: anchor.removedAnchor,
              }
            : comment;
        });
        view.dispatch({
          effects: updateInlineCommentsEffect.of({ comments }),
          annotations: Transaction.addToHistory.of(false),
        });
        return { ...current, [filePath]: comments };
      });
    }
    return retainEditorHistory(restored);
  }

  // Keep all changes (⌘Y)
  handleKeepAllRef.current = () => {
    if (pendingChangeRef.current?.source === "external") {
      void settleExternal(pendingChangeRef.current.newContent);
      return;
    }
    if (activeGitDeletionConflict) {
      void resolveGitDeletionConflict("incoming");
      return;
    }
    const view = viewRef.current;
    const change = pendingChangeRef.current;
    const historySnapshot = pendingHistoryRef.current;
    if (!view || !change || !historySnapshot) return;
    if (change.conflictContents) {
      chooseThreeWayVersion(view, "agent");
      markThreeWayResolution(view, change);
    }
    if (change.source === "git-conflict") {
      const incomingResult =
        change.conflictContents || change.resolvedConflict
          ? view.state.doc.toString()
          : change.newContent;
      gitConflictResolutionUndoStackRef.current.push({
        change,
        beforeState: view.state,
        historySnapshot,
        resultingContent: incomingResult,
      });
      const currentContent = view.state.doc.toString();
      view.dispatch({
        changes: createDocumentChangeSet(currentContent, incomingResult),
        annotations: Transaction.addToHistory.of(false),
      });
      window.dispatchEvent(new CustomEvent(MERGE_PREVIEW_REFRESH_EVENT));
      resolveGitConflictRef.current(
        view,
        change,
        historySnapshot,
        incomingResult,
      );
      return;
    }
    // The displayed result includes manual edits and rejected hunks. Applying
    // the remaining proposal must preserve those explicit review decisions.
    const acceptedContent = view.state.doc.toString();
    reviewViewportRef.current = captureReviewViewport(view);
    clearSelectionUiState();
    setMergeChunkInfo({ total: 0, current: 0 });
    const currentContent = view.state.doc.toString();
    view.dispatch({
      changes: createDocumentChangeSet(currentContent, acceptedContent),
      selection: {
        anchor: mapReviewViewport(reviewViewportRef.current, acceptedContent)
          .cursor,
      },
      effects: mergeCompartmentRef.current.reconfigure([]),
      annotations: Transaction.addToHistory.of(false),
    });
    isMergeActiveRef.current = false;
    view.dispatch({
      effects: historyCompartmentRef.current.reconfigure(
        reviewedHistory(view, historySnapshot, acceptedContent),
      ),
    });
    retainSettledSourceHistory(view, change);
    useDocumentStore
      .getState()
      .updateFileContent(change.filePath, acceptedContent);
    void settleFileReview(change.id, true).catch((error) =>
      toast.error(`Could not accept changes: ${String(error)}`),
    );
    pendingChangeRef.current = null;
    pendingHistoryRef.current = null;
    view.focus();
  };

  // Undo all changes (⌘N)
  handleUndoAllRef.current = () => {
    if (pendingChangeRef.current?.source === "external") {
      void settleExternal(pendingChangeRef.current.oldContent);
      return;
    }
    if (activeGitDeletionConflict) {
      void resolveGitDeletionConflict("current");
      return;
    }
    const view = viewRef.current;
    const change = pendingChangeRef.current;
    const historySnapshot = pendingHistoryRef.current;
    if (!view || !change || !historySnapshot) return;
    if (change.conflictContents) {
      chooseThreeWayVersion(view, "current");
      handleKeepAllRef.current();
      return;
    }
    if (change.source === "git-conflict") {
      gitConflictResolutionUndoStackRef.current.push({
        change,
        beforeState: view.state,
        historySnapshot,
        resultingContent: change.oldContent,
      });
      const currentContent = view.state.doc.toString();
      view.dispatch({
        changes: createDocumentChangeSet(currentContent, change.oldContent),
        annotations: Transaction.addToHistory.of(false),
      });
      window.dispatchEvent(new CustomEvent(MERGE_PREVIEW_REFRESH_EVENT));
      resolveGitConflictRef.current(
        view,
        change,
        historySnapshot,
        change.oldContent,
      );
      return;
    }
    reviewViewportRef.current = captureReviewViewport(view);
    clearSelectionUiState();
    setMergeChunkInfo({ total: 0, current: 0 });
    const currentContent = view.state.doc.toString();
    view.dispatch({
      changes: createDocumentChangeSet(currentContent, change.oldContent),
      selection: {
        anchor: mapReviewViewport(reviewViewportRef.current, change.oldContent)
          .cursor,
      },
      effects: mergeCompartmentRef.current.reconfigure([]),
      annotations: Transaction.addToHistory.of(false),
    });
    isMergeActiveRef.current = false;
    view.dispatch({
      effects: historyCompartmentRef.current.reconfigure(
        reviewedHistory(view, historySnapshot, change.oldContent),
      ),
    });
    retainSettledSourceHistory(view, change);
    useDocumentStore
      .getState()
      .updateFileContent(change.filePath, change.oldContent);
    void settleFileReview(change.id, false).catch((error) =>
      toast.error(`Could not reject changes: ${String(error)}`),
    );
    pendingChangeRef.current = null;
    pendingHistoryRef.current = null;
    view.focus();
  };

  // Navigate to a specific chunk by index
  const goToChunk = (index: number) => {
    const view = viewRef.current;
    if (!view) return;
    const chunks = getReviewRanges(view.state);
    if (index < 0 || index >= chunks.length) return;
    const chunk = chunks[index];
    view.dispatch({
      selection: { anchor: chunk.fromB },
      effects: EditorView.scrollIntoView(chunk.fromB, { y: "center" }),
    });
    view.focus();
  };

  const centerFirstMergeChunkAfterLayout = useCallback((view: EditorView) => {
    const token = ++mergeAutoCenterTokenRef.current;
    let attempts = 0;
    const maxAttempts = 10;

    const schedule = () => {
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(center);
      });
    };

    const center = () => {
      if (mergeAutoCenterTokenRef.current !== token) return;
      if (!isMergeActiveRef.current || viewRef.current !== view) return;
      const focused = document.activeElement;
      if (
        focused instanceof Element &&
        !view.dom.contains(focused) &&
        focused.closest("input, textarea, [contenteditable='true']")
      )
        return;

      const firstChunk = getReviewRanges(view.state)[0];
      if (!firstChunk) {
        attempts += 1;
        if (attempts < maxAttempts) schedule();
        return;
      }

      const anchor = firstChunk.fromB;
      view.dispatch({
        selection: { anchor },
        effects: EditorView.scrollIntoView(anchor, {
          y: "center",
        }),
      });
      view.focus();

      attempts += 1;
      if (attempts < 2) schedule();
    };

    schedule();
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ effects: setSearchQueryEffect.of(searchQueryObject) });
  }, [searchQueryObject]);

  const previousFindSignatureRef = useRef<string>("");
  const findSignature = useMemo(
    () =>
      JSON.stringify({
        findText: searchState.findText,
        caseSensitive: searchState.caseSensitive,
        wholeWord: searchState.wholeWord,
        useRegex: searchState.useRegex,
        findInSelection: searchState.findInSelection,
        scopeFrom: searchScopeRange?.from ?? null,
        scopeTo: searchScopeRange?.to ?? null,
      }),
    [
      searchState.findText,
      searchState.caseSensitive,
      searchState.wholeWord,
      searchState.useRegex,
      searchState.findInSelection,
      searchScopeRange,
    ],
  );

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (searchState.findText && searchQueryObject.valid) {
      if (previousFindSignatureRef.current !== findSignature) {
        previousFindSignatureRef.current = findSignature;
        const selected = view.state.selection.main;
        const currentIndex = getCurrentMatchIndex(
          view.state,
          searchQueryObject,
          {
            from: selected.from,
            to: selected.to,
          },
        );
        if (currentIndex > 0) {
          scrollSearchFocusIntoView(view, selected.from);
        } else {
          const nextMatch = getNextMatch(
            view.state,
            searchQueryObject,
            view.state.selection.main.to,
          );
          if (nextMatch) {
            selectSearchMatch(view, nextMatch);
          }
        }
      }
    } else {
      previousFindSignatureRef.current = findSignature;
    }
    updateSearchMetrics(view, searchQueryObject);
  }, [
    findSignature,
    searchState.findText,
    searchQueryObject,
    updateSearchMetrics,
  ]);

  useEffect(() => {
    updateSearchMetrics(viewRef.current, searchQueryObject);
  }, [activeFileContent, searchQueryObject, updateSearchMetrics]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const target = e.target;
      if (!(target instanceof Element)) return;
      // Chat shares the drawer host with the editor. Scope shortcuts to the
      // actual editor/search controls, not their common workspace ancestor.
      const inEditor = viewRef.current?.dom.contains(target);
      const inSearch =
        target.closest('[data-testid="editor-search-panel"]') &&
        parentRef.current?.contains(target);
      if (!inEditor && !inSearch) return;
      if (e.key === "f") {
        e.preventDefault();
        openSearch(false);
      } else if (e.key === "h") {
        e.preventDefault();
        openSearch(true);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [openSearch]);

  const handleFindNext = useCallback(() => {
    const view = viewRef.current;
    if (!view) return;
    if (searchState.findText) {
      pushFindHistory(searchState.findText);
    }
    const nextMatch = getNextMatch(
      view.state,
      searchQueryObject,
      view.state.selection.main.to,
    );
    if (nextMatch) {
      selectSearchMatch(view, nextMatch);
    }
    updateSearchMetrics(view, searchQueryObject);
    view.focus();
  }, [
    pushFindHistory,
    searchState.findText,
    searchQueryObject,
    updateSearchMetrics,
  ]);

  const handleFindPrevious = useCallback(() => {
    const view = viewRef.current;
    if (!view) return;
    if (searchState.findText) {
      pushFindHistory(searchState.findText);
    }
    const previousMatch = getPreviousMatch(
      view.state,
      searchQueryObject,
      view.state.selection.main.from,
    );
    if (previousMatch) {
      selectSearchMatch(view, previousMatch);
    }
    updateSearchMetrics(view, searchQueryObject);
    view.focus();
  }, [
    pushFindHistory,
    searchState.findText,
    searchQueryObject,
    updateSearchMetrics,
  ]);

  const handleReplaceNext = useCallback(() => {
    const view = viewRef.current;
    if (!view || !searchState.findText || !searchQueryObject.valid) return;
    pushFindHistory(searchState.findText);
    pushReplaceHistory(searchState.replaceText);

    if (!searchState.preserveCase || searchState.useRegex) {
      replaceNext(view);
      updateSearchMetrics(view, searchQueryObject);
      view.focus();
      return;
    }

    const match = getNextMatch(
      view.state,
      searchQueryObject,
      view.state.selection.main.to,
    );
    if (!match) {
      updateSearchMetrics(view, searchQueryObject);
      view.focus();
      return;
    }
    const matchedText = view.state.sliceDoc(match.from, match.to);
    const replacement = applyPreserveCase(matchedText, searchState.replaceText);
    const anchor = match.from + replacement.length;
    view.dispatch({
      changes: { from: match.from, to: match.to, insert: replacement },
      selection: { anchor, head: anchor },
    });
    scrollSearchFocusIntoView(view, anchor);
    updateSearchMetrics(view, searchQueryObject);
    view.focus();
  }, [
    pushFindHistory,
    pushReplaceHistory,
    searchState.findText,
    searchState.replaceText,
    searchState.preserveCase,
    searchState.useRegex,
    searchQueryObject,
    updateSearchMetrics,
  ]);

  const handleReplaceAll = useCallback(() => {
    const view = viewRef.current;
    if (!view || !searchState.findText || !searchQueryObject.valid) return;
    pushFindHistory(searchState.findText);
    pushReplaceHistory(searchState.replaceText);

    if (!searchState.preserveCase || searchState.useRegex) {
      replaceAll(view);
      updateSearchMetrics(view, searchQueryObject);
      view.focus();
      return;
    }

    const matches: Array<{ from: number; to: number }> = [];
    const cursor = searchQueryObject.getCursor(view.state);
    for (let step = cursor.next(); !step.done; step = cursor.next()) {
      matches.push(step.value);
    }
    if (matches.length === 0) {
      updateSearchMetrics(view, searchQueryObject);
      view.focus();
      return;
    }
    const changes = matches
      .slice()
      .reverse()
      .map((match) => {
        const matchedText = view.state.sliceDoc(match.from, match.to);
        return {
          from: match.from,
          to: match.to,
          insert: applyPreserveCase(matchedText, searchState.replaceText),
        };
      });
    view.dispatch({ changes });
    updateSearchMetrics(view, searchQueryObject);
    view.focus();
  }, [
    pushFindHistory,
    pushReplaceHistory,
    searchState.findText,
    searchState.replaceText,
    searchState.preserveCase,
    searchState.useRegex,
    searchQueryObject,
    updateSearchMetrics,
  ]);

  compileRef.current = () => compileWorkspace({ force: true, snapshot: true });

  useEffect(() => {
    if (!containerRef.current || !isTextFile || activeGitFileConflict) return;
    const currentContent = getActiveFileContent();

    const updateListener = EditorView.updateListener.of((update) => {
      const savedSelection = commentSelectionRef.current;
      if (update.docChanged && savedSelection?.view === update.view) {
        savedSelection.selection = savedSelection.selection.map(update.changes);
      }
      if (update.selectionSet && (isMarkdownDocument || isLatexDocument)) {
        const { from, to } = update.state.selection.main;
        setEditorSelectedText(update.state.sliceDoc(from, to));
      }

      if (update.focusChanged) {
        const focused = update.view.hasFocus;
        // Preserve selected range for chat context when defocused, but hide toolbar.
        if (!focused && !toolbarStickyRef.current) {
          setSelectionCoords(null);
        }
      }

      if (isMergeActiveRef.current) {
        if (pendingChangeRef.current?.source === "external") {
          const change = pendingChangeRef.current;
          if (
            update.transactions.some(
              (transaction) =>
                transaction.annotation(Transaction.addToHistory) !== false,
            ) &&
            (update.docChanged ||
              update.transactions.some(
                (transaction) =>
                  transaction.isUserEvent("accept") ||
                  transaction.isUserEvent("revert"),
              ))
          ) {
            const reviewContent = update.state.doc.toString();
            useDocumentStore.setState((state) => ({
              files: state.files.map((file) =>
                file.relativePath === change.filePath &&
                file.externalChange?.id === change.id
                  ? {
                      ...file,
                      externalChange: { ...file.externalChange, reviewContent },
                    }
                  : file,
              ),
            }));
          }
          return;
        }
        if (
          update.selectionSet ||
          (update.focusChanged && update.view.hasFocus)
        ) {
          const { from, to, head } = update.state.selection.main;
          setCursorPosition(head);
          const draft = pendingChangeRef.current;
          if (
            draft?.source === "proposal" &&
            draft.workspaceSessionId &&
            useDocumentStore.getState().agentWorkspaceSessionId ===
              draft.workspaceSessionId &&
            from !== to
          ) {
            // The main CodeMirror document is the proposed version. Deleted
            // original-text widgets do not become draft selection context.
            window.dispatchEvent(
              new CustomEvent(SELECTION_OWNER_EVENT, { detail: "editor" }),
            );
            setSelectionRange({ start: from, end: to });
          } else {
            clearSelectionUiState();
          }
        }
        const pendingChange = pendingChangeRef.current;
        const pendingHistory = pendingHistoryRef.current;
        const resolvedOneGitConflict = update.transactions.some(
          (transaction) =>
            transaction.isUserEvent("accept") ||
            transaction.isUserEvent("revert"),
        );
        if (
          resolvedOneGitConflict &&
          pendingChange?.source === "git-conflict" &&
          pendingHistory
        ) {
          gitConflictResolutionUndoStackRef.current.push({
            change: pendingChange,
            beforeState: update.startState,
            historySnapshot: pendingHistory,
            resultingContent: update.state.doc.toString(),
          });
          window.dispatchEvent(new CustomEvent(MERGE_PREVIEW_REFRESH_EVENT));
        }
        const editsAgentDraft =
          pendingChange?.source === "proposal" &&
          !!pendingChange.workspaceSessionId &&
          useDocumentStore.getState().agentWorkspaceSessionId ===
            pendingChange.workspaceSessionId &&
          update.transactions.some(
            (transaction) =>
              transaction.annotation(Transaction.addToHistory) !== false &&
              !transaction.annotation(diskRefresh),
          );
        if (editsAgentDraft && pendingChange) {
          const proposals = useProposedChangesStore.getState();
          const current = proposals.changes.find(
            (change) => change.id === pendingChange.id,
          );
          if (resolvedOneGitConflict || current?.reviewedContent !== undefined)
            proposals.setReviewedContent(
              pendingChange.id,
              getOriginalDoc(update.state).toString(),
            );
        }
        if (
          update.docChanged &&
          pendingChange &&
          (pendingChange.source === "git-conflict" || editsAgentDraft)
        ) {
          // Checkpoint human edits in the isolated review buffer. The queue
          // persists them without accepting the draft or writing source files.
          if (
            pendingChange.source === "git-conflict" &&
            pendingChange.conflictVersion
          ) {
            useDocumentStore.setState((state) => ({
              files: state.files.map((file) =>
                file.relativePath === pendingChange.filePath
                  ? {
                      ...file,
                      content: update.state.doc.toString(),
                      isDirty: false,
                    }
                  : file,
              ),
            }));
          } else {
            useDocumentStore
              .getState()
              .updateFileContent(
                pendingChange.filePath,
                update.state.doc.toString(),
              );
          }
        }
        const chunks = getChunks(update.state);
        if (chunks) {
          const ranges = getReviewRanges(update.state);
          const total = ranges.length;
          // Track current chunk based on cursor position
          const cursorPos = update.state.selection.main.head;
          let current = 0;
          for (let i = 0; i < ranges.length; i++) {
            if (cursorPos >= ranges[i].fromB) current = i + 1;
          }
          setMergeChunkInfo({
            total,
            current: Math.min(Math.max(1, current), total),
          });

          // Auto-resolve when all chunks have been individually accepted/rejected
          // Note: acceptChunk doesn't change the main doc (only the original),
          // so we check total === 0 regardless of docChanged
          if (total === 0 && getThreeWayRegions(update.state).length === 0) {
            const change = pendingChangeRef.current;
            if (change) {
              setTimeout(() => {
                const v = viewRef.current;
                if (!v || !isMergeActiveRef.current) return;
                // Guard: bail if already resolved by afterChunkAction or a new stacked edit arrived
                if (
                  pendingChangeRef.current !== change ||
                  getChunks(v.state)?.chunks.length ||
                  getThreeWayRegions(v.state).length
                )
                  return;
                const historySnapshot = pendingHistoryRef.current;
                if (!historySnapshot) return;
                const finalContent = v.state.doc.toString();
                if (change.source === "git-conflict") {
                  // A failed write requires an explicit retry, not another
                  // zero-chunk editor update (including focus changes).
                  if (failedGitConflictResolutionRef.current?.id === change.id)
                    return;
                  resolveGitConflictRef.current(
                    v,
                    change,
                    historySnapshot,
                    finalContent,
                  );
                  return;
                }
                markThreeWayResolution(v, change);
                clearSelectionUiState();
                setMergeChunkInfo({ total: 0, current: 0 });
                v.dispatch({
                  effects: mergeCompartmentRef.current.reconfigure([]),
                });
                isMergeActiveRef.current = false;
                v.dispatch({
                  effects: historyCompartmentRef.current.reconfigure(
                    reviewedHistory(v, historySnapshot, finalContent),
                  ),
                });
                retainSettledSourceHistory(v, change);
                useDocumentStore
                  .getState()
                  .updateFileContent(change.filePath, finalContent);
                void settleFileReview(
                  change.id,
                  finalContent !== change.oldContent ||
                    !!change.conflictContents,
                ).catch((error) =>
                  toast.error(`Could not finish review: ${String(error)}`),
                );
                pendingChangeRef.current = null;
                pendingHistoryRef.current = null;
                v.focus();
              }, 0);
            }
          }
        }
        return;
      }
      if (update.docChanged) {
        const nextContent = update.state.doc.toString();
        const fromStore = update.transactions.some((transaction) =>
          transaction.annotation(diskRefresh),
        );
        // Persist the text before optional comment bookkeeping. A broken
        // anchor must never prevent autosave or automatic compilation.
        if (!fromStore) setContent(nextContent);
        const filePath = activeFileRelativePathRef.current;
        // Clean file refreshes have already reached disk. Let native recovery
        // decide continuity; persisting this display diff would race it and
        // treat an unknown replacement as an app-owned edit. Dirty store updates
        // (such as toolbar edits) still belong to the local document operation.
        const localEdit =
          !fromStore ||
          useDocumentStore
            .getState()
            .files.some(
              (file) => file.relativePath === filePath && file.isDirty,
            );
        if (filePath && !agentWorkspaceRoot && localEdit) {
          try {
            setInlineCommentsByFile((current) => {
              const comments = current[filePath] ?? [];
              if (comments.length === 0) return current;

              const mappedComments = commentsAfterEditorUpdate(
                comments,
                update.changes,
                update.state,
                update.startState,
              );
              const changed = mappedComments.some((comment, index) => {
                const previous = comments[index];
                return (
                  comment.from !== previous.from ||
                  comment.to !== previous.to ||
                  comment.line !== previous.line ||
                  comment.positionReset !== previous.positionReset ||
                  comment.removedAnchor !== previous.removedAnchor
                );
              });
              if (!changed) return current;

              return {
                ...current,
                [filePath]: mappedComments,
              };
            });
          } catch (error) {
            log.error("Failed to update comment positions after editing", {
              filePath,
              error: String(error),
            });
            toast.error(
              "Your edit is preserved, but comment positions could not be updated.",
              {
                id: "editor-comment-position-error",
                action: {
                  label: "Show comments",
                  onClick: () => {
                    const state = useDocumentStore.getState();
                    if (
                      state.projectRoot !== projectRoot ||
                      state.agentWorkspaceRoot
                    )
                      return;
                    const file = state.files.find(
                      (item) => item.relativePath === filePath,
                    );
                    if (!file) return;
                    state.setActiveFile(file.id);
                    const settings = useSettingsStore.getState();
                    settings.setDisplayComments(true);
                    settings.setEditorCommentsPanelOpen(
                      JSON.stringify(projectRoot),
                      true,
                    );
                  },
                },
              },
            );
          }
        }
      }
      // Refocusing preserves the CodeMirror range, so no selection transaction
      // occurs. Restore the dismissed toolbar from that range on focus as well.
      if (
        update.selectionSet ||
        (update.focusChanged && update.view.hasFocus)
      ) {
        const { from, to, head } = update.state.selection.main;
        if (update.selectionSet && update.view.hasFocus && from !== to) {
          window.dispatchEvent(
            new CustomEvent(SELECTION_OWNER_EVENT, { detail: "editor" }),
          );
        }
        setCursorPosition(head);
        if (from !== to) {
          lastNonEmptySelectionTextRef.current = update.state.sliceDoc(
            from,
            to,
          );
          lastNonEmptySelectionAtRef.current = Date.now();
        }
        setSelectionRangeForSearch(
          from !== to
            ? {
                from: Math.min(from, to),
                to: Math.max(from, to),
              }
            : null,
        );

        // Compute toolbar position below the selection end
        // Skip toolbar for "select all" (Cmd+A) to avoid overlay issues
        const isSelectAll = from === 0 && to === update.state.doc.length;
        if (from !== to && !isSelectAll) {
          setSelectionRange({ start: from, end: to });
          const startCoords = update.view.coordsAtPos(from);
          const endCoords = update.view.coordsAtPos(to);
          if (endCoords && startCoords) {
            setSelectionCoords({
              top: endCoords.bottom, // below last line of selection
              left: startCoords.left, // aligned to selection start
            });
          }
          toolbarStickyRef.current = true;
        } else if (update.view.hasFocus || !toolbarStickyRef.current) {
          // Only clear selection/coords if the toolbar is not being interacted with.
          // Clicking a toolbar action can cause CM to lose focus and collapse the selection,
          // but we want to keep the toolbar visible until explicitly dismissed.
          if (update.view.hasFocus) {
            setSelectionRange(null);
          }
          setSelectionCoords(null);
        }
      }

      // Sync diagnostics for Problems panel
      const diags: DiagnosticItem[] = [];
      forEachDiagnostic(update.state, (d, from) => {
        diags.push({
          from,
          to: d.to,
          severity: d.severity,
          message: d.message,
          source: d.source === "compile" ? "compile" : undefined,
          line: update.state.doc.lineAt(from).number,
        });
      });
      if (
        diags.length !== diagnosticsRef.current.length ||
        diags.some(
          (d, i) =>
            d.from !== diagnosticsRef.current[i]?.from ||
            d.to !== diagnosticsRef.current[i]?.to ||
            d.line !== diagnosticsRef.current[i]?.line ||
            d.source !== diagnosticsRef.current[i]?.source ||
            d.severity !== diagnosticsRef.current[i]?.severity ||
            d.message !== diagnosticsRef.current[i]?.message,
        )
      ) {
        diagnosticsRef.current = diags;
        setDiagnostics(diags);
      }
    });

    // Wrap selected text with a LaTeX command, or insert empty command at cursor
    const wrapSelection = (view: EditorView, cmd: string): boolean => {
      const { from, to } = view.state.selection.main;
      const selected = view.state.sliceDoc(from, to);
      const wrapped = `\\${cmd}{${selected}}`;
      const cursorPos = selected
        ? from + wrapped.length
        : from + cmd.length + 2;
      view.dispatch({
        changes: { from, to, insert: wrapped },
        selection: { anchor: cursorPos },
      });
      return true;
    };

    const wrapMarkdownSelection = (
      view: EditorView,
      marker: "**" | "_",
    ): boolean => {
      const { from, to } = view.state.selection.main;
      const selected = view.state.sliceDoc(from, to);
      const wrapped = `${marker}${selected}${marker}`;
      const cursorPosition = selected
        ? from + wrapped.length
        : from + marker.length;
      view.dispatch({
        changes: { from, to, insert: wrapped },
        selection: { anchor: cursorPosition },
      });
      return true;
    };

    const compileKeymap = Prec.highest(
      keymap.of([
        {
          key: "Mod-z",
          run: (view) => undoLastGitConflictResolutionRef.current(view),
        },
        {
          key: "Mod-Enter",
          run: () => {
            if (isMarkdownDocument) return false;
            compileRef.current();
            return true;
          },
        },
        {
          key: "Mod-s",
          run: () => {
            const state = useDocumentStore.getState();
            state.setIsSaving(true);
            state
              .saveCurrentFile()
              .finally(() => setTimeout(() => state.setIsSaving(false), 500));
            return true;
          },
        },
        {
          key: "Mod-f",
          run: (view) => {
            const selection = view.state.selection.main;
            const selectedText = selection.empty
              ? ""
              : view.state.sliceDoc(selection.from, selection.to);
            openSearch(false, selectedText);
            return true;
          },
        },
        {
          key: "Mod-h",
          run: (view) => {
            const selection = view.state.selection.main;
            const selectedText = selection.empty
              ? ""
              : view.state.sliceDoc(selection.from, selection.to);
            openSearch(true, selectedText);
            return true;
          },
        },
        {
          key: "Escape",
          run: () => {
            if (isSearchOpenRef.current) {
              closeSearch();
              return true;
            }
            return false;
          },
        },
        {
          key: "Enter",
          run: (view) => {
            if (!isSearchOpenRef.current) return false;
            const query = getSearchQuery(view.state);
            if (searchStateRef.current.findText) {
              pushFindHistory(searchStateRef.current.findText);
            }
            const nextMatch = getNextMatch(
              view.state,
              query,
              view.state.selection.main.to,
            );
            if (nextMatch) {
              selectSearchMatch(view, nextMatch);
            }
            updateSearchMetrics(view, query);
            return true;
          },
          shift: (view) => {
            if (!isSearchOpenRef.current) return false;
            const query = getSearchQuery(view.state);
            if (searchStateRef.current.findText) {
              pushFindHistory(searchStateRef.current.findText);
            }
            const previousMatch = getPreviousMatch(
              view.state,
              query,
              view.state.selection.main.from,
            );
            if (previousMatch) {
              selectSearchMatch(view, previousMatch);
            }
            updateSearchMetrics(view, query);
            return true;
          },
        },
        {
          key: "Mod-y",
          run: () => {
            if (isMergeActiveRef.current) {
              handleKeepAllRef.current();
              return true;
            }
            return false;
          },
        },
        {
          key: "Mod-n",
          run: () => {
            if (isMergeActiveRef.current) {
              handleUndoAllRef.current();
              return true;
            }
            return false;
          },
        },
        {
          key: "Mod-b",
          run: (view) =>
            isMarkdownDocument
              ? wrapMarkdownSelection(view, "**")
              : wrapSelection(view, "textbf"),
        },
        {
          key: "Mod-i",
          run: (view) =>
            isMarkdownDocument
              ? wrapMarkdownSelection(view, "_")
              : wrapSelection(view, "textit"),
        },
        {
          key: "Mod-/",
          run: toggleComment,
        },
      ]),
    );

    lintExtensionsRef.current =
      activeFile?.type === "tex"
        ? [
            documentLinter((view) => {
              const baseLinter = latexLinter();
              const documentState = useDocumentStore.getState();
              const ignoreMissingDocumentEnvironment = isIncludedLatexFile(
                documentState.activeFileId,
                documentState.files,
              );
              const diagnostics = baseLinter(view).filter(
                (diagnostic: Diagnostic) =>
                  !ignoreMissingDocumentEnvironment ||
                  !/^Missing document environment\b/i.test(diagnostic.message),
              );
              return diagnostics;
            }),
            compileDiagnosticExtension,
            diagnosticGutter,
          ]
        : [compileDiagnosticExtension, diagnosticGutter];

    const state = EditorState.create({
      doc: currentContent,
      extensions: [
        compileKeymap,
        lineNumbers(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        historyCompartmentRef.current.of(history()),
        commentHistory((patch) => replayCommentRef.current(patch)),
        readOnlyCompartmentRef.current.of([
          EditorState.readOnly.of(isEditorReadOnly),
          EditorView.editable.of(!isEditorReadOnly),
        ]),
        keymap.of([
          { key: "Enter", run: insertNewline, shift: insertNewline },
          { key: "Tab", run: indentMore, shift: indentLess },
          ...defaultKeymap,
          ...historyKeymap,
        ]),
        createEditorLanguageExtension(activeFile?.relativePath ?? "", true),
        spellCheckExtension(activeFile?.relativePath ?? ""),
        lintCompartmentRef.current.of(
          suppressSyntaxDiagnosticsRef.current ? [] : lintExtensionsRef.current,
        ),
        diagnosticTooltipPosition,
        diagnosticChatCompartmentRef.current.of(
          diagnosticChatMode(showSidecarUi ? sendDiagnosticToChat : null),
        ),
        themeCompartmentRef.current.of(
          createEditorColorSchemeExtensions(
            editorColorScheme,
            effectiveEditorTheme,
          ),
        ),
        fontSizeCompartmentRef.current.of(
          createEditorFontSizeTheme(editorFontSize),
        ),
        searchPaddingCompartmentRef.current.of([]),
        search(),
        selectionHighlightsCompartmentRef.current.of(
          createSelectionCaseAwareHighlights(isSearchOpen, isSearchOpen),
        ),
        selectionChipPreviewCompartmentRef.current.of([]),
        createSelectionReactivationGuard(),
        createScrollbarSelectionGuard(),
        mergeCompartmentRef.current.of([]),
        gitGutterCompartmentRef.current.of([]),
        inlineCommentsCompartmentRef.current.of(
          createInlineCommentExtension([]),
        ),
        updateListener,
        editorMinimapUpdateListener,
        createEditorSurfaceExtensions(),
        scrollPastEnd(),
        editorInteractionTheme,
      ],
    });

    const view = new EditorView({
      state,
      parent: containerRef.current,
      dispatchTransactions: (transactions, editor) => {
        if (
          transactions.every((tr) =>
            canApplyCommentHistory(tr, () => canReplayCommentRef.current()),
          )
        )
          editor.update(transactions);
      },
    });
    viewRef.current = view;
    setEditorReadyRevision((revision) => revision + 1);
    // Initial review centering must yield to a user's text-selection gesture.
    const stopMergeAutoCenter = () => {
      mergeAutoCenterTokenRef.current += 1;
    };
    view.dom.addEventListener("pointerdown", stopMergeAutoCenter, true);

    let outlineScrollFrame: number | null = null;
    let outlineClickOwnsHighlight = false;
    let previousOutlineScrollTop = view.scrollDOM.scrollTop;
    const handleOutlineScroll = () => {
      if (outlineScrollFrame !== null) return;
      outlineScrollFrame = requestAnimationFrame(() => {
        outlineScrollFrame = null;
        if (!outlineTrackingEnabledRef.current) return;
        const { scrollTop, clientHeight } = view.scrollDOM;
        if (scrollTop === previousOutlineScrollTop) return;
        previousOutlineScrollTop = scrollTop;
        if (outlineClickOwnsHighlight) return;
        const store = useDocumentStore.getState();
        if (store.activeFileId !== activeFileId) return;
        const position =
          scrollTop <= 1
            ? 0
            : Math.min(
                view.state.doc.length,
                view.lineBlockAtHeight(scrollTop + clientHeight / 2).from,
              );
        if (store.outlineScrollPosition !== position) {
          useDocumentStore.setState({ outlineScrollPosition: position });
        }
      });
    };
    view.scrollDOM.addEventListener("scroll", handleOutlineScroll, {
      passive: true,
    });
    const handleOutlineClick = (event: MouseEvent) => {
      const target = event.target;
      if (
        !(target instanceof Element) ||
        !target.closest(".cm-line") ||
        !view.hasFocus
      )
        return;
      if (target.closest("button, a, input, textarea, [role=button]")) return;
      if (outlineScrollFrame !== null) {
        cancelAnimationFrame(outlineScrollFrame);
        outlineScrollFrame = null;
      }
      previousOutlineScrollTop = view.scrollDOM.scrollTop;
      outlineClickOwnsHighlight = true;
      // A click on the existing caret need not create a selection transaction.
      // It still hands outline tracking back from the viewport to the clicked section.
      const store = useDocumentStore.getState();
      if (store.activeFileId === activeFileId)
        store.setCursorPosition(view.state.selection.main.head);
    };
    view.contentDOM.addEventListener("click", handleOutlineClick);
    const resumeOutlineScroll = () => {
      ignoreScrollSyncUntilRef.current = 0;
      outlineClickOwnsHighlight = false;
    };
    const handleOutlineWheel = (event: WheelEvent) => {
      if (event.deltaY !== 0) resumeOutlineScroll();
    };
    const handleOutlineScrollbar = (event: PointerEvent) => {
      if (event.target === view.scrollDOM) resumeOutlineScroll();
    };
    view.scrollDOM.addEventListener("wheel", handleOutlineWheel, {
      passive: true,
    });
    view.scrollDOM.addEventListener("touchmove", resumeOutlineScroll, {
      passive: true,
    });
    view.scrollDOM.addEventListener("pointerdown", handleOutlineScrollbar);

    const handleScrollSync = () => {
      if (
        !scrollSyncEnabledRef.current ||
        isNavigationScrolling(view.scrollDOM) ||
        performance.now() < ignoreScrollSyncUntilRef.current ||
        scrollSyncFrameRef.current !== null
      ) {
        return;
      }
      scrollSyncFrameRef.current = requestAnimationFrame(() => {
        scrollSyncFrameRef.current = null;
        if (
          !scrollSyncEnabledRef.current ||
          isNavigationScrolling(view.scrollDOM) ||
          performance.now() < ignoreScrollSyncUntilRef.current
        ) {
          return;
        }
        const { scrollTop, scrollHeight, clientHeight } = view.scrollDOM;
        const maxScrollTop = Math.max(0, scrollHeight - clientHeight);
        const position =
          scrollTop <= 1
            ? 0
            : maxScrollTop - scrollTop <= 1
              ? view.state.doc.length
              : Math.min(
                  view.state.doc.length,
                  view.posAtCoords(
                    {
                      x: view.contentDOM.getBoundingClientRect().left + 8,
                      y:
                        view.scrollDOM.getBoundingClientRect().top +
                        clientHeight / 2,
                    },
                    false,
                  ) ??
                    view.lineBlockAtHeight(scrollTop + clientHeight / 2).from,
                );
        if (lastScrollSyncPositionRef.current === position) return;
        lastScrollSyncPositionRef.current = position;
        onScrollPositionChangeRef.current?.(position);
      });
    };
    view.scrollDOM.addEventListener("scroll", handleScrollSync, {
      passive: true,
    });

    // Restore per-file cursor + viewport from cache
    const cached = editorStateCache.get(editorCacheKey);
    if (
      cached?.document === currentContent &&
      cached.history &&
      !cached.review
    ) {
      view.dispatch({
        effects: historyCompartmentRef.current.reconfigure(cached.history),
      });
    }
    if (
      cached?.compilerDiagnostics &&
      view.state.field(compileDiagnosticField, false)
    ) {
      view.dispatch({
        effects: replaceCompileDiagnostics.of(
          restoreCompilerMarkers(cached.compilerDiagnostics, view.state.doc),
        ),
      });
    }
    if (cached) {
      const pos = cached.reviewViewport
        ? mapReviewViewport(cached.reviewViewport, view.state.doc.toString())
            .cursor
        : Math.min(cached.cursor, view.state.doc.length);
      view.dispatch({ selection: { anchor: pos, head: pos } });
      // Scroll restoration needs layout to settle; run twice to avoid remount drift.
      requestAnimationFrame(() => {
        if (viewRef.current !== view) return;
        if (cached.reviewViewport) {
          const anchor = cached.reviewViewport;
          restoreReviewViewport(view, anchor, () => {
            delete cached.reviewViewport;
          });
        } else {
          restoreEditorScroll(view, cached);
          requestAnimationFrame(() => {
            if (viewRef.current === view) restoreEditorScroll(view, cached);
          });
        }
      });
    }

    let retainedCacheKey = editorCacheKey;
    const moved = (event: Event) => {
      const { projectRoot: root, changes } = (
        event as CustomEvent<{
          projectRoot: string;
          changes: CommentPathChange[];
        }>
      ).detail;
      const [cacheRoot, workspace, file] = JSON.parse(retainedCacheKey) as [
        string,
        string | null,
        string,
      ];
      if (cacheRoot !== root || workspace) return;
      const target = remapCommentPath(file, changes);
      if (target === file) return;
      retainedCacheKey = JSON.stringify([cacheRoot, workspace, target]);
      editorStateCache.set(retainedCacheKey, {
        ...captureEditorState(view),
        document: view.state.doc.toString(),
        history: retainEditorHistory(view.state),
      });
    };
    window.addEventListener(COMMENT_PATHS_CHANGED_EVENT, moved);
    return () => {
      window.removeEventListener(COMMENT_PATHS_CHANGED_EVENT, moved);
      cancelNavigationScroll(view.scrollDOM);
      view.dom.removeEventListener("pointerdown", stopMergeAutoCenter, true);
      // Save per-file cursor + viewport before destroying.
      const markers = view.state.field(compileDiagnosticField, false);
      editorStateCache.set(retainedCacheKey, {
        ...captureEditorState(view),
        ...(cached?.reviewViewport
          ? {
              reviewViewport: cached.reviewViewport,
              cursor: cached.reviewViewport.cursor,
            }
          : {}),
        document: view.state.doc.toString(),
        history: retainEditorHistory(view.state),
        review:
          isMergeActiveRef.current &&
          pendingChangeRef.current?.source === "proposal" &&
          pendingHistoryRef.current
            ? {
                change: pendingChangeRef.current,
                original: getOriginalDoc(view.state).toString(),
                baseline: pendingHistoryRef.current,
                threeWayRegions: getThreeWayRegions(view.state),
                threeWaySelections: getThreeWaySelections(view.state),
              }
            : undefined,
        compilerDiagnostics: markers
          ? { doc: view.state.doc, markers }
          : undefined,
      });
      view.scrollDOM.removeEventListener("scroll", handleOutlineScroll);
      view.contentDOM.removeEventListener("click", handleOutlineClick);
      view.scrollDOM.removeEventListener("wheel", handleOutlineWheel);
      view.scrollDOM.removeEventListener("touchmove", resumeOutlineScroll);
      view.scrollDOM.removeEventListener("pointerdown", handleOutlineScrollbar);
      if (outlineScrollFrame !== null) cancelAnimationFrame(outlineScrollFrame);
      view.scrollDOM.removeEventListener("scroll", handleScrollSync);
      if (scrollSyncFrameRef.current !== null) {
        cancelAnimationFrame(scrollSyncFrameRef.current);
        scrollSyncFrameRef.current = null;
      }
      cancelReviewViewport(view);
      view.destroy();
      if (viewRef.current === view) {
        viewRef.current = null;
        isMergeActiveRef.current = false;
        pendingChangeRef.current = null;
        pendingHistoryRef.current = null;
      }
    };
  }, [
    activeFileId,
    editorCacheKey,
    isTextFile,
    activeGitFileConflict,
    isLargeFileNotLoaded,
    setContent,
    setCursorPosition,
    setSelectionRange,
    clearSelectionUiState,
    editorMountNonce,
  ]);

  // Fast Refresh can replace the container node while preserving refs/state.
  // Re-attach the existing EditorView DOM so the editor does not appear blank.
  useLayoutEffect(() => {
    const view = viewRef.current;
    const container = containerRef.current;
    if (!view || !container) return;
    if (view.dom.parentElement !== container) {
      container.appendChild(view.dom);
      view.requestMeasure();
    }
  });

  // If HMR/Fast Refresh leaves the editor container without a mounted .cm-editor,
  // recover by either re-attaching the existing view DOM or forcing one re-mount.
  useLayoutEffect(() => {
    if (
      !isTextFile ||
      !activeFileId ||
      reviewingSnapshot ||
      !containerRef.current
    )
      return;
    const container = containerRef.current;
    if (container.querySelector(".cm-editor")) return;

    const view = viewRef.current;
    if (view) {
      container.appendChild(view.dom);
      view.requestMeasure();
      return;
    }

    if (!repairQueuedRef.current) {
      repairQueuedRef.current = true;
      queueMicrotask(() => {
        repairQueuedRef.current = false;
        setEditorMountNonce((n) => n + 1);
      });
    }
  }, [isTextFile, activeFileId, reviewingSnapshot]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: diagnosticChatCompartmentRef.current.reconfigure(
        diagnosticChatMode(showSidecarUi ? sendDiagnosticToChat : null),
      ),
    });
  }, [showSidecarUi, activeFileId, editorReadyRevision]);

  // Disable the lint extension during Git resolution, removing both the
  // Problems diagnostics and CodeMirror markers/tooltips. Re-enable it afterward
  // so the resolved content is checked again without remounting the editor.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: lintCompartmentRef.current.reconfigure(
        suppressSyntaxDiagnostics ? [] : lintExtensionsRef.current,
      ),
    });
    if (suppressSyntaxDiagnostics) {
      diagnosticsRef.current = [];
      setDiagnostics([]);
    }
  }, [suppressSyntaxDiagnostics, activeFileId, editorReadyRevision]);

  // Publish each compile result once. CodeMirror then maps its ranges through edits,
  // rather than repeatedly applying old compiler line numbers to a changed document.
  useEffect(() => {
    const view = viewRef.current;
    if (!view || suppressSyntaxDiagnostics) return;
    const markers = view.state.field(compileDiagnosticField, false);
    if (!markers) return;
    if (
      markers.results.length === compileDiagnostics.length &&
      markers.results.every(
        (result, index) => result === compileDiagnostics[index],
      )
    ) {
      setUnlocatedCompileDiagnostics(markers.unlocated ?? []);
      return;
    }
    const { located, unlocated } = locateCompileDiagnostics(
      view.state.doc,
      activeFileId,
      compileDiagnostics,
    );
    setUnlocatedCompileDiagnostics(unlocated);
    view.dispatch({
      effects: replaceCompileDiagnostics.of({
        results: compileDiagnostics,
        diagnostics: located,
        unlocated,
      }),
    });
  }, [
    compileDiagnostics,
    activeFileId,
    editorReadyRevision,
    suppressSyntaxDiagnostics,
  ]);

  // Dynamically switch editor syntax colors when the app or editor setting changes.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: readOnlyCompartmentRef.current.reconfigure([
        EditorState.readOnly.of(isEditorReadOnly || isResolvingGitConflict),
        EditorView.editable.of(!isEditorReadOnly && !isResolvingGitConflict),
      ]),
    });
  }, [isEditorReadOnly, isResolvingGitConflict]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: themeCompartmentRef.current.reconfigure(
        createEditorColorSchemeExtensions(
          editorColorScheme,
          effectiveEditorTheme,
        ),
      ),
    });
  }, [editorColorScheme, effectiveEditorTheme]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: fontSizeCompartmentRef.current.reconfigure(
        createEditorFontSizeTheme(editorFontSize),
      ),
    });
  }, [editorFontSize]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || !isTextFile || isMergeActiveRef.current || activeMergeChange)
      return;
    const content = activeFileContent ?? "";
    const currentContent = view.state.doc.toString();
    if (currentContent !== content) {
      view.dispatch({
        changes: createDocumentChangeSet(currentContent, content),
        annotations: [Transaction.addToHistory.of(false), diskRefresh.of(true)],
      });
      const cached = editorStateCache.get(editorCacheKey);
      if (cached?.reviewViewport) {
        const anchor = cached.reviewViewport;
        restoreReviewViewport(view, anchor, () => {
          delete cached.reviewViewport;
        });
      }
      if (cached?.document === content && cached.history && !cached.review) {
        view.dispatch({
          effects: historyCompartmentRef.current.reconfigure(cached.history),
        });
      }
    }
  }, [activeFileContent, activeMergeChange, isTextFile]);

  // Watch for proposed changes or Git conflicts → update the merge view.
  useEffect(() => {
    const view = viewRef.current;
    log.debug("effect fired", {
      hasView: !!view,
      isTextFile,
      activeMergeChange: activeMergeChange
        ? { id: activeMergeChange.id, filePath: activeMergeChange.filePath }
        : null,
      isMergeActive: isMergeActiveRef.current,
      pendingId: pendingChangeRef.current?.id,
    });
    if (!view || !isTextFile) return;

    if (activeMergeChange && !isMergeActiveRef.current) {
      // Activate merge view: load newContent + enable merge extension in ONE atomic dispatch
      log.debug(`ACTIVATING merge view for: ${activeMergeChange.filePath}`);
      const actionStack = gitConflictResolutionUndoStackRef.current;
      const previousConflictAction = actionStack[actionStack.length - 1];
      if (
        previousConflictAction &&
        (previousConflictAction.change.id !== activeMergeChange.id ||
          previousConflictAction.change.timestamp !==
            activeMergeChange.timestamp)
      ) {
        gitConflictResolutionUndoStackRef.current = [];
      }
      const cached = editorStateCache.get(editorCacheKey);
      const savedReview = cached?.review;
      const resumeReview =
        activeMergeChange.source === "proposal" &&
        savedReview &&
        savedReview.change.id === activeMergeChange.id &&
        savedReview.change.oldContent === activeMergeChange.oldContent &&
        savedReview.change.newContent === activeMergeChange.newContent;
      const sourceFile = activeMergeChange.workspaceSessionId
        ? useDocumentStore
            .getState()
            .sourceViewSnapshot?.files.find(
              (file) => file.relativePath === activeMergeChange.filePath,
            )
        : undefined;
      const sourceHistory = sourceFile
        ? editorStateCache.get(
            JSON.stringify([projectRoot, null, sourceFile.id]),
          )
        : undefined;
      const baselineState =
        sourceHistory?.document === activeMergeChange.oldContent &&
        sourceHistory.history &&
        !sourceHistory.review
          ? EditorState.create({
              doc: sourceHistory.document,
              extensions: sourceHistory.history,
            })
          : view.state;
      pendingHistoryRef.current = resumeReview
        ? savedReview.baseline
        : captureEditorHistory(
            baselineState,
            activeMergeChange.oldContent,
            (debugInlineCommentsByFile ?? inlineCommentsByFile)[
              activeMergeChange.filePath
            ] ?? [],
          );
      pendingChangeRef.current = activeMergeChange;
      reviewViewportRef.current = null;
      clearSelectionUiState();
      isMergeActiveRef.current = true;
      try {
        view.dispatch({
          changes: {
            from: 0,
            to: view.state.doc.length,
            insert: resumeReview
              ? cached.document!
              : activeMergeChange.newContent,
          },
          selection: { anchor: 0 },
          effects: [
            mergeCompartmentRef.current.reconfigure([
              unifiedMergeView({
                original: resumeReview
                  ? savedReview.original
                  : activeMergeChange.oldContent,
                highlightChanges: true,
                gutter: true,
                diffConfig:
                  activeMergeChange.source === "proposal"
                    ? { scanLimit: 10000 }
                    : undefined,
                mergeControls:
                  activeMergeChange.source === "git-conflict"
                    ? renderGitConflictControl
                    : activeMergeChange.source === "proposal"
                      ? renderProposalControl
                      : true,
              }),
              activeMergeChange.conflictContents &&
              !activeMergeChange.resolvedConflict
                ? createThreeWayMergeExtension({
                    segments: activeMergeChange.conflictContents,
                    original: activeMergeChange.oldContent,
                    proposed: activeMergeChange.newContent,
                    palette:
                      activeMergeChange.source === "git-conflict"
                        ? "git"
                        : "agent",
                    regions: resumeReview
                      ? savedReview.threeWayRegions
                      : undefined,
                    selections: resumeReview
                      ? savedReview.threeWaySelections
                      : undefined,
                  })
                : [],
              activeMergeChange.source === "git-conflict"
                ? gitConflictMergeClass
                : [],
              activeMergeChange.source === "proposal" ||
              activeMergeChange.conflictContents
                ? reviewDecisionHistory
                : [],
            ]),
            ...(activeMergeChange.source === "proposal"
              ? []
              : [gitGutterCompartmentRef.current.reconfigure([])]),
          ],
          annotations: Transaction.addToHistory.of(false),
        });
        if (activeMergeChange.source === "proposal") {
          view.dispatch({
            effects: historyCompartmentRef.current.reconfigure(
              resumeReview && cached.history
                ? cached.history
                : retainEditorHistory(
                    EditorState.create({ extensions: [history()] }),
                  ),
            ),
          });
        }
        log.debug("merge view activated successfully");
        centerFirstMergeChunkAfterLayout(view);
      } catch (err) {
        log.error("failed to activate merge view", { error: String(err) });
        isMergeActiveRef.current = false;
        pendingChangeRef.current = null;
        pendingHistoryRef.current = null;
      }
    } else if (
      activeMergeChange &&
      isMergeActiveRef.current &&
      (pendingChangeRef.current?.id !== activeMergeChange.id ||
        (activeMergeChange.source === "proposal" &&
          activeMergeChange.workspaceSessionId &&
          (pendingChangeRef.current.newContent !==
            activeMergeChange.newContent ||
            pendingChangeRef.current.oldContent !==
              activeMergeChange.oldContent)))
    ) {
      // Recovery can refresh a proposal's captured edits without changing its ID.
      // Compare proposal snapshots, not the live document, so ordinary typing
      // does not reset the merge view or its selection.
      log.debug(
        `UPDATING merge view (stacked edit) for: ${activeMergeChange.filePath}`,
      );
      pendingChangeRef.current = activeMergeChange;
      clearSelectionUiState();
      try {
        const scrollTop = view.scrollDOM.scrollTop;
        view.dispatch({
          changes: {
            from: 0,
            to: view.state.doc.length,
            insert: activeMergeChange.newContent,
          },
          selection: { anchor: 0 },
          effects: [
            mergeCompartmentRef.current.reconfigure([
              unifiedMergeView({
                original: activeMergeChange.oldContent,
                highlightChanges: true,
                gutter: true,
                diffConfig:
                  activeMergeChange.source === "proposal"
                    ? { scanLimit: 10000 }
                    : undefined,
                mergeControls:
                  activeMergeChange.source === "git-conflict"
                    ? renderGitConflictControl
                    : activeMergeChange.source === "proposal"
                      ? renderProposalControl
                      : true,
              }),
              activeMergeChange.conflictContents &&
              !activeMergeChange.resolvedConflict
                ? createThreeWayMergeExtension({
                    segments: activeMergeChange.conflictContents,
                    original: activeMergeChange.oldContent,
                    proposed: activeMergeChange.newContent,
                    palette:
                      activeMergeChange.source === "git-conflict"
                        ? "git"
                        : "agent",
                  })
                : [],
              activeMergeChange.source === "git-conflict"
                ? gitConflictMergeClass
                : [],
              activeMergeChange.source === "proposal" ||
              activeMergeChange.conflictContents
                ? reviewDecisionHistory
                : [],
            ]),
            ...(activeMergeChange.source === "proposal"
              ? []
              : [gitGutterCompartmentRef.current.reconfigure([])]),
          ],
          annotations: Transaction.addToHistory.of(false),
        });
        view.scrollDOM.scrollTop = scrollTop;
        if (activeMergeChange.source === "proposal") {
          view.dispatch({
            effects: historyCompartmentRef.current.reconfigure(
              retainEditorHistory(
                EditorState.create({ extensions: [history()] }),
              ),
            ),
          });
        }
        log.debug("merge view updated successfully (stacked edit)");
      } catch (err) {
        log.error("failed to update merge view", { error: String(err) });
      }
    } else if (!activeMergeChange && isMergeActiveRef.current) {
      // Deactivate merge view (externally resolved)
      log.debug("DEACTIVATING merge view");
      const historySnapshot = pendingHistoryRef.current;
      const finalContent =
        pendingChangeRef.current?.source === "external"
          ? (useDocumentStore
              .getState()
              .files.find((file) => file.id === activeFileId)?.content ??
            view.state.doc.toString())
          : view.state.doc.toString();
      clearSelectionUiState();
      view.dispatch({
        changes: createDocumentChangeSet(
          view.state.doc.toString(),
          finalContent,
        ),
        annotations: Transaction.addToHistory.of(false),
        effects: mergeCompartmentRef.current.reconfigure([]),
      });
      isMergeActiveRef.current = false;
      if (historySnapshot) {
        view.dispatch({
          effects: historyCompartmentRef.current.reconfigure(
            reviewedHistory(view, historySnapshot, finalContent),
          ),
        });
      }
      pendingChangeRef.current = null;
      pendingHistoryRef.current = null;
    }
  }, [
    activeMergeChange,
    centerFirstMergeChunkAfterLayout,
    clearSelectionUiState,
    editorReadyRevision,
    isTextFile,
  ]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || jumpToPosition === null) return;
    if (scrollSyncEnabled) {
      lastScrollSyncPositionRef.current = jumpToPosition;
      ignoreScrollSyncUntilRef.current = performance.now() + 250;
    }
    view.dispatch({
      selection: { anchor: jumpToPosition },
    });
    scrollToEditorPosition(view, jumpToPosition);
    view.focus();
    clearJumpRequest();
  }, [jumpToPosition, clearJumpRequest, scrollSyncEnabled]);

  useEffect(() => {
    if (!outlineTrackingEnabled) return;
    const frame = requestAnimationFrame(() => {
      const view = viewRef.current;
      if (!view) return;
      const { scrollTop, clientHeight } = view.scrollDOM;
      useDocumentStore.setState({
        outlineScrollPosition:
          scrollTop <= 1
            ? 0
            : Math.min(
                view.state.doc.length,
                view.lineBlockAtHeight(scrollTop + clientHeight / 2).from,
              ),
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [outlineTrackingEnabled]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || !scrollSyncEnabled || scrollSyncPaused || !scrollSyncTarget)
      return;
    const position = Math.max(
      0,
      Math.min(scrollSyncTarget.position, view.state.doc.length),
    );
    lastScrollSyncPositionRef.current = position;
    ignoreScrollSyncUntilRef.current = performance.now() + 250;
    view.dispatch({
      effects: EditorView.scrollIntoView(position, { y: "center" }),
    });
  }, [scrollSyncEnabled, scrollSyncPaused, scrollSyncTarget]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || jumpToSelectionRange === null) return;
    const from = Math.max(
      0,
      Math.min(jumpToSelectionRange.start, view.state.doc.length),
    );
    const to = Math.max(
      from,
      Math.min(jumpToSelectionRange.end, view.state.doc.length),
    );
    if (from === to) {
      clearJumpRequest();
      return;
    }

    const center = Math.floor((from + to) / 2);
    view.dispatch({
      selection: { anchor: from, head: to },
      effects: EditorView.scrollIntoView(center, { y: "center" }),
    });
    view.focus();
    clearJumpRequest();
  }, [jumpToSelectionRange, clearJumpRequest]);

  // Selection toolbar: compute context label and container-relative position
  const selectionRange = useDocumentStore((s) => s.selectionRange);
  const selectionLabel = useMemo(() => {
    const view = viewRef.current;
    if (!selectionRange || !view || !activeFile) return null;
    try {
      const startLine = view.state.doc.lineAt(selectionRange.start);
      const endLine = view.state.doc.lineAt(selectionRange.end);
      const startCol = selectionRange.start - startLine.from + 1;
      const endCol = selectionRange.end - endLine.from + 1;
      const fileName = activeFile.relativePath;
      return `@${fileName}:${startLine.number}:${startCol}-${endLine.number}:${endCol}`;
    } catch {
      return null;
    }
  }, [selectionRange, activeFile]);

  useEffect(() => {
    const clearForPdfSelection = (event: Event) => {
      const owner = (event as CustomEvent).detail;
      if (owner !== "pdf" && owner !== "none") return;
      const view = viewRef.current;
      if (!view || view.state.selection.main.empty) return;
      toolbarStickyRef.current = false;
      view.dispatch({ selection: { anchor: view.state.selection.main.head } });
      setSelectionCoords(null);
      setSelectionRange(null);
    };
    window.addEventListener(SELECTION_OWNER_EVENT, clearForPdfSelection);
    return () =>
      window.removeEventListener(SELECTION_OWNER_EVENT, clearForPdfSelection);
  }, [setSelectionRange]);

  const toolbarPosition = useMemo(() => {
    if (!selectionCoords || !parentRef.current) return null;
    const parentRect = parentRef.current.getBoundingClientRect();
    const relTop = selectionCoords.top - parentRect.top + 4; // 4px gap below selection
    const relLeft = Math.max(
      8,
      Math.min(
        selectionCoords.left - parentRect.left,
        parentRect.width - 272, // 264px toolbar + 8px margin
      ),
    );
    return { top: relTop, left: relLeft };
  }, [selectionCoords]);

  const getToolbarAnchor = useCallback(() => {
    const view = viewRef.current;
    if (!view || !selectionRange) return null;
    const bounds = view.scrollDOM.getBoundingClientRect();
    const topEdge = Math.max(0, bounds.top);
    const bottomEdge = Math.min(window.innerHeight, bounds.bottom);
    if (bottomEdge <= topEdge) return null;
    const { doc } = view.state;
    const from = Math.max(
      0,
      Math.min(selectionRange.start, selectionRange.end, doc.length),
    );
    const to = Math.min(
      doc.length,
      Math.max(selectionRange.start, selectionRange.end),
    );
    if (from >= to) return null;
    const start = view.coordsAtPos(from);
    const end = view.coordsAtPos(to - 1);
    // CodeMirror may not render an endpoint far outside its virtual viewport.
    const selectionTop =
      start?.top ?? view.documentTop + view.lineBlockAt(from).top;
    const selectionBottom =
      end?.bottom ?? view.documentTop + view.lineBlockAt(to - 1).bottom;
    if (selectionBottom <= topEdge || selectionTop >= bottomEdge) return null;
    return {
      top: selectionTop,
      left: view.contentDOM.getBoundingClientRect().left - 42 - 2,
      bounds: {
        top: topEdge + 8,
        bottom: bottomEdge - 8,
        left: 8,
        right: window.innerWidth - 8,
      },
    };
  }, [selectionRange]);

  useEffect(() => {
    if (
      !selectionRange ||
      selectionCoords ||
      !parentRef.current ||
      isMergeActiveRef.current
    )
      return;
    const view = viewRef.current;
    if (!view?.hasFocus || selectionRange.start === selectionRange.end) return;
    const from = Math.max(
      0,
      Math.min(selectionRange.start, view.state.doc.length),
    );
    const to = Math.max(0, Math.min(selectionRange.end, view.state.doc.length));
    if (from === to) return;

    const selectionStart = Math.min(from, to);
    const selectionEnd = Math.max(from, to);
    const startCoords = view.coordsAtPos(selectionStart);
    const endCoords = view.coordsAtPos(selectionEnd);
    if (startCoords && endCoords) {
      setSelectionCoords({
        top: endCoords.bottom,
        left: Math.min(startCoords.left, endCoords.left),
      });
      return;
    }

    try {
      const startDom = view.domAtPos(selectionStart);
      const endDom = view.domAtPos(selectionEnd);
      const range = document.createRange();
      range.setStart(startDom.node, startDom.offset);
      range.setEnd(endDom.node, endDom.offset);
      const rect = range.getBoundingClientRect();
      if (rect.width <= 0 && rect.height <= 0) return;
      setSelectionCoords({
        top: rect.bottom,
        left: rect.left,
      });
    } catch {
      // Best-effort fallback for programmatic selections in test harnesses.
    }
  }, [selectionCoords, selectionRange]);

  const getSelectedDiagnosticIssues = useCallback(() => {
    const view = viewRef.current;
    if (!view || !selectionRange || suppressSyntaxDiagnostics) return [];
    const { doc } = view.state;
    const from = Math.max(
      0,
      Math.min(selectionRange.start, selectionRange.end, doc.length),
    );
    const to = Math.min(
      doc.length,
      Math.max(selectionRange.start, selectionRange.end),
    );
    if (from >= to) return [];
    const firstLine = doc.lineAt(from).number;
    // Selection ends are exclusive: ending at the next row's start excludes it.
    const lastLine = doc.lineAt(to - 1).number;
    const issues: DiagnosticChatIssue[] = [];
    forEachDiagnostic(view.state, (diagnostic, start, end) => {
      const issueFirstLine = doc.lineAt(start).number;
      const issueLastLine = doc.lineAt(Math.max(start, end - 1)).number;
      if (issueFirstLine <= lastLine && issueLastLine >= firstLine) {
        issues.push({ diagnostic, from: start });
      }
    });
    return issues;
  }, [selectionRange, suppressSyntaxDiagnostics]);

  // Diagnostics may arrive asynchronously after the selection was made.
  const hasSelectedIssues =
    diagnostics.length > 0 && getSelectedDiagnosticIssues().length > 0;

  const editorToolbarActions: ToolbarAction[] = useMemo(
    () =>
      [
        ...(hasSelectedIssues
          ? [
              {
                id: "fix-selected-issues",
                isAI: true,
                label: "Fix Selected Issues",
                icon: <MousePointerClickIcon className="size-4" />,
              },
            ]
          : []),
        {
          id: "proofread",
          isAI: true,
          label: "Proofread",
          icon: <SpellCheckIcon className="size-4" />,
        },
        {
          id: "comment",
          isAI: false,
          label: "Comment",
          disabled: !inlineCommentsLoaded,
          icon: <MessageSquareTextIcon className="size-4" />,
        },
      ].filter(
        (action) =>
          action.id !== "comment" || (displayComments && !agentWorkspaceRoot),
      ),
    [
      agentWorkspaceRoot,
      hasSelectedIssues,
      displayComments,
      inlineCommentsLoaded,
    ],
  );

  const openCommentForSelection = useCallback(() => {
    if (
      !inlineCommentsLoaded ||
      !useSettingsStore.getState().displayComments ||
      agentWorkspaceRoot ||
      isMergeActiveRef.current ||
      !activeFile?.content
    )
      return;
    const view = viewRef.current;
    const liveSelection = view?.state.selection.main;
    const selectionStart =
      liveSelection && !liveSelection.empty
        ? liveSelection.from
        : selectionRange?.start;
    const selectionEnd =
      liveSelection && !liveSelection.empty
        ? liveSelection.to
        : selectionRange?.end;
    if (selectionStart === undefined || selectionEnd === undefined) return;

    const doc = view?.state.doc.toString() ?? activeFile.content;
    if (!isInlineCommentRangeAllowed(doc.length, selectionStart, selectionEnd))
      return;

    const range = normalizeInlineCommentRange(
      doc,
      selectionStart,
      selectionEnd,
    );
    if (!range) return;

    const filePath = activeFile.relativePath;
    const comment: InlineEditorComment = {
      id: `${filePath}:${range.from}:${range.to}:${Date.now()}`,
      ...range,
      text: "",
      createdAt: new Date().toISOString(),

      isEditing: true,
    };

    pendingInlineCommentCenterIdRef.current = comment.id;
    if (view) {
      commentSelectionRef.current = {
        commentId: comment.id,
        view,
        selection: view.state.selection.main.empty
          ? EditorSelection.single(selectionStart, selectionEnd)
          : view.state.selection,
      };
      view.dispatch({ selection: { anchor: view.state.selection.main.head } });
    }
    setInlineCommentsByFile((current) => ({
      ...current,
      [filePath]: [
        ...(current[filePath] ?? []).filter(
          (existing) => existing.text.trim() || !existing.isEditing,
        ),
        comment,
      ],
    }));
    toolbarStickyRef.current = false;
    setSelectionCoords(null);
    setSelectionRange(null);
  }, [
    activeFile,
    selectionRange,
    setSelectionRange,
    agentWorkspaceRoot,
    inlineCommentsLoaded,
  ]);

  useEffect(() => {
    const run = (filePath: string, forward: boolean) => {
      if (!projectRoot || agentWorkspaceRoot || isMergeActiveRef.current)
        return false;
      breakCommentTypingGroup();
      const view = viewRef.current;
      if (view && activeFile?.relativePath === filePath) {
        if (!forward && undoLastGitConflictResolutionRef.current(view))
          return true;
        (forward ? redo : undo)(view);
        return true;
      }
      const source = useDocumentStore
        .getState()
        .files.find((file) => file.relativePath === filePath);
      if (!source || source.content == null) return false;
      const key = JSON.stringify([projectRoot, null, source.id]);
      const cached = editorStateCache.get(key);
      if (
        !cached?.history ||
        cached.document !== source.content ||
        cached.review
      )
        return false;
      const state = EditorState.create({
        doc: source.content,
        extensions: [
          cached.history,
          commentHistory(() => {}),
          createInlineCommentExtension(
            (debugInlineCommentsByFile ?? inlineCommentsByFile)[filePath] ?? [],
            { hidden: true },
          ),
        ],
      });
      (forward ? redo : undo)({
        state,
        dispatch: (tr) => {
          if (!canApplyCommentHistory(tr, () => canReplayCommentRef.current()))
            return;
          editorStateCache.set(key, {
            ...cached,
            document: tr.state.doc.toString(),
            history: retainEditorHistory(tr.state),
          });
          if (tr.docChanged) {
            useDocumentStore
              .getState()
              .updateFileContent(filePath, tr.state.doc.toString());
            setInlineCommentsByFile((current) => {
              const comments = current[filePath] ?? [];
              if (!comments.length) return current;
              const mapped = commentsAfterEditorUpdate(
                comments,
                tr.changes,
                tr.state,
                tr.startState,
              );
              return mapped.every(
                (comment, index) => comment === comments[index],
              )
                ? current
                : { ...current, [filePath]: mapped };
            });
          }
          for (const effect of tr.effects)
            if (effect.is(commentHistoryEffect))
              replayCommentRef.current(effect.value);
        },
      });
      return true;
    };
    const keydown = (event: KeyboardEvent) => {
      if (
        event.isComposing ||
        event.altKey ||
        !(event.metaKey || event.ctrlKey)
      )
        return;
      const key = event.key.toLowerCase();
      if (key !== "z" && !(key === "y" && event.ctrlKey && !event.metaKey))
        return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      const scopeElement = target.closest<HTMLElement>(
        "[data-file-history-scope]",
      );
      let scope: CommentHistoryScope | undefined;
      if (scopeElement?.dataset.fileHistoryScope)
        scope = JSON.parse(scopeElement.dataset.fileHistoryScope);
      // Chat, search, dialogs, and unrelated editable inputs have their own history.
      if (
        !scope &&
        target.closest(
          'input, textarea, [contenteditable="true"], [role="dialog"]',
        ) &&
        !(
          target.closest(".cm-content") && viewRef.current?.dom.contains(target)
        )
      )
        return;
      if (scope && scope.root !== projectRoot) return;
      const selectedId = getActiveComment();
      const selectedPath = Object.entries(inlineCommentsByFile).find(
        ([, comments]) => comments.some((c) => c.id === selectedId),
      )?.[0];
      const filePath =
        scope?.filePath ??
        (target.closest("[data-pdf-comment-surface]")
          ? selectedPath
          : undefined) ??
        activeFile?.relativePath;
      if (filePath && run(filePath, event.shiftKey || key === "y")) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };
    const requested = (event: Event) => {
      const request = event as CustomEvent<
        CommentHistoryScope & { redo: boolean }
      >;
      if (
        request.detail.root === projectRoot &&
        run(request.detail.filePath, request.detail.redo)
      )
        request.preventDefault();
    };
    window.addEventListener("keydown", keydown, true);
    window.addEventListener("catalex-file-undo", requested);
    return () => {
      window.removeEventListener("keydown", keydown, true);
      window.removeEventListener("catalex-file-undo", requested);
    };
  }, [
    projectRoot,
    agentWorkspaceRoot,
    activeFile?.relativePath,
    inlineCommentsByFile,
    debugInlineCommentsByFile,
    setInlineCommentsByFile,
  ]);

  const inlineCommentFilePath = activeFile?.relativePath;
  const handleSaveInlineComment = useCallback(
    (commentId: string, text: string) => {
      if (!inlineCommentFilePath || !text.trim()) return;
      if (commentSelectionRef.current?.commentId === commentId) {
        commentSelectionRef.current = null;
      }
      const filePath = inlineCommentFilePath;
      setInlineCommentsByFile((current) => ({
        ...current,
        [filePath]: (current[filePath] ?? []).map((comment) =>
          comment.id === commentId
            ? { ...comment, text, isEditing: false }
            : comment,
        ),
      }));
    },
    [inlineCommentFilePath],
  );

  const handleResolveInlineComment = useCallback(
    (commentId: string) => {
      if (!inlineCommentFilePath) return;
      const filePath = inlineCommentFilePath;
      setInlineCommentsByFile((current) => ({
        ...current,
        [filePath]: (current[filePath] ?? []).map((comment) =>
          comment.id === commentId ? { ...comment, resolved: true } : comment,
        ),
      }));
    },
    [inlineCommentFilePath],
  );

  const handleEditInlineComment = useCallback(
    (commentId: string) => {
      if (!inlineCommentFilePath) return;
      const filePath = inlineCommentFilePath;
      setInlineCommentsByFile((current) => ({
        ...current,
        [filePath]: (current[filePath] ?? []).map((comment) =>
          comment.id === commentId ? { ...comment, isEditing: true } : comment,
        ),
      }));
    },
    [inlineCommentFilePath],
  );

  const handleDeleteInlineComment = useCallback(
    (commentId: string) => {
      if (!inlineCommentFilePath) return;
      const filePath = inlineCommentFilePath;
      setInlineCommentsByFile((current) => ({
        ...current,
        [filePath]: (current[filePath] ?? []).filter(
          (comment) => comment.id !== commentId,
        ),
      }));
    },
    [inlineCommentFilePath],
  );

  const handleCancelInlineComment = useCallback(
    (commentId: string) => {
      const saved = commentSelectionRef.current;
      commentSelectionRef.current = null;
      handleDeleteInlineComment(commentId);
      if (saved?.commentId === commentId && saved.view === viewRef.current) {
        saved.view.dispatch({
          selection: saved.selection,
          scrollIntoView: true,
        });
        saved.view.focus();
      }
    },
    [handleDeleteInlineComment],
  );

  const handleToolbarAction = useCallback(
    (actionId: string) => {
      if (actionId === "comment") {
        openCommentForSelection();
        return;
      }

      if (actionId === "fix-selected-issues") {
        const view = viewRef.current;
        const issues = getSelectedDiagnosticIssues();
        toolbarStickyRef.current = false;
        setSelectionCoords(null);
        setSelectionRange(null);
        if (view && issues.length > 0) sendDiagnosticToChat(view, issues);
        return;
      }

      const contextOverride =
        activeFile && selectionRange && selectionLabel && activeFile.content
          ? {
              label: selectionLabel,
              filePath: activeFile.relativePath,
              selectedText: activeFile.content.slice(
                Math.max(
                  0,
                  Math.min(selectionRange.start, activeFile.content.length),
                ),
                Math.max(
                  0,
                  Math.min(selectionRange.end, activeFile.content.length),
                ),
              ),
            }
          : undefined;
      toolbarStickyRef.current = false;
      setSelectionCoords(null);
      setSelectionRange(null);
      if (actionId === "proofread") {
        useAgentChatStore
          .getState()
          .sendPrompt(
            "Proofread and fix any errors in this text",
            contextOverride,
          );
      }
    },
    [
      activeFile,
      openCommentForSelection,
      getSelectedDiagnosticIssues,
      selectionLabel,
      selectionRange,
      setSelectionRange,
    ],
  );

  const handleToolbarDismiss = useCallback(
    (reason?: "outside" | "escape") => {
      toolbarStickyRef.current = false;
      setSelectionCoords(null);
      // Moving focus to chat hides the toolbar without discarding its context.
      // The editor selection listener handles an explicit collapsed selection.
      if (reason !== "outside") setSelectionRange(null);
    },
    [setSelectionRange],
  );

  const [pdfCommentRequest, setPdfCommentRequest] = useState<{
    filePath: string;
    commentId: string;
  } | null>(null);
  useEffect(() => {
    const navigate = (event: Event) => {
      const detail = (
        event as CustomEvent<{
          projectRoot: string;
          filePath: string;
          commentId: string;
        }>
      ).detail;
      if (detail.projectRoot !== commentProjectRoot) return;
      const file = useDocumentStore
        .getState()
        .files.find((file) => file.relativePath === detail.filePath);
      if (!file) return;
      setPdfCommentRequest(detail);
      if (useDocumentStore.getState().activeFileId !== file.id)
        useDocumentStore.getState().setActiveFile(file.id);
    };
    window.addEventListener(PDF_COMMENT_NAVIGATE_EVENT, navigate);
    return () =>
      window.removeEventListener(PDF_COMMENT_NAVIGATE_EVENT, navigate);
  }, [commentProjectRoot]);

  useEffect(() => {
    if (
      !pdfCommentRequest ||
      activeFile?.relativePath !== pdfCommentRequest.filePath
    )
      return;
    const comment = (
      inlineCommentsByFile[pdfCommentRequest.filePath] ?? []
    ).find((item) => item.id === pdfCommentRequest.commentId);
    const view = viewRef.current;
    if (!view || !comment) return;
    saveCommentsPanelOpen(panelsProjectKey, true);
    saveCommentFilter(panelsProjectKey, comment.origin ? "agent" : "human");
    pendingInlineCommentCenterIdRef.current = null;
    const from = Math.max(0, Math.min(comment.from, view.state.doc.length));
    scrollToEditorPosition(view, from, comment.id);
    setPdfCommentRequest(null);
    // Follow the card's measured geometry as the author filter mounts it.
  }, [
    pdfCommentRequest,
    activeFile?.relativePath,
    inlineCommentsByFile,
    editorReadyRevision,
    panelsProjectKey,
    saveCommentsPanelOpen,
    saveCommentFilter,
  ]);

  // History review action handlers
  const handleHistoryRestore = useCallback(async () => {
    if (!reviewingSnapshot || !projectRoot) return;
    useHistoryStore.getState().stopReview();
    await useHistoryStore
      .getState()
      .restoreSnapshot(projectRoot, reviewingSnapshot.id);
  }, [reviewingSnapshot, projectRoot]);

  const [historyLabelDialogOpen, setHistoryLabelDialogOpen] = useState(false);
  const [historyLabelValue, setHistoryLabelValue] = useState("");

  const handleHistoryAddLabel = useCallback(async () => {
    const label = historyLabelValue.trim();
    if (!label || !reviewingSnapshot || !projectRoot) return;
    await useHistoryStore
      .getState()
      .addLabel(projectRoot, reviewingSnapshot.id, label);
    setHistoryLabelDialogOpen(false);
    setHistoryLabelValue("");
  }, [reviewingSnapshot, projectRoot, historyLabelValue]);

  const handleHistoryCopySha = useCallback(() => {
    if (!reviewingSnapshot) return;
    navigator.clipboard.writeText(reviewingSnapshot.id);
  }, [reviewingSnapshot]);

  const handleHistoryClose = useCallback(() => {
    useHistoryStore.getState().stopReview();
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const handleGitStatsRefresh = () => {
      setGitHeadRefreshNonce((nonce) => nonce + 1);
    };
    window.addEventListener(GIT_STATS_REFRESH_EVENT, handleGitStatsRefresh);
    return () => {
      window.removeEventListener(
        GIT_STATS_REFRESH_EVENT,
        handleGitStatsRefresh,
      );
    };
  }, []);

  useEffect(() => {
    if (!projectRoot || !activeFile || !isTextFile) {
      setGitHeadContent(undefined);
      return;
    }

    // Clear previous file's git baseline immediately so stale gutter colors
    // do not remain visible while the next file baseline is loading.
    setGitHeadContent(undefined);

    let isCancelled = false;
    invoke<GitHeadFileContent>("git_head_file_content", {
      projectRoot,
      filePath: activeFile.relativePath,
    })
      .then((result) => {
        if (isCancelled) return;
        if (!result.repo_found || result.ignored) {
          setGitHeadContent(undefined);
          return;
        }
        setGitHeadContent(result.head_content);
      })
      .catch(() => {
        if (!isCancelled) setGitHeadContent(undefined);
      });

    return () => {
      isCancelled = true;
    };
  }, [activeFile?.relativePath, gitHeadRefreshNonce, isTextFile, projectRoot]);

  useEffect(() => {
    setActiveGitDeletionConflict(null);
    if (!projectRoot || !activeFile) return;
    let cancelled = false;
    void invoke<ConflictOverview>("git_panel_conflicts", { projectRoot })
      .then((overview) => {
        if (cancelled) return;
        const conflict = overview.files.find(
          (entry) => entry.document_path === activeFile.relativePath,
        );
        if (
          conflict &&
          isTextEditorConflict(conflict) &&
          (!conflict.current || !conflict.incoming)
        )
          setActiveGitDeletionConflict(conflict);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [projectRoot, activeFile?.relativePath, gitHeadRefreshNonce]);

  useEffect(() => {
    if (!projectRoot || !activeFile || !isTextFile) {
      setActiveGitConflict(null);
      setGitConflictError(null);
      return;
    }

    if (!isMergeActiveRef.current) setActiveGitConflict(null);
    setGitConflictError(null);
    let isCancelled = false;
    invoke<GitConflictFileContent>("git_conflict_file_content", {
      projectRoot,
      filePath: activeFile.relativePath,
    })
      .then((result) => {
        if (isCancelled) return;
        if (
          !result.conflicted ||
          result.current_content === null ||
          result.incoming_content === null
        ) {
          setActiveGitConflict(null);
          return;
        }
        setActiveGitConflict((previous) => {
          if (
            result.version &&
            previous?.conflictVersion === result.version &&
            previous.filePath === activeFile.relativePath &&
            previous.oldContent === result.current_content
          )
            return previous;
          return {
            id: `git-conflict:${activeFile.relativePath}`,
            filePath: activeFile.relativePath,
            absolutePath: activeFile.absolutePath,
            ancestorContent: result.ancestor_content,
            conflictVersion: result.version ?? undefined,
            conflictContents: result.conflict_contents?.some(
              (segment) => segment.kind === "conflict",
            )
              ? result.conflict_contents
              : undefined,
            oldContent: result.current_content!,
            newContent: result.incoming_content!,
            toolName: "Git merge",
            timestamp: Date.now(),
            source: "git-conflict",
          };
        });
      })
      .catch((error) => {
        if (!isCancelled) {
          setActiveGitConflict(null);
          log.error("failed to load Git conflict versions", {
            error: String(error),
          });
        }
      });

    return () => {
      isCancelled = true;
    };
  }, [
    activeFile?.absolutePath,
    activeFile?.relativePath,
    gitHeadRefreshNonce,
    isTextFile,
    projectRoot,
  ]);

  const gitLineChanges = useMemo(() => {
    if (
      !isTextFile ||
      activeFileContent === undefined ||
      gitHeadContent === undefined
    ) {
      return [];
    }
    return computeGitLineChanges(gitHeadContent, activeFileContent);
  }, [activeFileContent, gitHeadContent, isTextFile]);

  useEffect(() => {
    const view = viewRef.current;
    if (
      !view ||
      (isMergeActiveRef.current &&
        pendingChangeRef.current?.source !== "proposal")
    )
      return;
    const changes =
      isMergeActiveRef.current && gitHeadContent !== undefined
        ? computeGitLineChanges(gitHeadContent, view.state.doc.toString())
        : gitLineChanges;
    view.dispatch({
      effects: gitGutterCompartmentRef.current.reconfigure(
        changes.length > 0 ? createGitLineChangeGutter(changes) : [],
      ),
    });
  }, [activeFileChange, gitLineChanges, gitHeadContent]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || !isTextFile) return;
    view.dispatch({
      effects: selectionHighlightsCompartmentRef.current.reconfigure(
        isReviewDisplay
          ? []
          : createSelectionCaseAwareHighlights(isSearchOpen, isSearchOpen),
      ),
    });
  }, [isReviewDisplay, isSearchOpen, isTextFile]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || !isTextFile) return;
    const previewRange =
      selectionPreviewRange?.fileId === activeFileId
        ? {
            start: selectionPreviewRange.start,
            end: selectionPreviewRange.end,
          }
        : null;
    view.dispatch({
      effects: selectionChipPreviewCompartmentRef.current.reconfigure(
        createSelectionChipPreviewHighlight(
          previewRange,
          view.state.doc.length,
        ),
      ),
    });
  }, [activeFileId, isTextFile, selectionPreviewRange]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || !isTextFile) return;
    const commentsForDocument = isReviewDisplay
      ? []
      : activeFileDocumentComments;
    view.dispatch({
      effects: updateInlineCommentsEffect.of({
        comments: commentsForDocument,
        actions: {
          hidden: !displayComments || isReviewDisplay,
          historyScope:
            projectRoot && activeFile
              ? { root: projectRoot, filePath: activeFile.relativePath }
              : undefined,
          selectedCommentIds,
          onAttach:
            selectionAiEnabled && activeFile
              ? (comment) => {
                  const filter =
                    useSettingsStore.getState().editorCommentFilterByProject[
                      JSON.stringify(projectRoot)
                    ] ?? "all";
                  if (
                    filter === "all" ||
                    (filter === "agent") === !!comment.origin
                  ) {
                    setCommentNavigationSelection({
                      fileId: activeFile.id,
                      id: comment.id,
                    });
                  }
                  attachCommentToChat(
                    projectRoot,
                    activeFile.relativePath,
                    comment,
                  );
                }
              : undefined,
          onResize: activeFile
            ? (id, range) => {
                const filePath = activeFile.relativePath;
                setInlineCommentsByFile(
                  (current) => ({
                    ...current,
                    [filePath]: (current[filePath] ?? []).map((comment) =>
                      comment.id === id
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
              }
            : undefined,
          onSave: handleSaveInlineComment,
          onResolve: handleResolveInlineComment,
          onEdit: handleEditInlineComment,
          onDelete: handleDeleteInlineComment,
          onCancel: handleCancelInlineComment,
        },
      }),
    });
    const pendingCommentId = pendingInlineCommentCenterIdRef.current;
    if (!pendingCommentId) return;

    let frame = window.requestAnimationFrame(() => {
      const foundOnFirstFrame = centerInlineCommentCard(view, pendingCommentId);
      frame = window.requestAnimationFrame(() => {
        if (
          centerInlineCommentCard(view, pendingCommentId) ||
          foundOnFirstFrame
        ) {
          pendingInlineCommentCenterIdRef.current = null;
        }
      });
    });

    return () => window.cancelAnimationFrame(frame);
  }, [
    allActiveFileInlineComments,
    activeFileDocumentComments,
    displayComments,
    selectedCommentIds,
    editorReadyRevision,
    handleDeleteInlineComment,
    handleCancelInlineComment,
    handleEditInlineComment,
    handleResolveInlineComment,
    handleSaveInlineComment,
    projectRoot,
    activeFile?.relativePath,
    selectionAiEnabled,
    isReviewDisplay,
    isTextFile,
  ]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || !isTextFile) return;
    const previousPadding = searchPaddingRef.current;
    const nextPadding = isSearchOpen
      ? getSearchViewportPadding(view)
      : { top: 0, bottom: 0 };
    const searchPaddingExtension: Extension = isSearchOpen
      ? [
          searchViewportTheme,
          EditorView.editorAttributes.of({
            style: `--catalex-search-padding-top: ${nextPadding.top}px; --catalex-search-padding-bottom: ${nextPadding.bottom}px`,
          }),
        ]
      : [];
    view.dispatch({
      effects: searchPaddingCompartmentRef.current.reconfigure(
        searchPaddingExtension,
      ),
    });
    const nextScrollTop = Math.max(
      0,
      view.scrollDOM.scrollTop + (nextPadding.top - previousPadding.top),
    );
    view.scrollDOM.scrollTop = nextScrollTop;
    searchPaddingRef.current = nextPadding;
  }, [isSearchOpen, isTextFile]);

  const documentStatistics = useDocumentStatistics(activeFileContent ?? "");
  const editorTextStatistics = useMemo(() => {
    return {
      selectedWords: countMarkdownWords(editorSelectedText),
      selectedCharacters: countMarkdownCharacters(editorSelectedText),
      ...documentStatistics,
    };
  }, [documentStatistics, editorSelectedText]);

  const applyMarkdownInlineFormat = useCallback(
    (format: MarkdownInlineFormat) => {
      const view = viewRef.current;
      if (!view || !isMarkdownDocument) return;

      const { from, to } = view.state.selection.main;
      const selected = view.state.sliceDoc(from, to);

      if (format === "link") {
        const linkText = selected || "link text";
        const destination = "https://";
        const inserted = `[${linkText}](${destination})`;
        const selection = selected
          ? {
              anchor: from + linkText.length + 3,
              head: from + linkText.length + 3 + destination.length,
            }
          : { anchor: from + 1, head: from + 1 + linkText.length };
        view.dispatch({
          changes: { from, to, insert: inserted },
          selection,
          scrollIntoView: true,
          annotations: Transaction.userEvent.of("input"),
        });
        view.focus();
        return;
      }

      const marker =
        format === "bold"
          ? "**"
          : format === "italic"
            ? "_"
            : format === "strikethrough"
              ? "~~"
              : "`";
      const placeholder = format === "code" ? "code" : "text";
      const hasWrappingMarkers =
        selected.length > 0 &&
        from >= marker.length &&
        view.state.sliceDoc(from - marker.length, from) === marker &&
        view.state.sliceDoc(to, to + marker.length) === marker;

      if (hasWrappingMarkers) {
        view.dispatch({
          changes: [
            { from: from - marker.length, to: from, insert: "" },
            { from: to, to: to + marker.length, insert: "" },
          ],
          selection: {
            anchor: from - marker.length,
            head: to - marker.length,
          },
          scrollIntoView: true,
          annotations: Transaction.userEvent.of("input"),
        });
      } else {
        const innerText = selected || placeholder;
        view.dispatch({
          changes: {
            from,
            to,
            insert: `${marker}${innerText}${marker}`,
          },
          selection: {
            anchor: from + marker.length,
            head: from + marker.length + innerText.length,
          },
          scrollIntoView: true,
          annotations: Transaction.userEvent.of("input"),
        });
      }
      view.focus();
    },
    [isMarkdownDocument],
  );

  const applyMarkdownBlockFormat = useCallback(
    (format: MarkdownBlockFormat) => {
      const view = viewRef.current;
      if (!view || !isMarkdownDocument) return;

      const selection = view.state.selection.main;
      const startLine = view.state.doc.lineAt(selection.from);
      const endPosition =
        selection.to > selection.from &&
        view.state.doc.lineAt(selection.to).from === selection.to
          ? selection.to - 1
          : selection.to;
      const endLine = view.state.doc.lineAt(Math.max(0, endPosition));
      const lines = Array.from(
        { length: endLine.number - startLine.number + 1 },
        (_, index) => view.state.doc.line(startLine.number + index),
      );
      const changes: Array<{ from: number; to: number; insert: string }> = [];

      if (format === "paragraph" || format.startsWith("heading-")) {
        const headingLevel =
          format === "paragraph"
            ? 0
            : Number.parseInt(format.slice("heading-".length), 10);
        for (const line of lines) {
          const existingHeading = line.text.match(/^ {0,3}#{1,6}(?:[ \t]+|$)/);
          const insert = headingLevel > 0 ? `${"#".repeat(headingLevel)} ` : "";
          changes.push({
            from: line.from,
            to: line.from + (existingHeading?.[0].length ?? 0),
            insert,
          });
        }
      } else if (format === "blockquote") {
        const quoteMatches = lines.map((line) => line.text.match(/^(\s*)>\s?/));
        const removeQuotes = quoteMatches.every(Boolean);
        lines.forEach((line, index) => {
          const match = quoteMatches[index];
          const indentation = line.text.match(/^\s*/)?.[0] ?? "";
          if (removeQuotes && match) {
            changes.push({
              from: line.from + indentation.length,
              to: line.from + match[0].length,
              insert: "",
            });
          } else if (!match) {
            changes.push({
              from: line.from + indentation.length,
              to: line.from + indentation.length,
              insert: "> ",
            });
          }
        });
      } else {
        const listMatches = lines.map((line) =>
          line.text.match(
            /^(\s*)((?:[-+*][ \t]+\[[ xX]\])|[-+*]|\d+[.)])(?:[ \t]+|$)/,
          ),
        );
        const isOrdered = format === "ordered-list";
        const isChecklist = format === "checklist";
        const removeList = listMatches.every((match) => {
          if (!match) return false;
          if (isOrdered) return /^\d/.test(match[2]);
          if (isChecklist) return /^[-+*][ \t]+\[[ xX]\]$/.test(match[2]);
          return /^[-+*]$/.test(match[2]);
        });

        lines.forEach((line, index) => {
          const match = listMatches[index];
          const indentation = match?.[1] ?? line.text.match(/^\s*/)?.[0] ?? "";
          const markerFrom = line.from + indentation.length;
          const markerTo =
            line.from + (match?.[0].length ?? indentation.length);
          changes.push({
            from: markerFrom,
            to: markerTo,
            insert: removeList
              ? ""
              : isOrdered
                ? `${index + 1}. `
                : isChecklist
                  ? "- [ ] "
                  : "- ",
          });
        });
      }

      if (changes.length === 0) return;
      const changeSet = view.state.changes(changes);
      view.dispatch({
        changes: changeSet,
        selection: {
          anchor: changeSet.mapPos(selection.anchor, 1),
          head: changeSet.mapPos(selection.head, 1),
        },
        scrollIntoView: true,
        annotations: Transaction.userEvent.of("input"),
      });
      const { from, to } = view.state.selection.main;
      setEditorSelectedText(view.state.sliceDoc(from, to));
      window.setTimeout(() => view.focus(), 0);
    },
    [isMarkdownDocument],
  );

  const applyLatexInlineFormat = useCallback(
    (format: LatexInlineFormat) => {
      const view = viewRef.current;
      if (!view || !isLatexDocument) return;

      const { from, to } = view.state.selection.main;
      const selected = view.state.sliceDoc(from, to);

      if (format === "link") {
        const destination = "https://";
        const label = selected || "link text";
        const prefix = `\\href{${destination}}{`;
        const inserted = `${prefix}${label}}`;
        view.dispatch({
          changes: { from, to, insert: inserted },
          selection: selected
            ? {
                anchor: from + "\\href{".length,
                head: from + "\\href{".length + destination.length,
              }
            : {
                anchor: from + prefix.length,
                head: from + prefix.length + label.length,
              },
          scrollIntoView: true,
          annotations: Transaction.userEvent.of("input"),
        });
        view.focus();
        return;
      }

      const command =
        format === "bold"
          ? "textbf"
          : format === "italic"
            ? "textit"
            : format === "code"
              ? "texttt"
              : null;
      const prefix = command ? `\\${command}{` : "$";
      const suffix = command ? "}" : "$";
      const placeholder = format === "inline-math" ? "formula" : "text";
      const hasWrappingMarkers =
        selected.length > 0 &&
        from >= prefix.length &&
        view.state.sliceDoc(from - prefix.length, from) === prefix &&
        view.state.sliceDoc(to, to + suffix.length) === suffix;

      if (hasWrappingMarkers) {
        view.dispatch({
          changes: [
            { from: from - prefix.length, to: from, insert: "" },
            { from: to, to: to + suffix.length, insert: "" },
          ],
          selection: {
            anchor: from - prefix.length,
            head: to - prefix.length,
          },
          scrollIntoView: true,
          annotations: Transaction.userEvent.of("input"),
        });
      } else {
        const innerText = selected || placeholder;
        view.dispatch({
          changes: { from, to, insert: `${prefix}${innerText}${suffix}` },
          selection: {
            anchor: from + prefix.length,
            head: from + prefix.length + innerText.length,
          },
          scrollIntoView: true,
          annotations: Transaction.userEvent.of("input"),
        });
      }
      view.focus();
    },
    [isLatexDocument],
  );

  const applyLatexBlockFormat = useCallback(
    (format: LatexBlockFormat) => {
      const view = viewRef.current;
      if (!view || !isLatexDocument) return;

      const { from, to } = view.state.selection.main;
      const selected = view.state.sliceDoc(from, to);

      if (
        format === "part" ||
        format === "chapter" ||
        format === "section" ||
        format === "subsection" ||
        format === "subsubsection" ||
        format === "paragraph" ||
        format === "subparagraph"
      ) {
        const title = selected || "Title";
        const prefix = `\\${format}{`;
        view.dispatch({
          changes: { from, to, insert: `${prefix}${title}}` },
          selection: {
            anchor: from + prefix.length,
            head: from + prefix.length + title.length,
          },
          scrollIntoView: true,
          annotations: Transaction.userEvent.of("input"),
        });
        window.setTimeout(() => view.focus(), 0);
        return;
      }

      const environment =
        format === "quote"
          ? "quote"
          : format === "unordered-list"
            ? "itemize"
            : "enumerate";
      const source = selected || (format === "quote" ? "Quote" : "Item");
      const body =
        format === "quote"
          ? source
          : source
              .split("\n")
              .map((line) => `\\item ${line}`)
              .join("\n");
      const prefix = `\\begin{${environment}}\n`;
      const suffix = `\n\\end{${environment}}`;
      view.dispatch({
        changes: { from, to, insert: `${prefix}${body}${suffix}` },
        selection: {
          anchor: from + prefix.length + (format === "quote" ? 0 : 6),
          head:
            from +
            prefix.length +
            (selected ? body.length : format === "quote" ? source.length : 10),
        },
        scrollIntoView: true,
        annotations: Transaction.userEvent.of("input"),
      });
      window.setTimeout(() => view.focus(), 0);
    },
    [isLatexDocument],
  );

  const isWholeFileReview =
    !!activeFileChange && (activeFileChange.binary || !isTextFile);
  const isPdf = activeFile?.type === "pdf";
  const isImage = activeFile?.type === "image";
  const isFilePreview = !isTextFile && !isPdf && !!activeFile;
  const canShowProblems =
    !isPdf &&
    !isFilePreview &&
    !isLargeFileNotLoaded &&
    !isReviewDisplay &&
    problemDiagnostics.length > 0;
  const canShowComments =
    !isPdf &&
    !isFilePreview &&
    !isLargeFileNotLoaded &&
    !isReviewDisplay &&
    allActiveFileInlineComments.length > 0;
  const problemsSummary = (
    <div className="flex shrink-0 items-center gap-1">
      <ProblemsMotion
        kind="button"
        open={canShowProblems && !problemsPanelOpen}
      >
        <div className="flex items-center">
          <div
            aria-hidden="true"
            className="mx-1 h-4 w-px shrink-0 bg-border"
          />
          <ProblemsSummaryButton
            diagnostics={problemDiagnostics}
            onOpen={() => {
              setProblemsPanelOpen(true);
              setCommentsPanelOpen(false);
            }}
          />
        </div>
      </ProblemsMotion>
      <ProblemsMotion
        kind="button"
        open={canShowComments && !commentsPanelOpen}
      >
        <div className="flex items-center">
          <div
            aria-hidden="true"
            className="mx-1 h-4 w-px shrink-0 bg-border"
          />
          <CommentsSummaryButton
            comments={allActiveFileInlineComments}
            onOpen={() => {
              setCommentsPanelOpen(true);
              setProblemsPanelOpen(false);
            }}
          />
        </div>
      </ProblemsMotion>
    </div>
  );
  const canEnableFindInSelection = !!selectionRangeForSearch;
  const canToggleFindInSelection =
    searchState.findInSelection || canEnableFindInSelection;
  const canReplace =
    !!searchState.findText && searchQueryObject.valid && matchCount > 0;
  const showToolbar = !suppressToolbar;
  const toolbarNode = showToolbar ? <EditorToolbar /> : null;
  const shouldRenderInlineToolbar =
    showToolbar && (!useGlobalToolbar || !globalToolbarTarget);

  return (
    <div
      className="flex h-full min-h-0 flex-col bg-background"
      onKeyDownCapture={(event) => {
        if (!isSearchOpen || !canCloseSearchOnEscape(event.nativeEvent)) return;
        const target = event.target as Element;
        if (
          target.closest(
            "[data-chat-drawer-overlay], [data-chat-composer-input]",
          )
        )
          return;
        event.preventDefault();
        event.stopPropagation();
        closeSearch();
      }}
    >
      {activeFile?.externalChange &&
        !activeFileChange &&
        !activeGitConflict && (
          <div
            data-external-file-review="true"
            className="flex flex-wrap items-center gap-2 border-border border-b bg-muted/50 px-3 py-2 text-sm"
          >
            <span className="mr-auto font-medium">
              {activeFile.externalChange.disk === null
                ? "File deleted on disk"
                : "File changed on disk"}
            </span>
            <span className="text-muted-foreground text-xs">
              Your text is preserved. Autosave is paused.
            </span>
            <button
              type="button"
              disabled={isResolvingGitConflict}
              className="rounded border px-2 py-1 hover:bg-background"
              onClick={() => void settleExternal(activeFile.content ?? "")}
            >
              {activeFile.externalChange.disk === null
                ? "Restore my file"
                : "Keep my version"}
            </button>
            <button
              type="button"
              disabled={isResolvingGitConflict}
              className="rounded border px-2 py-1 hover:bg-background"
              onClick={() =>
                void settleExternal(activeFile.externalChange!.disk)
              }
            >
              {activeFile.externalChange.disk === null
                ? "Close deleted file"
                : "Use disk version"}
            </button>
            {activeFile.externalChange.disk !== null && (
              <button
                type="button"
                disabled={isResolvingGitConflict}
                className="rounded bg-primary px-2 py-1 text-primary-foreground"
                onClick={() =>
                  void settleExternal(
                    viewRef.current?.state.doc.toString() ??
                      activeFile.content ??
                      "",
                  )
                }
              >
                Save reviewed version
              </button>
            )}
            {gitConflictError && (
              <span role="alert" className="w-full text-destructive text-xs">
                {gitConflictError}
              </span>
            )}
          </div>
        )}
      {/* Toolbar — adapts to file type */}
      {shouldRenderInlineToolbar ? toolbarNode : null}
      {!shouldRenderInlineToolbar && toolbarNode && globalToolbarTarget
        ? createPortal(toolbarNode, globalToolbarTarget)
        : null}
      <WorkspacePanel
        data-drawer-shell="true"
        data-workspace-panel-screen="true"
        className={`flex flex-1 flex-col ${
          showToolbar && !useGlobalToolbar ? "mt-2" : ""
        }`}
      >
        {isMarkdownDocument && !reviewingSnapshot ? (
          <MarkdownEditorHeader
            selectedWords={editorTextStatistics.selectedWords}
            selectedCharacters={editorTextStatistics.selectedCharacters}
            wordCount={editorTextStatistics.wordCount}
            characterCount={editorTextStatistics.characterCount}
            trailingContent={problemsSummary}
            onInlineFormat={applyMarkdownInlineFormat}
            onBlockFormat={applyMarkdownBlockFormat}
          />
        ) : null}
        {isLatexDocument && !reviewingSnapshot ? (
          <LatexEditorHeader
            selectedWords={editorTextStatistics.selectedWords}
            selectedCharacters={editorTextStatistics.selectedCharacters}
            wordCount={editorTextStatistics.wordCount}
            characterCount={editorTextStatistics.characterCount}
            trailingContent={problemsSummary}
            onInlineFormat={applyLatexInlineFormat}
            onBlockFormat={applyLatexBlockFormat}
          />
        ) : null}
        {(!(isMarkdownDocument || isLatexDocument) || reviewingSnapshot) && (
          <ProblemsMotion
            kind="bar"
            open={
              (canShowProblems && !problemsPanelOpen) ||
              (canShowComments && !commentsPanelOpen)
            }
          >
            <div className="flex h-12 shrink-0 items-center justify-end border-border border-b bg-background px-2">
              {problemsSummary}
            </div>
          </ProblemsMotion>
        )}
        {/* Text-editor-only panels */}
        {!isPdf &&
          !isFilePreview &&
          !isLargeFileNotLoaded &&
          reviewingSnapshot && (
            <div className="flex h-9 shrink-0 items-center justify-between border-border border-b bg-amber-500/10 px-3">
              <div className="flex items-center gap-2 text-xs">
                <RotateCcwIcon className="size-3.5 text-amber-600 dark:text-amber-400" />
                <span className="font-medium text-amber-700 dark:text-amber-300">
                  Reviewing history
                </span>
                <span className="text-muted-foreground">
                  {reviewingSnapshot.message.replace(/^\[.*?\]\s*/, "")}{" "}
                  &middot; {reviewingSnapshot.id.slice(0, 7)}
                </span>
              </div>
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 gap-1 px-2 text-xs"
                  onClick={handleHistoryRestore}
                >
                  <RotateCcwIcon className="size-3" />
                  Restore
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 gap-1 px-2 text-xs"
                  onClick={() => {
                    setHistoryLabelDialogOpen(true);
                    setHistoryLabelValue("");
                  }}
                >
                  <TagIcon className="size-3" />
                  Label
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 gap-1 px-2 text-xs"
                  onClick={handleHistoryCopySha}
                >
                  <CopyIcon className="size-3" />
                  SHA
                </Button>
                <div className="mx-0.5 h-4 w-px bg-border" />
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-6"
                  onClick={handleHistoryClose}
                >
                  <XIcon className="size-3.5" />
                </Button>
              </div>
            </div>
          )}
        {!isPdf &&
          !isFilePreview &&
          !isLargeFileNotLoaded &&
          (activeGitConflict || activeGitDeletionConflict) && (
            <GitConflictPanel
              threeWay={!!activeGitConflict?.conflictContents}
              ancestorContent={
                activeGitConflict
                  ? activeGitConflict.ancestorContent
                  : (activeGitDeletionConflict?.ancestor?.text ?? undefined)
              }
              onUseStarting={
                activeGitConflict?.conflictContents
                  ? useStartingRegions
                  : activeGitConflict
                    ? useGitStartingFile
                    : activeGitDeletionConflict
                      ? () => void resolveGitDeletionConflict("ancestor")
                      : undefined
              }
              currentDeleted={
                activeGitDeletionConflict
                  ? !activeGitDeletionConflict.current
                  : false
              }
              incomingDeleted={
                activeGitDeletionConflict
                  ? !activeGitDeletionConflict.incoming
                  : false
              }
              mergeChunkInfo={
                activeGitDeletionConflict
                  ? { total: 0, current: 0 }
                  : mergeChunkInfo
              }
              resolving={isResolvingGitConflict}
              error={gitConflictError}
              onPreviousChunk={() =>
                goToChunk(
                  mergeChunkInfo.current <= 1
                    ? mergeChunkInfo.total - 1
                    : mergeChunkInfo.current - 2,
                )
              }
              onNextChunk={() =>
                goToChunk(
                  mergeChunkInfo.current >= mergeChunkInfo.total
                    ? 0
                    : mergeChunkInfo.current,
                )
              }
              onAcceptIncoming={() => handleKeepAllRef.current()}
              onKeepCurrent={() => handleUndoAllRef.current()}
            />
          )}
        {!isWholeFileReview &&
          !isPdf &&
          !isFilePreview &&
          !isLargeFileNotLoaded &&
          !activeGitConflict &&
          activeFileChange &&
          renderReviewToolbar(
            <ProposedChangesPanel
              threeWay={!!activeFileChange.conflictContents}
              onUseStarting={useStartingRegions}
              showChunkNavigation={!reviewToolbarTarget}
              change={activeFileChange}
              mergeChunkInfo={mergeChunkInfo}
              onPreviousChunk={() =>
                goToChunk(
                  mergeChunkInfo.current <= 1
                    ? mergeChunkInfo.total - 1
                    : mergeChunkInfo.current - 2,
                )
              }
              onNextChunk={() =>
                goToChunk(
                  mergeChunkInfo.current >= mergeChunkInfo.total
                    ? 0
                    : mergeChunkInfo.current,
                )
              }
              onKeep={() => handleKeepAllRef.current()}
              onUndo={() => handleUndoAllRef.current()}
              settlementError={workspaceSettlementError}
            />,
          )}
        <ProblemsMotion
          kind="bar"
          open={
            (canShowProblems && problemsPanelOpen) ||
            (canShowComments && commentsPanelOpen)
          }
        >
          <div hidden={commentsPanelOpen}>
            <ProblemsPanel
              navigationSelection={
                minimapProblemSelection?.fileId === activeFileId
                  ? minimapProblemSelection
                  : undefined
              }
              onClose={() => setProblemsPanelOpen(false)}
              diagnostics={problemDiagnostics}
              onFixAllWithChat={
                showSidecarUi
                  ? (filteredDiagnostics) => {
                      const fileName = activeFile?.relativePath ?? "main.tex";
                      const problems = filteredDiagnostics
                        .map(
                          (diagnostic) =>
                            `- ${fileName}${diagnostic.line === null ? " (last compile)" : `:${diagnostic.line}`} — ${diagnostic.message}`,
                        )
                        .join("\n");
                      useAgentChatStore
                        .getState()
                        .sendPrompt(
                          `[Problems in ${fileName}]\n${problems}\n\nFix all these problems.`,
                        );
                    }
                  : undefined
              }
              fileName={activeFile?.relativePath ?? "main.tex"}
              onNavigate={(from) => {
                const view = viewRef.current;
                if (!view) return;
                view.dispatch({
                  selection: { anchor: from },
                  effects: EditorView.scrollIntoView(from, { y: "center" }),
                });
                view.focus();
              }}
            />
          </div>
          <div hidden={!commentsPanelOpen}>
            <CommentsPanel
              navigationSelection={
                commentNavigationSelection?.fileId === activeFileId
                  ? commentNavigationSelection
                  : undefined
              }
              key={activeFile?.relativePath}
              comments={allActiveFileInlineComments}
              filter={commentFilter}
              onFilter={setCommentFilter}
              onClose={() => setCommentsPanelOpen(false)}
              onNavigate={(comment) => {
                const view = viewRef.current;
                if (!view) return;
                if (selectionAiEnabled && activeFile && !comment.isEditing) {
                  attachCommentToChat(
                    projectRoot,
                    activeFile.relativePath,
                    comment,
                  );
                }
                const from = Math.max(
                  0,
                  Math.min(comment.from, view.state.doc.length),
                );
                scrollToEditorPosition(view, from, comment.id);
              }}
            />
          </div>
        </ProblemsMotion>
        {/* Main content area */}
        <div
          ref={
            isWholeFileReview || isPdf || isFilePreview ? undefined : parentRef
          }
          data-drawer-host="true"
          className="relative flex min-h-0 flex-1 flex-col overflow-hidden"
        >
          {isWholeFileReview && agentFileReviewContent}
          {activeGitFileConflict && currentConflictContent}
          {/* PDF content */}
          {!isWholeFileReview &&
            !activeGitFileConflict &&
            isPdf &&
            activeFile && (
              <InlinePdfContent
                file={activeFile}
                aiEnabled={selectionAiEnabled}
              />
            )}
          {/* Image content */}
          {!isWholeFileReview &&
            !activeGitFileConflict &&
            isImage &&
            activeFile && (
              <ImagePreview
                file={activeFile}
                scale={imageScale}
                onScaleChange={setImageScale}
                cropMode={cropMode}
                onCropModeChange={setCropMode}
              />
            )}
          {!isWholeFileReview &&
            !activeGitFileConflict &&
            isFilePreview &&
            !isImage &&
            activeFile && <FilePreview file={activeFile} />}
          {/* Large file warning */}
          {!isWholeFileReview &&
            !activeGitFileConflict &&
            isLargeFileNotLoaded &&
            activeFile && (
              <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
                <div className="max-w-md rounded-lg border border-border bg-card/50 p-6 shadow-sm">
                  <p className="mb-1 font-medium text-foreground text-sm">
                    {activeFile.name}
                  </p>
                  <p className="mb-4 text-muted-foreground text-xs">
                    This file is large (
                    {activeFile.fileSize != null
                      ? `${(activeFile.fileSize / (1024 * 1024)).toFixed(1)} MB`
                      : "unknown size"}
                    ). Opening it may slow down the editor.
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => loadFileContent(activeFile.id)}
                  >
                    Open Anyway
                  </Button>
                </div>
              </div>
            )}
          {/* Text editor content */}
          {!isWholeFileReview &&
            !activeGitFileConflict &&
            !isPdf &&
            !isFilePreview &&
            !isLargeFileNotLoaded && (
              <>
                {isSearchPanelRendered && (
                  <div
                    className={cn(
                      "pointer-events-none absolute inset-x-0 top-3 z-30 flex justify-center px-4 transition-transform",
                      isSearchPanelVisible
                        ? "translate-y-0"
                        : "-translate-y-[calc(100%+20px)]",
                    )}
                    style={{
                      transitionDuration: `${SEARCH_PANEL_ANIMATION_MS}ms`,
                      transitionTimingFunction: SEARCH_PANEL_ANIMATION_EASE,
                    }}
                  >
                    <SearchPanel
                      findText={searchState.findText}
                      replaceText={searchState.replaceText}
                      isReplaceOpen={searchState.showReplace}
                      isCaseSensitive={searchState.caseSensitive}
                      isWholeWord={searchState.wholeWord}
                      isRegex={searchState.useRegex}
                      preserveCase={searchState.preserveCase}
                      findInSelection={searchState.findInSelection}
                      canEnableFindInSelection={canToggleFindInSelection}
                      isQueryValid={searchQueryObject.valid}
                      canReplace={canReplace}
                      onFindTextChange={(findText) => {
                        setFindHistoryIndex(-1);
                        findHistoryDraftRef.current = "";
                        setSearchState((prev) => ({ ...prev, findText }));
                      }}
                      onReplaceTextChange={(replaceText) => {
                        setReplaceHistoryIndex(-1);
                        replaceHistoryDraftRef.current = "";
                        setSearchState((prev) => ({ ...prev, replaceText }));
                      }}
                      onToggleReplace={() =>
                        setSearchState((prev) => ({
                          ...prev,
                          showReplace: !prev.showReplace,
                        }))
                      }
                      onToggleCaseSensitive={() =>
                        setSearchState((prev) => ({
                          ...prev,
                          caseSensitive: !prev.caseSensitive,
                        }))
                      }
                      onToggleWholeWord={() =>
                        setSearchState((prev) => ({
                          ...prev,
                          wholeWord: !prev.wholeWord,
                        }))
                      }
                      onToggleRegex={() =>
                        setSearchState((prev) => ({
                          ...prev,
                          useRegex: !prev.useRegex,
                        }))
                      }
                      onTogglePreserveCase={() =>
                        setSearchState((prev) => ({
                          ...prev,
                          preserveCase: !prev.preserveCase,
                        }))
                      }
                      onToggleFindInSelection={() => {
                        setSearchState((prev) => {
                          if (prev.findInSelection) {
                            setSearchScopeRange(null);
                            return { ...prev, findInSelection: false };
                          }
                          if (!selectionRangeForSearch) return prev;
                          setSearchScopeRange(selectionRangeForSearch);
                          return { ...prev, findInSelection: true };
                        });
                      }}
                      onHistoryNavigate={navigateHistory}
                      onClose={closeSearch}
                      onFindNext={handleFindNext}
                      onFindPrevious={handleFindPrevious}
                      onReplaceNext={handleReplaceNext}
                      onReplaceAll={handleReplaceAll}
                      commentRange={searchScopeRange}
                      matchCount={matchCount}
                      currentMatch={currentMatch}
                    />
                  </div>
                )}
                <div
                  ref={containerRef}
                  className={
                    reviewingSnapshot
                      ? "hidden"
                      : showEditorMinimap && viewRef.current
                        ? "editor-with-minimap absolute inset-y-0 right-9 left-0"
                        : "absolute inset-0"
                  }
                />
                {showEditorMinimap && !reviewingSnapshot && viewRef.current && (
                  <EditorMinimap
                    key={`${activeFileId}:${editorReadyRevision}`}
                    view={viewRef.current}
                    gitChanges={gitLineChanges}
                    gitHeadContent={gitHeadContent}
                    comments={
                      activeMergeChange ? [] : allActiveFileInlineComments
                    }
                    diagnostics={problemDiagnostics}
                    isConflict={
                      !!activeGitConflict || !!activeGitDeletionConflict
                    }
                    onNavigateMarkers={(markers) => {
                      const commentMarker = markers.find((marker) => {
                        const comment = allActiveFileInlineComments.find(
                          (item) => item.id === marker.commentId,
                        );
                        return (
                          comment &&
                          (commentFilter === "all" ||
                            (commentFilter === "agent") === !!comment.origin)
                        );
                      });
                      if (commentMarker?.commentId) {
                        setCommentNavigationSelection({
                          fileId: activeFileId,
                          id: commentMarker.commentId,
                        });
                      }
                      const diagnostics = markers.flatMap((marker) => {
                        const diagnostic =
                          marker.diagnosticIndex === undefined
                            ? undefined
                            : problemDiagnostics[marker.diagnosticIndex];
                        return diagnostic ? [diagnostic] : [];
                      });
                      if (diagnostics.length) {
                        setMinimapProblemSelection({
                          fileId: activeFileId,
                          diagnostics,
                        });
                      }
                    }}
                  />
                )}
                {reviewingSnapshot && historyDiffResult && (
                  <HistoryDiffView diffs={historyDiffResult} />
                )}
                {toolbarPosition &&
                  selectionLabel &&
                  !isReviewDisplay &&
                  !isSearchOpen && (
                    <SelectionToolbar
                      position={toolbarPosition}
                      getAnchor={getToolbarAnchor}
                      contextLabel={selectionLabel}
                      actions={editorToolbarActions}
                      aiEnabled={selectionAiEnabled}
                      onAction={handleToolbarAction}
                      onDismiss={handleToolbarDismiss}
                    />
                  )}
              </>
            )}
        </div>
      </WorkspacePanel>
      {/* History label dialog */}
      <Dialog
        open={historyLabelDialogOpen}
        onOpenChange={setHistoryLabelDialogOpen}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Add Label</DialogTitle>
          </DialogHeader>
          <div className="py-4">
            <Input
              placeholder="e.g. Draft v1"
              value={historyLabelValue}
              onChange={(e) => setHistoryLabelValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleHistoryAddLabel();
              }}
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setHistoryLabelDialogOpen(false)}
            >
              Cancel
            </Button>
            <Button
              onClick={handleHistoryAddLabel}
              disabled={!historyLabelValue.trim()}
            >
              Add
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── Inline PDF Content (data loading + MuPDF PdfViewer) ───

function InlinePdfContent({
  file,
  aiEnabled,
}: {
  file: ProjectFile;
  aiEnabled: boolean;
}) {
  const [pdfData, setPdfData] = useState<PdfSource | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setPdfData(null);
    setError(null);

    openPdfSource(file.absolutePath)
      .then((data) => {
        if (!cancelled) setPdfData(data);
      })
      .catch((err) => {
        if (!cancelled) setError(String(err));
      });

    return () => {
      cancelled = true;
    };
  }, [file.absolutePath, file.diskModifiedAt]);

  if (pdfData) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <PdfPreview
          aiEnabled={aiEnabled}
          standalonePdfData={pdfData}
          standaloneRootFileId={file.id}
        />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
        Failed to load PDF: {error}
      </div>
    );
  }

  return (
    <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
      Loading PDF...
    </div>
  );
}

// ─── History Diff View (git-diff style combined view) ───

function HistoryDiffView({ diffs }: { diffs: FileDiff[] }) {
  return (
    <div className="app-scrollbar absolute inset-0 overflow-y-auto bg-background font-mono text-xs leading-relaxed">
      {diffs.map((diff) => (
        <div key={diff.file_path} className="border-border border-b">
          {/* File header */}
          <div className="sticky top-0 z-10 flex items-center gap-2 border-border border-b bg-muted/80 px-4 py-1.5 backdrop-blur-sm">
            <span
              className={
                diff.status === "added"
                  ? "font-bold text-green-600 dark:text-green-400"
                  : diff.status === "deleted"
                    ? "font-bold text-red-600 dark:text-red-400"
                    : "font-bold text-blue-600 dark:text-blue-400"
              }
            >
              {diff.status === "added"
                ? "+"
                : diff.status === "deleted"
                  ? "−"
                  : "~"}
            </span>
            <span className="font-medium text-foreground">
              {diff.file_path}
            </span>
            <span className="text-muted-foreground">({diff.status})</span>
          </div>
          {/* Diff lines */}
          <DiffLines diff={diff} />
        </div>
      ))}
      {diffs.length === 0 && (
        <div className="flex h-full items-center justify-center text-muted-foreground">
          No changes in this snapshot
        </div>
      )}
    </div>
  );
}

function DiffLines({ diff }: { diff: FileDiff }) {
  const oldLines = diff.old_content?.split("\n") ?? [];
  const newLines = diff.new_content?.split("\n") ?? [];

  if (diff.status === "added") {
    return (
      <div className="px-1">
        {newLines.map((line, i) => (
          <div key={i} className="flex bg-green-500/10">
            <span className="w-12 shrink-0 select-none pr-2 text-right text-green-500/50">
              {i + 1}
            </span>
            <span className="mr-1 select-none text-green-500/50">+</span>
            <span className="text-green-700 dark:text-green-400">
              {line || " "}
            </span>
          </div>
        ))}
      </div>
    );
  }

  if (diff.status === "deleted") {
    return (
      <div className="px-1">
        {oldLines.map((line, i) => (
          <div key={i} className="flex bg-red-500/10">
            <span className="w-12 shrink-0 select-none pr-2 text-right text-red-500/50">
              {i + 1}
            </span>
            <span className="mr-1 select-none text-red-500/50">−</span>
            <span className="text-red-700 dark:text-red-400">
              {line || " "}
            </span>
          </div>
        ))}
      </div>
    );
  }

  // Modified: compute unified diff with context
  const hunks = computeUnifiedHunks(oldLines, newLines, 3);

  return (
    <div className="px-1">
      {hunks.map((hunk, hi) => (
        <div key={hi}>
          {/* Hunk header */}
          <div className="bg-blue-500/10 px-1 text-blue-600 dark:text-blue-400">
            @@ -{hunk.oldStart},{hunk.oldCount} +{hunk.newStart},{hunk.newCount}{" "}
            @@
          </div>
          {hunk.lines.map((line, li) => (
            <div
              key={li}
              className={
                line.type === "del"
                  ? "flex bg-red-500/10"
                  : line.type === "add"
                    ? "flex bg-green-500/10"
                    : "flex"
              }
            >
              <span
                className={`w-12 shrink-0 select-none pr-2 text-right ${
                  line.type === "del"
                    ? "text-red-500/50"
                    : line.type === "add"
                      ? "text-green-500/50"
                      : "text-muted-foreground/50"
                }`}
              >
                {line.type !== "add" ? line.oldNum : ""}
              </span>
              <span
                className={`w-12 shrink-0 select-none pr-2 text-right ${
                  line.type === "del"
                    ? "text-red-500/50"
                    : line.type === "add"
                      ? "text-green-500/50"
                      : "text-muted-foreground/50"
                }`}
              >
                {line.type !== "del" ? line.newNum : ""}
              </span>
              <span
                className={`mr-1 select-none ${
                  line.type === "del"
                    ? "text-red-500/50"
                    : line.type === "add"
                      ? "text-green-500/50"
                      : "text-muted-foreground/30"
                }`}
              >
                {line.type === "del" ? "−" : line.type === "add" ? "+" : " "}
              </span>
              <span
                className={
                  line.type === "del"
                    ? "text-red-700 dark:text-red-400"
                    : line.type === "add"
                      ? "text-green-700 dark:text-green-400"
                      : "text-muted-foreground"
                }
              >
                {line.text || " "}
              </span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

interface DiffLine {
  type: "ctx" | "del" | "add";
  text: string;
  oldNum?: number;
  newNum?: number;
}

interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: DiffLine[];
}

function computeUnifiedHunks(
  oldLines: string[],
  newLines: string[],
  context: number,
): Hunk[] {
  // Simple line-by-line diff to find changed regions
  const ops: {
    type: "eq" | "del" | "add";
    oldIdx?: number;
    newIdx?: number;
    text: string;
  }[] = [];
  let i = 0;
  let j = 0;

  while (i < oldLines.length || j < newLines.length) {
    if (
      i < oldLines.length &&
      j < newLines.length &&
      oldLines[i] === newLines[j]
    ) {
      ops.push({ type: "eq", oldIdx: i, newIdx: j, text: oldLines[i] });
      i++;
      j++;
    } else {
      // Find the next matching line
      let foundOld = -1;
      let foundNew = -1;
      const searchLimit = Math.min(
        50,
        Math.max(oldLines.length - i, newLines.length - j),
      );
      for (let look = 1; look <= searchLimit; look++) {
        if (
          i + look < oldLines.length &&
          j < newLines.length &&
          oldLines[i + look] === newLines[j]
        ) {
          foundOld = i + look;
          break;
        }
        if (
          j + look < newLines.length &&
          i < oldLines.length &&
          newLines[j + look] === oldLines[i]
        ) {
          foundNew = j + look;
          break;
        }
      }

      if (foundOld >= 0) {
        // Delete lines from old until match
        while (i < foundOld) {
          ops.push({ type: "del", oldIdx: i, text: oldLines[i] });
          i++;
        }
      } else if (foundNew >= 0) {
        // Add lines from new until match
        while (j < foundNew) {
          ops.push({ type: "add", newIdx: j, text: newLines[j] });
          j++;
        }
      } else {
        // No match found nearby, emit del+add
        if (i < oldLines.length) {
          ops.push({ type: "del", oldIdx: i, text: oldLines[i] });
          i++;
        }
        if (j < newLines.length) {
          ops.push({ type: "add", newIdx: j, text: newLines[j] });
          j++;
        }
      }
    }
  }

  // Group into hunks with context lines
  const changedIndices = new Set<number>();
  ops.forEach((op, idx) => {
    if (op.type !== "eq") {
      for (
        let c = Math.max(0, idx - context);
        c <= Math.min(ops.length - 1, idx + context);
        c++
      ) {
        changedIndices.add(c);
      }
    }
  });

  const hunks: Hunk[] = [];
  let currentHunk: Hunk | null = null;

  for (let idx = 0; idx < ops.length; idx++) {
    if (!changedIndices.has(idx)) {
      if (currentHunk) {
        hunks.push(currentHunk);
        currentHunk = null;
      }
      continue;
    }

    const op = ops[idx];
    if (!currentHunk) {
      const oldStart =
        op.type !== "add"
          ? (op.oldIdx ?? 0) + 1
          : (ops[idx + 1]?.oldIdx ?? 0) + 1;
      const newStart =
        op.type !== "del"
          ? (op.newIdx ?? 0) + 1
          : (ops[idx + 1]?.newIdx ?? 0) + 1;
      currentHunk = { oldStart, oldCount: 0, newStart, newCount: 0, lines: [] };
    }

    if (op.type === "eq") {
      currentHunk.lines.push({
        type: "ctx",
        text: op.text,
        oldNum: (op.oldIdx ?? 0) + 1,
        newNum: (op.newIdx ?? 0) + 1,
      });
      currentHunk.oldCount++;
      currentHunk.newCount++;
    } else if (op.type === "del") {
      currentHunk.lines.push({
        type: "del",
        text: op.text,
        oldNum: (op.oldIdx ?? 0) + 1,
      });
      currentHunk.oldCount++;
    } else {
      currentHunk.lines.push({
        type: "add",
        text: op.text,
        newNum: (op.newIdx ?? 0) + 1,
      });
      currentHunk.newCount++;
    }
  }
  if (currentHunk) hunks.push(currentHunk);

  return hunks;
}
