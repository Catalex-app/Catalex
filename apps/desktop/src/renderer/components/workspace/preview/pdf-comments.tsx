import { pdfFileCommentRegions } from "./pdf-file-comments";
import { canHandleEscape, consumeKey } from "@/lib/keyboard-events";
import {
  COMMENT_SEARCH_NAVIGATE_EVENT,
  type CommentSearchNavigation,
} from "@/lib/workspace-events";
import {
  getActiveComment,
  setActiveComment,
  subscribeActiveComment,
} from "../editor/active-comment";
import { CommentRangeHandle } from "./comment-range-handle";
import {
  pdfCommentEndpoint,
  pdfOffsetAtPoint,
  pdfPageOffsetAtPoint,
} from "./pdf-comment-resize";
import type { PdfSource } from "@/lib/mupdf/pdf-source";
import type { PdfTextPoint } from "@/lib/mupdf/pdf-comment-passage";
import {
  usePdfFileCommentResize,
  type ResizePdfComment,
} from "./use-pdf-file-comment-resize";
import {
  resizeCommentRange,
  type CommentRange,
  type CommentRangeEdge,
} from "../editor/comment-range";
import { CHAT_DRAWER_MAX_WIDTH } from "@/lib/chat-layout";
import { Hint } from "@/components/ui/tooltip";
import {
  PDF_TEXT_GAP,
  pdfCommentVisibleText,
  normalizePdfCommentText as normalized,
} from "./pdf-comment-text";
import {
  PDF_COMMENT_LAYOUT_EVENT,
  type PdfCommentLayoutChange,
} from "@/lib/workspace-events";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  useRef,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { InlineCommentCard } from "../editor/inline-comment-card";
import type { InlineCommentActions } from "../editor/inline-comments";
import type {
  PdfCommentSourceBox,
  createPdfCommentLookup,
} from "./pdf-comment-lookup";
import type { StructuredTextData, StructuredTextLine } from "@/lib/mupdf/types";
import type { ProjectFile } from "@/stores/document-store";
import type { InlineCommentsByFile } from "../editor/inline-comment-storage";
import type { InlineEditorComment } from "../editor/inline-comments";

const PDF_COMMENT_MARGIN = 24;

export interface PdfCommentTarget {
  filePath: string;
  comment: InlineEditorComment;
  firstLine: number;
  lastLine: number;
  sourceText: string;
  sourceContent?: string;
  sourceBefore: string;
  sourceAfter: string;
}

// Newline offsets are shared by all targets in this file for this calculation.
function sourceLineLookup(content: string) {
  const newlines: number[] = [];
  for (
    let at = content.indexOf("\n");
    at !== -1;
    at = content.indexOf("\n", at + 1)
  ) {
    newlines.push(at);
  }
  return (offset: number) => {
    let low = 0;
    let high = newlines.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (newlines[middle] < offset) low = middle + 1;
      else high = middle;
    }
    return low + 1;
  };
}

export function pdfCommentTargets(
  files: ProjectFile[],
  comments: InlineCommentsByFile,
): PdfCommentTarget[] {
  return files.flatMap((file) => {
    const content = file.content;
    if (content == null) return [];
    let lineAt: ReturnType<typeof sourceLineLookup> | undefined;
    return (comments[file.relativePath] ?? []).flatMap((comment) => {
      if (
        comment.pdf ||
        comment.resolved ||
        (!comment.text.trim() && !comment.isEditing) ||
        comment.from < 0 ||
        comment.to > content.length
      )
        return [];
      const end = Math.max(comment.from, comment.to - 1);
      lineAt ??= sourceLineLookup(content);
      return [
        {
          filePath: file.relativePath,
          comment,
          firstLine: lineAt(comment.from),
          lastLine: lineAt(end),
          sourceText: content.slice(comment.from, comment.to),
          sourceContent: content,
          sourceBefore: content.slice(
            Math.max(0, comment.from - 256),
            comment.from,
          ),
          sourceAfter: content.slice(comment.to, comment.to + 256),
        },
      ];
    });
  });
}

/** Match the selected source within a rendered line, including wrapped edges. */
export function pdfCommentTextRange(
  source: string,
  rendered: string,
  context?: { sourceBefore: string; sourceAfter: string },
): [number, number] | null {
  const visibleSource = pdfCommentVisibleText(source);
  if (visibleSource == null) return null;
  const ranges = visibleSource.split(PDF_TEXT_GAP).flatMap((part) => {
    const range = literalTextRange(part, rendered);
    if (range) return [range];
    // A missing font glyph must not discard all the surrounding prose. Keep
    // independently verifiable text on either side of a non-rendered symbol.
    const fragments = [...part]
      .map((char) =>
        char.codePointAt(0)! > 127 &&
        /\p{S}/u.test(char) &&
        !rendered.includes(char)
          ? PDF_TEXT_GAP
          : char,
      )
      .join("")
      .split(PDF_TEXT_GAP);
    return fragments.length > 1
      ? fragments.flatMap((fragment) => {
          const found = literalTextRange(fragment, rendered);
          return found ? [found] : [];
        })
      : [];
  });
  if (!ranges.length) return null;
  let start = Math.min(...ranges.map((r) => r[0]));
  let end = Math.max(...ranges.map((r) => r[1]));
  // A citation/ref at a selection edge has no literal glyphs of its own.
  // Adjacent unselected source text can bound its output without swallowing
  // the rest of the PDF line. Without that evidence, keep only matched text.
  if (context && visibleSource.trimEnd().endsWith(PDF_TEXT_GAP)) {
    const after = pdfCommentVisibleText(context.sourceAfter)
      ?.split(PDF_TEXT_GAP)[0]
      ?.trim();
    const next = after && literalTextRange(after, rendered.slice(end));
    if (next) end += next[0];
  }
  if (context && visibleSource.trimStart().startsWith(PDF_TEXT_GAP)) {
    const parts = pdfCommentVisibleText(context.sourceBefore)?.split(
      PDF_TEXT_GAP,
    );
    const before = parts?.[parts.length - 1]?.trim();
    const previous =
      before && literalTextRange(before, rendered.slice(0, start));
    if (previous) start = previous[1];
  }
  while (start < end && /\s/.test(rendered[start])) start++;
  while (end > start && /\s/.test(rendered[end - 1])) end--;
  return start < end ? [start, end] : null;
}

function literalTextRange(
  source: string,
  rendered: string,
): [number, number] | null {
  const a = normalized(source).value;
  const b = normalized(rendered);
  if (!a || !b.value) return null;
  let start = b.value.indexOf(a);
  let length = a.length;
  if (start < 0 && a.includes(b.value)) {
    start = 0;
    length = b.value.length;
  }
  if (start < 0) {
    for (let n = Math.min(a.length, b.value.length); n >= 3; n--) {
      if (a.endsWith(b.value.slice(0, n))) {
        start = 0;
        length = n;
        break;
      }
      if (a.startsWith(b.value.slice(-n))) {
        start = b.value.length - n;
        length = n;
        break;
      }
    }
  }
  if (start >= 0) return [b.offsets[start], b.ends[start + length - 1]];
  return null;
}

export function pdfCommentBounds(
  line: StructuredTextLine,
  range: [number, number],
) {
  let x = line.bbox.x;
  let width = line.bbox.w;
  let offset = 0;
  const quads = (line.chars ?? [])
    .filter((char) => {
      const start = offset;
      offset += char.c.length;
      return offset > range[0] && start < range[1];
    })
    .flatMap((char) => [
      char.quad[0],
      char.quad[2],
      char.quad[4],
      char.quad[6],
    ]);
  if (quads.length) {
    x = Math.min(...quads);
    width = Math.max(...quads) - x;
  }
  return { x, width };
}

export function pdfCommentMatchesSource(
  target: PdfCommentTarget,
  line: StructuredTextLine,
  boxes: PdfCommentSourceBox[],
) {
  const range = pdfCommentTextRange(target.sourceText, line.text, target);
  if (!range) return false;
  const { x, width } = pdfCommentBounds(line, range);
  // MuPDF and SyncTeX round PDF points differently. Use the text baseline for
  // vertical membership so neighboring lines cannot borrow each other's source.
  return boxes.some(
    (box) =>
      line.y >= box.y - 0.5 &&
      line.y <= box.y + box.height + 0.5 &&
      x + width > box.x &&
      x < box.x + box.width &&
      box.sources.some(
        (source) =>
          source.file === target.filePath &&
          source.line >= target.firstLine &&
          source.line <= target.lastLine,
      ),
  );
}

type CommentContext = {
  targets: PdfCommentTarget[];
  lookup: ReturnType<typeof createPdfCommentLookup>;
  navigate: (target: PdfCommentTarget) => void;
  selectionEnabled?: boolean;
  clearSelection?: () => void;
};
export const PdfCommentsContext = createContext<CommentContext | null>(null);

type RangePreview = { target: PdfCommentTarget; range: CommentRange } | null;
type PointMapper = (
  target: PdfCommentTarget,
  x: number,
  y: number,
) => PdfTextPoint | null;
const FocusContext = createContext<{
  preview: RangePreview;
  setPreview: (preview: RangePreview) => void;
  registerMapper: (page: number, mapper: PointMapper) => () => void;
  mapPoint: PointMapper;
  selected: PdfCommentTarget | null;
  reveal: (target: PdfCommentTarget) => void;
  isSelected?: (target: PdfCommentTarget) => boolean;
  select: (target: PdfCommentTarget, anchor: HTMLElement) => void;
  resize?: (target: PdfCommentTarget, range: CommentRange) => void;
  fileResize: ReturnType<typeof usePdfFileCommentResize>;
} | null>(null);

const PdfCommentResizePageContext = createContext<number | null>(null);

export function usePdfCommentResizePage() {
  return useContext(PdfCommentResizePageContext);
}

export function useRevealPdfComment() {
  return useContext(FocusContext)?.reveal;
}

export function PdfCommentInteraction({
  context,
  editorVisible,
  layoutAnimating = false,
  scrollElement,
  requestedCommentId: externalRequestedId,
  requestRevision: externalRevision = 0,
  centerRequested: externalCenter = false,
  onSearchNavigate,
  searchActive = true,
  actionsFor,
  pdfSource = null,
  onResizePdf,
  fullWidth = false,
  onToggleFullWidth,
  children,
}: {
  context: CommentContext | null;
  editorVisible: boolean;
  layoutAnimating?: boolean;
  scrollElement?: Element | null;
  requestedCommentId?: string | null;
  requestRevision?: number;
  centerRequested?: boolean;
  onSearchNavigate?: (commentId: string | null, filePath: string) => void;
  searchActive?: boolean;
  actionsFor: (target: PdfCommentTarget) => InlineCommentActions;
  pdfSource?: PdfSource | null;
  onResizePdf?: ResizePdfComment;
  fullWidth?: boolean;
  onToggleFullWidth?: () => void;
  children: ReactNode;
}) {
  const [focus, setFocus] = useState<{
    target: PdfCommentTarget;
    anchor: HTMLElement;
    page: string | undefined;
  } | null>(null);
  const activeCommentId = useSyncExternalStore(
    subscribeActiveComment,
    getActiveComment,
  );
  const [preview, setPreview] = useState<RangePreview>(null);
  const mappers = useRef(new Map<number, PointMapper>());
  const registerMapper = useCallback((page: number, mapper: PointMapper) => {
    mappers.current.set(page, mapper);
    return () => {
      if (mappers.current.get(page) === mapper) mappers.current.delete(page);
    };
  }, []);
  const mapPoint = useCallback<PointMapper>((target, x, y) => {
    for (const mapper of mappers.current.values()) {
      const offset = mapper(target, x, y);
      if (offset !== null) return offset;
    }
    return null;
  }, []);
  const surface = useRef<HTMLDivElement>(null);
  const commentRequestRevision = useRef(0);
  const [searchRequest, setSearchRequest] = useState<{
    id: string;
    filePath: string;
    revision: number;
    fromSearch?: boolean;
  } | null>(null);
  useEffect(() => {
    if (!searchActive) return;
    const navigate = (event: Event) => {
      const detail = (event as CustomEvent<CommentSearchNavigation>).detail;
      if (!surface.current || !detail.pane?.contains(surface.current)) return;
      if (detail.dismiss) {
        if (
          !searchRequest?.fromSearch ||
          searchRequest.id !== detail.commentId ||
          searchRequest.filePath !== detail.filePath
        )
          return;
        onSearchNavigate?.(null, detail.filePath);
        setSearchRequest(null);
        if (getActiveComment() === detail.commentId) setActiveComment(null);
        return;
      }
      setSearchRequest({
        id: detail.commentId,
        filePath: detail.filePath,
        revision: ++commentRequestRevision.current,
        fromSearch: true,
      });
    };
    window.addEventListener(COMMENT_SEARCH_NAVIGATE_EVENT, navigate);
    return () =>
      window.removeEventListener(COMMENT_SEARCH_NAVIGATE_EVENT, navigate);
  }, [onSearchNavigate, searchActive, searchRequest]);
  useEffect(
    () => setSearchRequest(null),
    [externalRequestedId, externalRevision],
  );
  const requestedCommentId = searchRequest?.id ?? externalRequestedId;
  const requestRevision = searchRequest
    ? `search:${searchRequest.revision}`
    : externalRevision;
  const centerRequested = Boolean(searchRequest) || externalCenter;
  const showInEditor = editorVisible && !searchRequest?.fromSearch;

  const handledRequest = useRef<string | null>(null);
  const locatedSearchRequest = useRef<string | null>(null);
  useEffect(() => {
    const requestKey = `${requestedCommentId}:${requestRevision}`;
    if (!requestedCommentId || handledRequest.current === requestKey) return;
    const target = context?.targets.find(
      (target) =>
        target.comment.id === requestedCommentId &&
        (!searchRequest || target.filePath === searchRequest.filePath),
    );
    if (!target) return;
    if (showInEditor) {
      handledRequest.current = requestKey;
      setActiveComment(requestedCommentId);
      context?.navigate(target);
      return;
    }
    const observer = new MutationObserver(() => focusDraft());
    const focusDraft = () => {
      const anchor = [
        ...(surface.current?.querySelectorAll<HTMLElement>(
          "[data-pdf-comment-id]",
        ) ?? []),
      ].find((element) => element.dataset.pdfCommentId === requestedCommentId);
      if (anchor) {
        observer.disconnect();
        handledRequest.current = requestKey;
        setActiveComment(requestedCommentId);
        if (centerRequested) setLayoutRequest({ editorVisible });
        setFocus({
          target,
          anchor,
          page: anchor.closest<HTMLElement>("[data-pdf-comment-page]")?.dataset
            .pdfCommentPage,
        });
      }
    };
    if (surface.current)
      observer.observe(surface.current, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["data-pdf-comment-id"],
      });
    if (
      searchRequest?.fromSearch &&
      onSearchNavigate &&
      locatedSearchRequest.current !== requestKey &&
      !Array.from(
        surface.current?.querySelectorAll<HTMLElement>(
          "[data-pdf-comment-id]",
        ) ?? [],
      ).some((anchor) => anchor.dataset.pdfCommentId === requestedCommentId)
    ) {
      locatedSearchRequest.current = requestKey;
      onSearchNavigate(requestedCommentId, searchRequest.filePath);
    }
    focusDraft();
    return () => observer.disconnect();
  }, [
    requestedCommentId,
    requestRevision,
    centerRequested,
    editorVisible,
    searchRequest,
    onSearchNavigate,
    showInEditor,
    context,
  ]);
  const [layoutRequest, setLayoutRequest] = useState<{
    editorVisible: boolean;
  } | null>(null);
  const selected =
    context?.targets.find((target) => target.comment.id === activeCommentId) ??
    null;
  const fileResize = usePdfFileCommentResize(pdfSource, selected, onResizePdf);
  useEffect(() => {
    if (!selected) {
      setFocus(null);
      return;
    }
    if (focus?.target.comment.id === selected.comment.id) return;
    const observer = new MutationObserver(() => locate());
    const locate = () => {
      const anchor = [
        ...(surface.current?.querySelectorAll<HTMLElement>(
          "[data-pdf-comment-id]",
        ) ?? []),
      ].find((element) => element.dataset.pdfCommentId === selected.comment.id);
      if (anchor) {
        observer.disconnect();
        setFocus({
          target: selected,
          anchor,
          page: anchor.closest<HTMLElement>("[data-pdf-comment-page]")?.dataset
            .pdfCommentPage,
        });
      }
    };
    if (surface.current)
      observer.observe(surface.current, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["data-pdf-comment-id"],
      });
    locate();
    return () => observer.disconnect();
  }, [selected, focus?.target.comment.id]);
  useEffect(() => {
    const prepare = (event: Event) => {
      if (
        !selected ||
        !(event.target instanceof HTMLElement) ||
        !event.target.contains(surface.current)
      )
        return;
      const detail = (event as CustomEvent<PdfCommentLayoutChange>).detail;
      if (!editorVisible && surface.current?.querySelector('[role="dialog"]')) {
        detail.exitMs = window.matchMedia?.("(prefers-reduced-motion: reduce)")
          .matches
          ? 0
          : 140;
      }
      setLayoutRequest({ editorVisible: detail.editorVisible });
    };
    window.addEventListener(PDF_COMMENT_LAYOUT_EVENT, prepare);
    return () => window.removeEventListener(PDF_COMMENT_LAYOUT_EVENT, prepare);
  }, [selected, editorVisible]);
  useEffect(() => {
    if (
      !layoutRequest ||
      layoutAnimating ||
      editorVisible !== layoutRequest.editorVisible ||
      !selected ||
      !focus
    )
      return;
    let frame = 0;
    let stableFrames = 0;
    let previous = "";
    const viewport = surface.current?.querySelector<HTMLElement>(
      '[data-testid="pdf-scroll-container"]',
    );
    if (!viewport) {
      setLayoutRequest(null);
      return;
    }
    const scrolling = scrollElement ?? viewport;
    const settle = () => {
      const block = surface.current?.querySelector<HTMLElement>(
        `[data-pdf-comment-page="${focus.page}"] [data-testid="pdf-comment-focus-box"]`,
      );
      if (!block) {
        const page = surface.current?.querySelector<HTMLElement>(
          `[data-page-number="${focus.page}"]`,
        );
        if (page)
          scrolling.scrollTop +=
            page.getBoundingClientRect().top -
            viewport.getBoundingClientRect().top;
        frame = requestAnimationFrame(settle);
        return;
      }
      const box = block.getBoundingClientRect();
      const view = viewport.getBoundingClientRect();
      const signature = [
        box.width,
        box.height,
        box.top + scrolling.scrollTop,
        view.width,
      ]
        .map((value) => Math.round(value * 2))
        .join(":");
      stableFrames = signature === previous ? stableFrames + 1 : 0;
      previous = signature;
      if (stableFrames < 4) {
        frame = requestAnimationFrame(settle);
        return;
      }
      const start = scrolling.scrollTop;
      const end = Math.max(
        0,
        Math.min(
          scrolling.scrollHeight - viewport.clientHeight,
          start + box.top + box.height / 2 - view.top - view.height / 2,
        ),
      );
      const reduced = window.matchMedia?.(
        "(prefers-reduced-motion: reduce)",
      ).matches;
      const began = performance.now();
      const scroll = (now: number) => {
        const progress = reduced ? 1 : Math.min(1, (now - began) / 180);
        scrolling.scrollTop = start + (end - start) * (1 - (1 - progress) ** 3);
        if (progress < 1) {
          frame = requestAnimationFrame(scroll);
          return;
        }
        if (showInEditor) context?.navigate(selected);
        setLayoutRequest(null);
      };
      frame = requestAnimationFrame(scroll);
    };
    frame = requestAnimationFrame(settle);
    return () => cancelAnimationFrame(frame);
  }, [
    layoutRequest,
    layoutAnimating,
    editorVisible,
    showInEditor,
    selected,
    focus,
    context,
    scrollElement,
  ]);
  useEffect(() => {
    if (!selected) {
      setFocus(null);
      setLayoutRequest(null);
    }
  }, [selected]);
  useEffect(() => {
    const dismiss = (event: KeyboardEvent) => {
      if (canHandleEscape(event) && (selected || focus)) {
        consumeKey(event);
        setFocus(null);
        setSearchRequest(null);
        setActiveComment(null);
        context?.clearSelection?.();
      }
    };
    const pane = surface.current?.parentElement;
    pane?.addEventListener("keydown", dismiss);
    return () => pane?.removeEventListener("keydown", dismiss);
  }, [context, selected, focus]);
  const [widthCanExpand, setWidthCanExpand] = useState(false);
  const actions = useMemo(
    () => ({
      ...(selected ? actionsFor(selected) : {}),
      ...(!editorVisible && widthCanExpand && onToggleFullWidth
        ? { fullWidth, onToggleFullWidth }
        : {}),
    }),
    [
      selected,
      actionsFor,
      editorVisible,
      widthCanExpand,
      fullWidth,
      onToggleFullWidth,
    ],
  );
  const [placement, setPlacement] = useState({
    left: 0,
    top: 0,
    width: 320,
    maxHeight: 480,
  });
  const host =
    surface.current?.querySelector<HTMLElement>("[data-pdf-scroll-content]") ??
    surface.current;
  useLayoutEffect(() => {
    if (!focus || showInEditor || !host) return;
    let frame = 0;
    const measure = () => {
      const id = focus.target.comment.id;
      const layer = surface.current?.querySelector<HTMLElement>(
        `[data-pdf-comment-page="${focus.page}"]`,
      );
      const block = Array.from(
        layer?.querySelectorAll<HTMLElement>(
          '[data-testid="pdf-comment-focus-box"]',
        ) ?? [],
      ).find((element) => element.dataset.commentId === id);
      const findHighlight = (root: HTMLElement | null | undefined) =>
        Array.from(
          root?.querySelectorAll<HTMLElement>("[data-pdf-comment-id]") ?? [],
        ).find((element) => element.dataset.pdfCommentId === id);
      const anchor =
        block ??
        findHighlight(layer) ??
        (focus.target.comment.pdf ? findHighlight(surface.current) : null) ??
        focus.anchor;
      const page = anchor.closest<HTMLElement>("[data-page-number]");
      const viewport = surface.current?.querySelector<HTMLElement>(
        '[data-testid="pdf-scroll-container"]',
      );
      if (anchor.isConnected && page && viewport) {
        const bounds = anchor.getBoundingClientRect();
        const origin = host.getBoundingClientRect();
        const pageBounds = page.getBoundingClientRect();
        const availableWidth = Math.max(
          0,
          Math.min(
            viewport.clientWidth - PDF_COMMENT_MARGIN * 2,
            Math.max(320, pageBounds.width - PDF_COMMENT_MARGIN * 2),
          ),
        );
        setWidthCanExpand(availableWidth > CHAT_DRAWER_MAX_WIDTH);
        const width = Math.min(
          availableWidth,
          onToggleFullWidth && !fullWidth ? CHAT_DRAWER_MAX_WIDTH : Infinity,
        );
        const viewLeft =
          viewport.getBoundingClientRect().left + viewport.clientLeft;
        const left = Math.min(
          viewLeft + viewport.clientWidth - PDF_COMMENT_MARGIN - width,
          Math.max(
            viewLeft + PDF_COMMENT_MARGIN,
            pageBounds.left + (pageBounds.width - width) / 2,
          ),
        );
        const next = {
          left: left - origin.left,
          top: bounds.bottom - origin.top + 8,
          width,
          maxHeight: 480,
        };
        setPlacement((current) =>
          current.left === next.left &&
          current.top === next.top &&
          current.width === next.width
            ? current
            : next,
        );
      }
      frame = requestAnimationFrame(measure);
    };
    measure();
    return () => cancelAnimationFrame(frame);
  }, [focus, showInEditor, host, fullWidth, onToggleFullWidth]);
  return (
    <PdfCommentsContext.Provider value={context}>
      <FocusContext.Provider
        value={{
          selected,
          reveal: (target) => {
            setSearchRequest({
              id: target.comment.id,
              filePath: target.filePath,
              revision: ++commentRequestRevision.current,
            });
            if (!target.comment.isEditing)
              actionsFor(target).onAttach?.(target.comment);
          },
          preview,
          setPreview,
          registerMapper,
          mapPoint,
          resize: (target, range) =>
            actionsFor(target).onResize?.(target.comment.id, range),
          fileResize,
          isSelected: context?.selectionEnabled
            ? (target) =>
                Boolean(
                  actionsFor(target).selectedCommentIds?.includes(
                    target.comment.id,
                  ),
                )
            : undefined,
          select: (target, anchor) => {
            setActiveComment(target.comment.id);
            setFocus({
              target,
              anchor,
              page: anchor.closest<HTMLElement>("[data-pdf-comment-page]")
                ?.dataset.pdfCommentPage,
            });
            setLayoutRequest(null);
            if (editorVisible) context?.navigate(target);
            if (!target.comment.isEditing)
              actionsFor(target).onAttach?.(target.comment);
          },
        }}
      >
        <div
          className="contents"
          ref={surface}
          onClick={(event) => {
            if (
              (event.target as Element).closest(
                '[data-testid="preview-search-panel"], [data-comment-range-handle]',
              )
            )
              return;
            setActiveComment(null);
            setFocus(null);
            setSearchRequest(null);
            context?.clearSelection?.();
          }}
          data-pdf-comment-surface="true"
        >
          <PdfCommentResizePageContext.Provider value={fileResize.dragPage}>
            {children}
          </PdfCommentResizePageContext.Provider>
        </div>
        {host &&
          createPortal(
            <PdfCommentPopup
              target={
                showInEditor || layoutRequest || layoutAnimating
                  ? null
                  : selected
              }
              actions={actions}
              placement={placement}
            />,
            host,
          )}
      </FocusContext.Provider>
    </PdfCommentsContext.Provider>
  );
}

function PdfCommentPopup({
  target,
  actions,
  placement,
}: {
  target: PdfCommentTarget | null;
  actions: InlineCommentActions;
  placement: { left: number; top: number; width: number; maxHeight: number };
}) {
  const [retained, setRetained] = useState<{
    target: PdfCommentTarget;
    actions: InlineCommentActions;
    placement: typeof placement;
  } | null>(null);
  useLayoutEffect(() => {
    if (target) {
      setRetained({ target, actions, placement });
      return;
    }
    const timeout = window.setTimeout(
      () => setRetained(null),
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? 0 : 140,
    );
    return () => window.clearTimeout(timeout);
  }, [target, actions, placement]);
  const shown = target ? { target, actions, placement } : retained;
  if (!shown) return null;
  return (
    <div
      key={`${shown.target.filePath}:${shown.target.comment.id}`}
      role="dialog"
      aria-label="PDF comment"
      aria-hidden={!target || undefined}
      className={`pointer-events-auto absolute z-[5] overflow-auto rounded-xl shadow-md ${shown.actions.onToggleFullWidth ? "motion-safe:transition-[width,left] motion-safe:duration-200 motion-safe:ease-out" : ""} ${target ? "pdf-comment-enter" : "pdf-comment-exit pointer-events-none"}`}
      style={shown.placement}
      data-comment-popup="true"
      onClick={(event) => event.stopPropagation()}
    >
      <InlineCommentCard
        comment={shown.target.comment}
        actions={shown.actions}
      />
    </div>
  );
}

export function PdfCommentLayer({
  textData,
  pageNumber,
  pageWidth,
  pageHeight,
  pageElement,
  links = [],
}: {
  textData: StructuredTextData;
  pageNumber: number;
  pageWidth: number;
  pageHeight: number;
  pageElement: React.RefObject<HTMLDivElement | null>;
  links?: { x: number; y: number; w: number; h: number }[];
}) {
  const context = useContext(PdfCommentsContext);
  const interaction = useContext(FocusContext);
  const preview = interaction?.preview;
  const filePreview = interaction?.fileResize.preview;
  const lines = useMemo(
    () => textData.blocks.flatMap((block) => block.lines),
    [textData],
  );
  const [mapped, setMapped] = useState<{
    context: CommentContext;
    textData: StructuredTextData;
    boxes: PdfCommentSourceBox[];
  } | null>(null);
  useEffect(() => {
    if (!context || context.targets.length === 0) return;
    const controller = new AbortController();
    void (async () => {
      const boxes = await context.lookup(pageNumber, controller.signal);
      if (controller.signal.aborted) return;
      setMapped({ context, textData, boxes });
    })();
    return () => controller.abort();
  }, [context, lines, pageNumber, textData]);

  const regions = useMemo(() => {
    if (
      !context ||
      mapped?.context.lookup !== context.lookup ||
      mapped.textData !== textData
    )
      return [];
    if (context.targets.some((target) => target.comment.pdf))
      return pdfFileCommentRegions(context.targets, pageNumber, filePreview);
    const displayTargets = context.targets.map((target) => {
      if (
        !preview ||
        preview.target.comment.id !== target.comment.id ||
        !target.sourceContent
      )
        return target;
      const { from, to } = preview.range;
      const source = target.sourceContent;
      return {
        ...target,
        comment: { ...target.comment, ...preview.range },
        sourceText: source.slice(from, to),
        sourceBefore: source.slice(Math.max(0, from - 256), from),
        sourceAfter: source.slice(to, to + 256),
        firstLine: source.slice(0, from).split("\n").length,
        lastLine: source.slice(0, to - 1).split("\n").length,
      };
    });
    return lines.map((line) => {
      const targets = displayTargets.filter((target) =>
        pdfCommentMatchesSource(target, line, mapped.boxes),
      );
      return {
        bounds: line.bbox,
        ranges: targets
          .map((target) => {
            const range = pdfCommentTextRange(
              target.sourceText,
              line.text,
              target,
            );
            if (!range) return null;
            const { x, width } = pdfCommentBounds(line, range);
            const source = target.sourceContent;
            const mappedStart = source
              ? pdfCommentEndpoint(source, line, 0, target.firstLine)
              : null;
            const mappedEnd = source
              ? pdfCommentEndpoint(
                  source,
                  line,
                  line.text.length,
                  target.lastLine,
                )
              : null;
            return {
              target,
              x,
              width,
              start:
                mappedStart !== null &&
                mappedEnd !== null &&
                target.comment.from >= mappedStart &&
                target.comment.from < mappedEnd,
              end:
                mappedStart !== null &&
                mappedEnd !== null &&
                target.comment.to > mappedStart &&
                target.comment.to <= mappedEnd,
            };
          })
          .filter(
            (range): range is NonNullable<typeof range> => range !== null,
          ),
      };
    });
  }, [
    context?.targets,
    context?.lookup,
    mapped,
    textData,
    lines,
    preview,
    filePreview,
    pageNumber,
  ]);
  if (
    !context ||
    mapped?.context.lookup !== context.lookup ||
    mapped.textData !== textData
  )
    return null;
  return (
    <PreviewCommentLayer
      regions={regions}
      onPreview={interaction?.setPreview}
      pageNumber={pageNumber}
      pageWidth={pageWidth}
      pageHeight={pageHeight}
      pageElement={pageElement}
      links={links}
      offsetAtPoint={(target, clientX, clientY) => {
        const page = pageElement.current?.getBoundingClientRect();
        if (!page) return null;
        const x = ((clientX - page.left) * pageWidth) / page.width;
        const y = ((clientY - page.top) * pageHeight) / page.height;
        if (target.comment.pdf) return pdfPageOffsetAtPoint(lines, x, y);
        if (!target.sourceContent) return null;
        const line = lines.find(
          (line) =>
            y >= line.bbox.y - 2 &&
            y <= line.bbox.y + line.bbox.h + 2 &&
            x >= line.bbox.x - 12 &&
            x <= line.bbox.x + line.bbox.w + 12,
        );
        if (!line) return null;
        const box = mapped.boxes.find(
          (box) =>
            line.y >= box.y - 0.5 &&
            line.y <= box.y + box.height + 0.5 &&
            x >= box.x - 12 &&
            x <= box.x + box.width + 12 &&
            box.sources.some((source) => source.file === target.filePath),
        );
        const source = box?.sources.find(
          (source) => source.file === target.filePath,
        );
        const offset = pdfOffsetAtPoint(line, x);
        return source && offset !== null
          ? pdfCommentEndpoint(target.sourceContent, line, offset, source.line)
          : null;
      }}
    />
  );
}

export interface PreviewCommentRegion {
  bounds: { x: number; y: number; w: number; h: number };
  ranges: {
    target: PdfCommentTarget;
    x: number;
    width: number;
    start?: boolean;
    end?: boolean;
  }[];
}

/** The shared comment highlights, focus outlines, and range handles. */
export function PreviewCommentLayer({
  regions,
  pageNumber,
  pageWidth,
  pageHeight,
  pageElement,
  links = [],
  offsetAtPoint,
  onPreview,
}: {
  onPreview?: (
    preview: { target: PdfCommentTarget; range: CommentRange } | null,
  ) => void;
  offsetAtPoint?: (
    target: PdfCommentTarget,
    x: number,
    y: number,
  ) => number | null;
  regions: PreviewCommentRegion[];
  pageNumber: number;
  pageWidth: number;
  pageHeight: number;
  pageElement: React.RefObject<HTMLDivElement | null>;
  links?: { x: number; y: number; w: number; h: number }[];
}) {
  const context = useContext(PdfCommentsContext);
  const focus = useContext(FocusContext);
  const registerMapper = focus?.registerMapper;
  useEffect(() => {
    if (!registerMapper || !offsetAtPoint) return;
    return registerMapper(pageNumber, (target, x, y) => {
      const bounds = pageElement.current?.getBoundingClientRect();
      if (
        !bounds ||
        x < bounds.left ||
        x > bounds.right ||
        y < bounds.top ||
        y > bounds.bottom
      )
        return null;
      const offset = offsetAtPoint(target, x, y);
      return offset === null ? null : { page: pageNumber, offset };
    });
  }, [registerMapper, pageNumber, pageElement, offsetAtPoint]);
  const draggingEdge = useRef<CommentRangeEdge | null>(null);
  const retainedEdges = useRef<
    Partial<
      Record<
        CommentRangeEdge,
        { x: number; width: number; bounds: PreviewCommentRegion["bounds"] }
      >
    >
  >({});
  const draft = useRef<{
    target: PdfCommentTarget;
    range: CommentRange;
  } | null>(null);

  const move = (
    target: PdfCommentTarget,
    edge: CommentRangeEdge,
    x: number,
    y: number,
  ) => {
    const point = focus?.mapPoint(target, x, y);
    if (target.comment.pdf) {
      if (point) focus?.fileResize.move(point);
      return;
    }
    const source = target.sourceContent;
    const offset = point?.offset ?? offsetAtPoint?.(target, x, y);
    const range =
      source && offset != null
        ? resizeCommentRange(source, target.comment, edge, offset)
        : null;
    const page = pageElement.current?.getBoundingClientRect();
    if (!range || !page) return;
    draggingEdge.current = edge;
    draft.current = { target, range };
    onPreview?.({ target, range });
  };
  const finish = (commit: boolean) => {
    const next = draft.current;
    draft.current = null;
    draggingEdge.current = null;
    onPreview?.(null);

    if (
      commit &&
      next &&
      (next.range.from !== next.target.comment.from ||
        next.range.to !== next.target.comment.to)
    )
      focus?.resize?.(next.target, next.range);
  };
  useEffect(() => {
    const page = pageElement.current;
    if (!page) return;
    const click = (event: MouseEvent) => {
      if (event.detail > 1 || !window.getSelection()?.isCollapsed) return;
      if ((event.target as Element).closest("button, a")) return;
      const highlights = [
        ...page.querySelectorAll<HTMLButtonElement>(
          "[data-pdf-comment-highlight]",
        ),
      ];
      const hit = highlights.reverse().find((element) => {
        const rect = element.getBoundingClientRect();
        return (
          event.clientX >= rect.left &&
          event.clientX <= rect.right &&
          event.clientY >= rect.top &&
          event.clientY <= rect.bottom
        );
      });
      if (hit) {
        event.stopPropagation();
        hit.click();
      }
    };
    page.addEventListener("click", click);
    return () => page.removeEventListener("click", click);
  }, [pageElement]);

  if (!context) return null;
  const isSelected = (target: PdfCommentTarget) =>
    (focus?.selected?.filePath === target.filePath &&
      focus.selected.comment.id === target.comment.id) ||
    Boolean(focus?.isSelected?.(target));
  const selectedTargets = context.targets.filter(
    (target) => !target.comment.isEditing && isSelected(target),
  );
  const blocks = selectedTargets.flatMap((target) => {
    const bounds = regions.flatMap(({ bounds, ranges }) =>
      ranges
        .filter(
          (range) =>
            range.target.filePath === target.filePath &&
            range.target.comment.id === target.comment.id,
        )
        .map(({ x, width }) => ({
          left: x,
          right: x + width,
          top: bounds.y,
          bottom: bounds.y + bounds.h,
        })),
    );
    return bounds.length
      ? [
          {
            target,
            left: Math.min(...bounds.map((box) => box.left)),
            right: Math.max(...bounds.map((box) => box.right)),
            top: Math.min(...bounds.map((box) => box.top)),
            bottom: Math.max(...bounds.map((box) => box.bottom)),
          },
        ]
      : [];
  });
  return (
    <div
      className="pointer-events-none absolute inset-0 z-[3]"
      style={
        links.length
          ? {
              maskImage: `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${pageWidth} ${pageHeight}" preserveAspectRatio="none"><mask id="links" maskUnits="userSpaceOnUse" x="0" y="0" width="${pageWidth}" height="${pageHeight}"><rect width="100%" height="100%" fill="white"/>${links.map(({ x, y, w, h }) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="black"/>`).join("")}</mask><rect width="100%" height="100%" fill="white" mask="url(#links)"/></svg>`)}")`,
              maskSize: "100% 100%",
            }
          : undefined
      }
      data-testid="pdf-comment-layer"
      data-pdf-comment-page={pageNumber}
    >
      {offsetAtPoint &&
        focus?.selected &&
        (() => {
          const target = context.targets.find(
            (target) =>
              target.comment.id === focus.selected?.comment.id &&
              target.filePath === focus.selected.filePath,
          );
          if (!target) return null;
          if (target.comment.pdf && !focus.fileResize.ready) return null;
          const matches = regions.flatMap(({ bounds, ranges }) =>
            ranges
              .filter((range) => range.target.comment.id === target.comment.id)
              .map((range) => ({ ...range, bounds })),
          );
          return (["from", "to"] as const).map((edge) => {
            const currentMatch =
              edge === "from"
                ? matches.find((range) => range.start)
                : [...matches].reverse().find((range) => range.end);
            if (currentMatch) retainedEdges.current[edge] = currentMatch;
            const match =
              currentMatch ??
              (draggingEdge.current === edge
                ? retainedEdges.current[edge]
                : null);
            if (!match) return null;
            return (
              <CommentRangeHandle
                hidden={!currentMatch}
                key={edge}
                edge={edge}
                agent={!!target.comment.origin}
                x={
                  ((match.x + (edge === "to" ? match.width : 0)) / pageWidth) *
                  100
                }
                y={(match.bounds.y / pageHeight) * 100}
                height={(match.bounds.h / pageHeight) * 100}
                onStart={
                  target.comment.pdf
                    ? () => {
                        draggingEdge.current = edge;
                        focus.fileResize.start(target, edge, pageNumber);
                      }
                    : undefined
                }
                onMove={(x, y) => move(target, edge, x, y)}
                onFinish={(commit) => {
                  if (target.comment.pdf) {
                    draggingEdge.current = null;
                    focus.fileResize.finish(commit);
                  } else finish(commit);
                }}
              />
            );
          });
        })()}
      {blocks.map((block) => (
        <div
          key={`${block.target.filePath}:${block.target.comment.id}`}
          data-testid="pdf-comment-focus-box"
          data-comment-id={block.target.comment.id}
          className="pointer-events-none absolute"
          style={{
            left: `${(block.left / pageWidth) * 100}%`,
            top: `${(block.top / pageHeight) * 100}%`,
            width: `${((block.right - block.left) / pageWidth) * 100}%`,
            height: `${((block.bottom - block.top) / pageHeight) * 100}%`,
            borderRadius: "4px",
            outline: "2px dashed",
            outlineColor: block.target.comment.origin
              ? "color-mix(in oklab, #7252b5 70%, transparent)"
              : "color-mix(in oklab, var(--color-amber-500) 70%, transparent)",
            outlineOffset: "2px",
          }}
        />
      ))}
      {regions.map(({ bounds, ranges }, index) => (
        <div key={index}>
          {ranges.map(({ target, x, width }) => (
            <Hint
              content={target.comment.text}
              key={`${target.comment.id}:${x}:${width}`}
            >
              <button
                data-pdf-comment-highlight="true"
                data-pdf-comment-id={target.comment.id}
                aria-pressed={isSelected(target)}
                type="button"
                aria-label={`Show ${target.comment.origin ? "agent" : "human"} comment: ${target.comment.text}`}
                className={`pointer-events-none absolute cursor-pointer rounded-[1px] border-b-2 focus-visible:outline-2 ${
                  target.comment.origin
                    ? "border-[#7252b5]/70 bg-[#7252b5]/25 hover:bg-[#7252b5]/45 focus-visible:outline-[#7252b5]"
                    : "border-amber-500/70 bg-amber-300/25 hover:bg-amber-300/45 focus-visible:outline-amber-600"
                }`}
                style={{
                  left: `${(x / pageWidth) * 100}%`,
                  top: `${(bounds.y / pageHeight) * 100}%`,
                  width: `${(width / pageWidth) * 100}%`,
                  height: `${(bounds.h / pageHeight) * 100}%`,
                }}
                onClick={(event) => {
                  event.stopPropagation();
                  if (focus) focus.select(target, event.currentTarget);
                  else context.navigate(target);
                }}
              />
            </Hint>
          ))}
        </div>
      ))}
    </div>
  );
}
