import { pdfOpenArgument } from "@/lib/mupdf/pdf-source";
import { findPdfPageAtY, PDF_PAGE_GAP } from "./pdf-reading-anchor";
import { clampPdfScale } from "./pdf-zoom";
import { canHandleEscape, consumeKey } from "@/lib/keyboard-events";
import { usePreviewSearch, PreviewSearchPanel } from "./preview-search-panel";
import { usePdfSearch } from "./pdf-search";
import { usePdfLayoutAnchor } from "./use-pdf-layout-anchor";
import type {
  PdfReadingAnchor,
  PdfReadingAnchorControl,
} from "./pdf-reading-anchor";
import { usePdfPinchZoom } from "./pdf-pinch-zoom";
import { SELECTION_OWNER_EVENT } from "@/lib/workspace-events";
import { usePdfSelectionDrag } from "./pdf-selection-drag";
import { PdfSelectionHighlight } from "./pdf-selection-highlight";
import { measurePdfSelection } from "./pdf-selection-geometry";
import { useCallback, useRef, useEffect, useState } from "react";
import { LoaderIcon, ChevronLeftIcon } from "lucide-react";
import { open as shellOpen } from "@/lib/desktop/shell";
import { ask } from "@/lib/desktop/dialog";
import {
  isNavigationScrolling,
  NAVIGATION_SCROLL_END,
} from "@/lib/navigation-scroll";
import {
  getCachedDocument,
  getOrOpenDocument,
} from "@/lib/mupdf/pdf-doc-cache";
import {
  getMupdfClient,
  getMupdfClientRevision,
} from "@/lib/mupdf/mupdf-client";
import { LOCAL_ZOOM_SHORTCUTS_ATTR } from "@/lib/app-zoom";
import { PdfCanvasCache } from "./pdf-canvas-cache";
import { MupdfPage } from "./mupdf-page";
import { createLogger } from "@/lib/debug/logger";
import { APP_VISIBILITY_RESTORED } from "@/lib/debug/log-store";
import type { PageSize } from "@/lib/mupdf/types";
import {
  pdfPageObserverRootMargin,
  pdfPageRenderKey,
} from "./pdf-render-policy";
import { getPdfViewerBytes, type PdfViewerDataSource } from "./pdf-data-source";

const log = createLogger("pdf-viewer");

/** Module-level scroll position cache: rootFileId → page number */
const scrollPositionCache = new Map<string, number>();

/** Clear all cached scroll positions (e.g., on project close). */
export function clearScrollPositionCache(): void {
  scrollPositionCache.clear();
}

export interface PdfTextSelection {
  text: string;
  context?: { before: string; after: string };
  pageNumber: number;
  position: { top: number; left: number };
  pdfX: number;
  pdfY: number;
  getBounds: () => DOMRect | null;
  viewport: HTMLElement;
  clear: () => void;
}

export type PdfScrollPosition = PdfReadingAnchor;

interface PdfViewerProps {
  dataSource: PdfViewerDataSource;
  scale: number;
  disableZoomTransition?: boolean;
  /** Resize existing pixels during panel motion; render only the settled scale. */
  displayScale?: number;
  layoutAnimating?: boolean;
  /** Root file ID for scroll position caching across file switches. */
  rootFileId?: string;
  /** Whether this viewer is currently the active/visible one (for keep-alive). */
  isActive?: boolean;
  isCompiling?: boolean;
  /** Keep native selection local to a historical preview. */
  isolatedSelection?: boolean;
  /** Reopen owned snapshot bytes after a live compile resets the MuPDF worker. */
  documentReloadRevision?: number;
  onError?: (error: string) => void;
  onLoadSuccess?: (numPages: number) => void;
  onScaleChange?: (scale: number) => void;
  onTextClick?: (text: string) => void;
  onSynctexClick?: (page: number, x: number, y: number) => void;
  onTextSelect?: (selection: PdfTextSelection | null) => void;
  onFirstPageSize?: (width: number, height: number) => void;
  onContainerResize?: (
    width: number,
    height: number,
    viewport: HTMLDivElement,
  ) => void;
  onCurrentPageChange?: (page: number) => void;
  onScrollIntent?: () => void;
  onScrollPositionChange?: (position: PdfScrollPosition) => void;
  readingAnchorRef?: React.RefObject<PdfReadingAnchorControl | null>;
  scrollToPageRef?: React.RefObject<
    ((page: number, pdfY?: number) => void) | null
  >;
}

export function PdfViewer({
  dataSource,
  scale,
  disableZoomTransition = false,
  displayScale = scale,
  layoutAnimating = false,
  rootFileId,
  isActive = true,
  isCompiling = false,
  isolatedSelection = false,
  documentReloadRevision = 0,
  onError,
  onLoadSuccess,
  onScaleChange,
  onTextClick,
  onSynctexClick,
  onTextSelect,
  onFirstPageSize,
  onContainerResize,
  onCurrentPageChange,
  onScrollPositionChange,
  onScrollIntent,
  scrollToPageRef,
  readingAnchorRef,
}: PdfViewerProps) {
  const [canvasCache] = useState(() => new PdfCanvasCache());
  const searchScope = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const retainedSelection = useRef<Range | null>(null);
  // A drag/Select All may cross unloaded pages. Once it ends, retain only the
  // selected range; an ordinary click must not pin every text layer forever.
  const [selectAllPages, setSelectAllPages] = useState(false);
  const [selectionPages, setSelectionPages] = useState<[number, number] | null>(
    null,
  );
  const retainSelectionPages = useCallback((range: Range | null) => {
    const container = containerRef.current;
    const pageNumber = (node: Node) =>
      Number(
        node.parentElement?.closest<HTMLElement>("[data-page-number]")?.dataset
          .pageNumber,
      );
    const first =
      range && !range.collapsed && container?.contains(range.startContainer)
        ? pageNumber(range.startContainer)
        : 0;
    const last =
      range && !range.collapsed && container?.contains(range.endContainer)
        ? pageNumber(range.endContainer)
        : 0;
    setSelectionPages((previous) => {
      if (!first || !last) return previous === null ? previous : null;
      return previous?.[0] === first && previous[1] === last
        ? previous
        : [first, last];
    });
  }, []);
  const prepareSelectAll = useCallback(() => setSelectAllPages(true), []);
  const finishSelection = useCallback(() => {
    const selection = window.getSelection();
    retainSelectionPages(
      selection?.rangeCount
        ? selection.getRangeAt(0)
        : retainedSelection.current,
    );
    setSelectAllPages(false);
  }, [retainSelectionPages]);
  usePdfSelectionDrag(containerRef, prepareSelectAll, finishSelection);
  const contentRef = useRef<HTMLDivElement>(null);
  const [pageSizes, setPageSizes] = useState<PageSize[]>([]);
  const [visiblePages, setVisiblePages] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(true);
  const [linkReturn, setLinkReturn] = useState<{
    top: number;
    left: number;
    page: number;
  } | null>(null);
  useEffect(() => {
    setLinkReturn(null);
    setSelectAllPages(false);
    setSelectionPages(null);
    retainedSelection.current = null;
  }, [
    dataSource.kind === "compiled" ? dataSource.rootFileId : dataSource.data,
    dataSource.kind === "compiled" ? dataSource.revision : 0,
  ]);
  useEffect(() => {
    if (isCompiling) setLinkReturn(null);
  }, [isCompiling]);
  const docIdRef = useRef(0);
  // Keep page identity tied to the loaded document, not a changing global worker.
  const documentWorkerRevision = useRef(0);
  const loadGenRef = useRef(0);

  const scaleRef = useRef(scale);
  scaleRef.current = scale;
  const synctexClickRef = useRef(onSynctexClick);
  synctexClickRef.current = onSynctexClick;
  const textSelectRef = useRef(onTextSelect);
  textSelectRef.current = onTextSelect;
  const scrollPositionChangeRef = useRef(onScrollPositionChange);
  scrollPositionChangeRef.current = onScrollPositionChange;
  const readingAnchor = usePdfLayoutAnchor(
    containerRef,
    layoutAnimating,
    displayScale,
    pageSizes,
    dataSource.kind === "compiled"
      ? `${dataSource.rootFileId}:${dataSource.revision}`
      : dataSource.data instanceof Uint8Array
        ? dataSource.data
        : dataSource.data.id,
  );

  // Scroll preservation across recompile
  const isFirstLoad = useRef(true);
  const savedPageRef = useRef<number>(0);

  // Increment on app-visibility-restored to force IntersectionObserver reconnection
  const [focusGen, setFocusGen] = useState(0);
  useEffect(() => {
    const handleRestore = () => setFocusGen((g) => g + 1);
    window.addEventListener(APP_VISIBILITY_RESTORED, handleRestore);
    return () =>
      window.removeEventListener(APP_VISIBILITY_RESTORED, handleRestore);
  }, []);

  // Keep-alive scroll save/restore
  const savedScrollTop = useRef(0);
  const prevIsActive = useRef(isActive);
  useEffect(() => {
    if (prevIsActive.current && !isActive) {
      // Becoming hidden → save scrollTop
      if (containerRef.current) {
        savedScrollTop.current = containerRef.current.scrollTop;
      }
    } else if (!prevIsActive.current && isActive) {
      // Becoming visible → restore scrollTop
      const scrollVal = savedScrollTop.current;
      if (containerRef.current && scrollVal > 0) {
        // Use rAF to ensure layout is computed after visibility change
        requestAnimationFrame(() => {
          if (containerRef.current) {
            containerRef.current.scrollTop = scrollVal;
          }
        });
      }
    }
    prevIsActive.current = isActive;
  }, [isActive]);

  const numPages = pageSizes.length;

  function getVisiblePage(): number {
    const container = containerRef.current;
    if (!container) return 1;
    return findPdfPageAtY(
      container,
      pageSizes.length,
      container.getBoundingClientRect().top + 50,
    );
  }

  function getScrollPosition(): PdfScrollPosition | null {
    return readingAnchor.read();
  }

  useEffect(() => {
    if (!readingAnchorRef) return;
    readingAnchorRef.current = readingAnchor;
    return () => {
      readingAnchorRef.current = null;
    };
  }, [readingAnchorRef, readingAnchor]);

  /** Scroll the container so the given page or PDF y-position is visible. */
  function scrollToPage(
    container: HTMLElement,
    page: number,
    pdfY?: number,
  ): boolean {
    const pageEl = container.querySelector(
      `[data-page-number="${page}"]`,
    ) as HTMLElement | null;
    if (!pageEl) return false;
    const containerRect = container.getBoundingClientRect();
    const pageRect = pageEl.getBoundingClientRect();
    const yOffset =
      typeof pdfY === "number"
        ? pdfY * scaleRef.current - containerRect.height * 0.35
        : -16;
    container.scrollTop += pageRect.top - containerRect.top + yOffset;
    return true;
  }

  const search = usePreviewSearch(
    searchScope,
    docIdRef.current,
    undefined,
    isActive,
  );
  const navigateSearch = useCallback((page: number, y: number) => {
    if (containerRef.current) scrollToPage(containerRef.current, page, y);
  }, []);
  const pdfSearch = usePdfSearch(
    search,
    docIdRef.current,
    pageSizes.length,
    navigateSearch,
  );

  const prevRootFileIdRef = useRef<string | undefined>(undefined);

  // Save scroll position when rootFileId is about to change
  useEffect(() => {
    return () => {
      if (prevRootFileIdRef.current && containerRef.current) {
        scrollPositionCache.set(prevRootFileIdRef.current, getVisiblePage());
      }
    };
  }, [rootFileId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load document with MuPDF (using LRU doc cache)
  useEffect(() => {
    const gen = ++loadGenRef.current;
    prevRootFileIdRef.current = rootFileId;

    const pdfData = getPdfViewerBytes(dataSource);
    if (!pdfData) {
      setLoading(false);
      onError?.(
        "PDF data is no longer available. Try recompiling the document.",
      );
      return;
    }

    // Validate PDF header — must start with %PDF-
    if (
      pdfData instanceof Uint8Array &&
      (pdfData.length < 5 ||
        pdfData[0] !== 0x25 ||
        pdfData[1] !== 0x50 ||
        pdfData[2] !== 0x44 ||
        pdfData[3] !== 0x46)
    ) {
      log.error("Invalid PDF data: missing %PDF- header", {
        length: pdfData.length,
        firstBytes: Array.from(pdfData.slice(0, 16)),
      });
      setLoading(false);
      onError?.("Invalid PDF data received. Try recompiling the document.");
      return;
    }

    if (isolatedSelection) {
      // Historical viewers own their document instead of inserting into the live
      // five-document LRU. Otherwise browsing snapshots could evict a still
      // mounted live PDF and leave it holding a closed document ID.
      const client = getMupdfClient();
      let canceled = false;
      let ownedDocId: number | null = null;
      const previousPage = getVisiblePage();
      const closeOwnedDocument = () => {
        const id = ownedDocId;
        ownedDocId = null;
        if (id !== null) void client.closeDocument(id).catch(() => {});
      };
      docIdRef.current = 0;
      setPageSizes([]);
      setVisiblePages(new Set());
      setLoading(true);

      void (async () => {
        try {
          // The worker transfers this buffer, so preserve the parent's cached bytes.
          ownedDocId = await client.openDocument(pdfOpenArgument(pdfData));
          if (canceled) {
            closeOwnedDocument();
            return;
          }
          const sizes = await client.getAllPageSizes(ownedDocId);
          if (canceled) return;
          docIdRef.current = ownedDocId;
          documentWorkerRevision.current = getMupdfClientRevision();
          setPageSizes(sizes);
          setLoading(false);
          if (sizes[0]) onFirstPageSize?.(sizes[0].width, sizes[0].height);
          onLoadSuccess?.(sizes.length);
          requestAnimationFrame(() => {
            if (!canceled && containerRef.current && previousPage > 1) {
              scrollToPage(containerRef.current, previousPage);
            }
          });
        } catch (error) {
          closeOwnedDocument();
          if (canceled) return;
          setLoading(false);
          onError?.(error instanceof Error ? error.message : String(error));
        }
      })();

      return () => {
        canceled = true;
        closeOwnedDocument();
      };
    }

    // Fast path: synchronous cache check — avoids async gap, state churn, and re-renders
    const syncResult = getCachedDocument(pdfData);
    if (
      syncResult &&
      syncResult.docId === docIdRef.current &&
      documentWorkerRevision.current === getMupdfClientRevision()
    ) {
      // Same document already displayed — only restore scroll position on file switch
      isFirstLoad.current = false;
      if (rootFileId) {
        const targetPage = scrollPositionCache.get(rootFileId) ?? 0;
        if (targetPage > 0) {
          requestAnimationFrame(() => {
            const container = containerRef.current;
            if (container) scrollToPage(container, targetPage);
          });
        }
      }
      onLoadSuccess?.(syncResult.pageSizes.length);
      return;
    }

    // Save scroll position before reloading (for recompile of same file)
    if (containerRef.current && !isFirstLoad.current) {
      savedPageRef.current = getVisiblePage();
      if (contentRef.current) {
        contentRef.current.style.minHeight = `${contentRef.current.scrollHeight}px`;
      }
    }

    // Helper: retry-scroll to a page element with rAF retries
    const scrollToPageEl = (targetPage: number, maxAttempts = 30) => {
      const attempt = (remaining: number) => {
        const container = containerRef.current;
        if (!container || remaining <= 0) {
          if (contentRef.current) contentRef.current.style.minHeight = "";
          return;
        }
        const pageEl = container.querySelector(
          `[data-page-number="${targetPage}"]`,
        ) as HTMLElement | null;
        if (pageEl && pageEl.clientHeight > 0) {
          scrollToPage(container, targetPage);
          if (contentRef.current) contentRef.current.style.minHeight = "";
        } else {
          requestAnimationFrame(() => attempt(remaining - 1));
        }
      };
      requestAnimationFrame(() => attempt(maxAttempts));
    };

    // Synchronous cache hit for a different doc (file switch to cached PDF)
    if (syncResult) {
      docIdRef.current = syncResult.docId;
      documentWorkerRevision.current = getMupdfClientRevision();
      setPageSizes(syncResult.pageSizes);
      setLoading(false);

      if (isFirstLoad.current && syncResult.pageSizes.length > 0) {
        onFirstPageSize?.(
          syncResult.pageSizes[0].width,
          syncResult.pageSizes[0].height,
        );
      }
      isFirstLoad.current = false;

      if (rootFileId) {
        const targetPage = scrollPositionCache.get(rootFileId) ?? 0;
        if (targetPage > 0) scrollToPageEl(targetPage);
      }
      // Notify after scheduling the viewer's internal restoration so an
      // external post-compile alignment can deliberately win the frame.
      onLoadSuccess?.(syncResult.pageSizes.length);
      return;
    }

    // Cache miss — async path (first load or recompile with new content)
    setLoading(isFirstLoad.current);
    setVisiblePages(new Set());

    (async () => {
      try {
        const { docId, pageSizes: sizes } = await getOrOpenDocument(pdfData);
        if (gen !== loadGenRef.current) return;

        docIdRef.current = docId;
        documentWorkerRevision.current = getMupdfClientRevision();
        setPageSizes(sizes);
        setLoading(false);

        if (isFirstLoad.current && sizes.length > 0) {
          onFirstPageSize?.(sizes[0].width, sizes[0].height);
        }
        isFirstLoad.current = false;
        const targetPage = savedPageRef.current;
        if (targetPage > 0) {
          savedPageRef.current = 0;
          scrollToPageEl(targetPage);
        }
        // Notify after scheduling the viewer's internal restoration so an
        // external post-compile alignment can deliberately win the frame.
        onLoadSuccess?.(sizes.length);
      } catch (err) {
        if (gen !== loadGenRef.current) return;
        setLoading(false);
        onError?.(err instanceof Error ? err.message : String(err));
      }
    })();
  }, [
    dataSource.kind === "compiled" ? dataSource.rootFileId : "standalone",
    dataSource.kind === "compiled" ? dataSource.revision : dataSource.data,
    isolatedSelection,
    documentReloadRevision,
  ]); // eslint-disable-line react-hooks/exhaustive-deps

  const pinching = usePdfPinchZoom(
    containerRef,
    contentRef,
    scale,
    onScaleChange,
    docIdRef.current,
    isActive,
  );
  const pageTransitionDisabled =
    disableZoomTransition || pinching || layoutAnimating;
  const [settledScale, setSettledScale] = useState(scale);
  const renderPaused =
    !isActive || pinching || layoutAnimating || settledScale !== scale;
  useEffect(() => {
    if (!isActive || pinching || layoutAnimating || settledScale === scale)
      return;
    // Keep existing pixels through the 180ms page-size transition, including
    // repeated zoom controls. Leave one frame for its final layout to paint.
    const timer = setTimeout(() => setSettledScale(scale), 200);
    return () => clearTimeout(timer);
  }, [scale, settledScale, isActive, pinching, layoutAnimating]);

  // Keep mounted pages stable during zoom/layout motion; refresh on settle.
  useEffect(() => {
    if (renderPaused) return;
    const container = containerRef.current;
    if (!container) return;

    let observer: IntersectionObserver;
    const pendingVisibility = new Map<number, boolean>();
    const collectVisibility = (entries: IntersectionObserverEntry[]) => {
      for (const entry of entries) {
        const page = Number((entry.target as HTMLElement).dataset.pageNumber);
        if (page > 0) pendingVisibility.set(page, entry.isIntersecting);
      }
    };
    const publishVisibility = () => {
      if (isNavigationScrolling(container) || pendingVisibility.size === 0)
        return;
      const changes = new Map(pendingVisibility);
      pendingVisibility.clear();
      setVisiblePages((prev) => {
        const next = new Set(prev);
        for (const [page, visible] of changes) {
          if (visible) next.add(page);
          else next.delete(page);
        }
        return next.size === prev.size &&
          [...next].every((page) => prev.has(page))
          ? prev
          : next;
      });
    };
    const finishNavigation = () => {
      collectVisibility(observer.takeRecords());
      publishVisibility();
    };
    const observePages = () => {
      observer?.disconnect();
      pendingVisibility.clear();
      observer = new IntersectionObserver(
        (entries) => {
          // Keep cached pages during a short navigation; render the settled viewport.
          collectVisibility(entries);
          publishVisibility();
        },
        {
          root: container,
          rootMargin: pdfPageObserverRootMargin(container.clientHeight),
        },
      );

      const pages = container.querySelectorAll(".mupdf-page");
      pages.forEach((p) => observer.observe(p));
    };
    observePages();
    container.addEventListener(NAVIGATION_SCROLL_END, finishNavigation);
    let observedHeight = container.clientHeight;
    const resizeObserver = new ResizeObserver(() => {
      // The observer already tracks width/layout changes. Reconnect only when
      // its viewport-height-based preload margin actually changes.
      if (container.clientHeight === observedHeight) return;
      observedHeight = container.clientHeight;
      observePages();
    });
    resizeObserver.observe(container);
    return () => {
      observer.disconnect();
      resizeObserver.disconnect();
      container.removeEventListener(NAVIGATION_SCROLL_END, finishNavigation);
    };
  }, [pageSizes, scale, focusGen, renderPaused]);

  // Report container dimensions to parent for fit-to-width/height
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !onContainerResize) return;
    const ro = new ResizeObserver((entries) => {
      // Apply a hidden panel's pending anchor before its first visible paint.
      readingAnchor.restore();
      const { width, height } = entries[0].contentRect;
      onContainerResize(width, height, container);
    });
    ro.observe(container);
    return () => ro.disconnect();
  }, [onContainerResize, readingAnchor]);

  // Native dblclick listener for synctex
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleDblClick = (e: MouseEvent) => {
      const cb = synctexClickRef.current;
      if (!cb) return;

      const target = e.target as HTMLElement;
      const pageEl = target.closest(".mupdf-page") as HTMLElement | null;
      if (!pageEl) return;

      const pageNum = parseInt(
        pageEl.getAttribute("data-page-number") || "0",
        10,
      );
      if (pageNum === 0) return;

      const rect = pageEl.getBoundingClientRect();
      const offsetX = e.clientX - rect.left;
      const offsetY = e.clientY - rect.top;

      const currentScale = scaleRef.current;
      const pdfX = offsetX / currentScale;
      const pdfY = offsetY / currentScale;

      cb(pageNum, pdfX, pdfY);
    };

    container.addEventListener("dblclick", handleDblClick);
    return () => container.removeEventListener("dblclick", handleDblClick);
  }, []);

  // Text selection detection via mouseup
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let selectionTimer: ReturnType<typeof setTimeout> | null = null;

    const cancelPendingSelection = () => {
      if (selectionTimer !== null) {
        clearTimeout(selectionTimer);
        selectionTimer = null;
      }
    };

    const rememberSelection = () => {
      if (!container.contains(document.activeElement)) return;
      const selection = window.getSelection();
      const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
      const previous = retainedSelection.current;
      const changed =
        range &&
        !range.collapsed &&
        container.contains(range.startContainer) &&
        container.contains(range.endContainer) &&
        (!previous ||
          previous.startContainer !== range.startContainer ||
          previous.startOffset !== range.startOffset ||
          previous.endContainer !== range.endContainer ||
          previous.endOffset !== range.endOffset);
      retainedSelection.current =
        range &&
        !range.collapsed &&
        container.contains(range.startContainer) &&
        container.contains(range.endContainer)
          ? range.cloneRange()
          : null;
      retainSelectionPages(retainedSelection.current);
      if (changed && !isolatedSelection)
        window.dispatchEvent(
          new CustomEvent(SELECTION_OWNER_EVENT, { detail: "pdf" }),
        );
    };

    const handleMouseDown = (event: MouseEvent) => {
      if (
        event.button !== 0 ||
        (event.ctrlKey && /Mac/.test(navigator.platform))
      )
        return;
      cancelPendingSelection();
      const saved = retainedSelection.current;
      const target = event.target instanceof Element ? event.target : null;
      if (
        event.button === 0 &&
        !container.contains(document.activeElement) &&
        target &&
        container.contains(target) &&
        !target.closest(
          "button, a, input, textarea, [contenteditable], [role='button']",
        ) &&
        saved &&
        !saved.collapsed &&
        container.contains(saved.startContainer) &&
        container.contains(saved.endContainer)
      ) {
        // The first click reactivates the saved range. Let the next click (or
        // a new selection in another pane) replace it, as in the editor.
        event.preventDefault();
        event.stopPropagation();
        container.focus({ preventScroll: true });
        return;
      }
      if (container.contains(event.target as Node)) {
        retainedSelection.current = null;
        retainSelectionPages(null);
      }
    };
    const handleFocusIn = (event: FocusEvent) => {
      if (!container.contains(event.target as Node)) {
        cancelPendingSelection();
        return;
      }
      const range = retainedSelection.current;
      if (
        range &&
        !range.collapsed &&
        container.contains(range.startContainer) &&
        container.contains(range.endContainer)
      ) {
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range.cloneRange());
        handleMouseUp();
      }
    };
    const clearSelection = () => {
      retainedSelection.current = null;
      retainSelectionPages(null);
      setSelectAllPages(false);
      const selection = window.getSelection();
      if (selection?.anchorNode && container.contains(selection.anchorNode))
        selection.removeAllRanges();
      document.dispatchEvent(new Event("selectionchange"));
    };
    const clearForEditorSelection = (event: Event) => {
      const owner = (event as CustomEvent).detail;
      if (owner !== "editor" && owner !== "none") return;
      cancelPendingSelection();
      clearSelection();
      textSelectRef.current?.(null);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        canHandleEscape(event) &&
        (retainedSelection.current ||
          window.getSelection()?.isCollapsed === false) &&
        container.contains(document.activeElement)
      ) {
        consumeKey(event);
        cancelPendingSelection();
        clearSelection();
        textSelectRef.current?.(null);
      }
    };

    const handleMouseUp = () => {
      const cb = textSelectRef.current;
      if (!cb) return;

      cancelPendingSelection();

      selectionTimer = setTimeout(() => {
        selectionTimer = null;

        const sel = window.getSelection();
        const text = sel?.toString().trim();
        if (!text || text.length < 2) {
          retainedSelection.current = null;
          cb(null);
          return;
        }

        const range = sel!.getRangeAt(0);
        if (
          !container.contains(range.startContainer) ||
          !container.contains(range.endContainer)
        )
          return;
        retainedSelection.current = range.cloneRange();
        document.dispatchEvent(new Event("selectionchange"));
        const anchorEl = range.startContainer.parentElement;
        if (!anchorEl?.closest(".mupdf-text-layer")) {
          cb(null);
          return;
        }

        const pageEl = anchorEl.closest(".mupdf-page") as HTMLElement | null;
        const pageNum = pageEl
          ? parseInt(pageEl.getAttribute("data-page-number") || "1", 10)
          : 1;

        const startLine = anchorEl?.closest("text");
        const endLine = range.endContainer.parentElement?.closest("text");
        const before = range.cloneRange();
        const after = range.cloneRange();
        if (startLine) {
          before.selectNodeContents(startLine);
          before.setEnd(range.startContainer, range.startOffset);
        }
        if (endLine) {
          after.selectNodeContents(endLine);
          after.setStart(range.endContainer, range.endOffset);
        }
        const getBounds = measurePdfSelection(range, container);
        const rect = getBounds();
        if (!rect) {
          cb(null);
          return;
        }

        let pdfX = 0;
        let pdfY = 0;
        if (pageEl) {
          const pageRect = pageEl.getBoundingClientRect();
          const currentScale = scaleRef.current;
          pdfX = (rect.left - pageRect.left) / currentScale;
          pdfY = (rect.top - pageRect.top) / currentScale;
        }
        if (startLine && startLine.getNumberOfChars() > 0) {
          // SyncTeX expects a point on the text, not the union rectangle's
          // upper edge (which can be above the line or in another column).
          const point = startLine.getStartPositionOfChar(
            Math.min(range.startOffset, startLine.getNumberOfChars() - 1),
          );
          pdfX = point.x;
          pdfY = point.y;
        }

        cb({
          text,
          context: {
            before: startLine ? before.toString() : "",
            after: endLine ? after.toString() : "",
          },
          getBounds,
          viewport: container,
          clear: clearSelection,
          pageNumber: pageNum,
          position: { top: rect.bottom, left: rect.left },
          pdfX,
          pdfY,
        });
      }, 300);
    };

    // Capture pane changes even when an editor consumes the pointer event.
    document.addEventListener("mousedown", handleMouseDown, true);
    document.addEventListener("focusin", handleFocusIn, true);
    container.addEventListener("keydown", handleKeyDown);
    document.addEventListener("selectionchange", rememberSelection);
    if (!isolatedSelection) {
      window.addEventListener(SELECTION_OWNER_EVENT, clearForEditorSelection);
    }
    container.addEventListener("mouseup", handleMouseUp);
    return () => {
      cancelPendingSelection();
      document.removeEventListener("mousedown", handleMouseDown, true);
      document.removeEventListener("focusin", handleFocusIn, true);
      container.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("selectionchange", rememberSelection);
      window.removeEventListener(
        SELECTION_OWNER_EVENT,
        clearForEditorSelection,
      );
      container.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isolatedSelection, retainSelectionPages]);

  // Track current visible page on scroll
  const currentPageChangeRef = useRef(onCurrentPageChange);
  currentPageChangeRef.current = onCurrentPageChange;
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !isActive) return;

    let rafId = 0;
    const handleScroll = () => {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        if (isNavigationScrolling(container)) return;
        const cb = currentPageChangeRef.current;
        if (cb) cb(getVisiblePage());
        const scrollPosition = getScrollPosition();
        if (scrollPosition && !readingAnchor.preserving()) {
          scrollPositionChangeRef.current?.(scrollPosition);
        }
      });
    };

    container.addEventListener("scroll", handleScroll, { passive: true });
    container.addEventListener(NAVIGATION_SCROLL_END, handleScroll);
    // Fire initial value
    handleScroll();
    return () => {
      container.removeEventListener("scroll", handleScroll);
      container.removeEventListener(NAVIGATION_SCROLL_END, handleScroll);
      cancelAnimationFrame(rafId);
    };
  }, [pageSizes, isActive]);

  // Expose scrollToPage via ref
  useEffect(() => {
    if (!scrollToPageRef) return;
    scrollToPageRef.current = (page: number, pdfY?: number) => {
      const container = containerRef.current;
      if (container) scrollToPage(container, page, pdfY);
    };
    return () => {
      if (scrollToPageRef) scrollToPageRef.current = null;
    };
  }, [scrollToPageRef, pageSizes]);

  // Keyboard zoom (Cmd/Ctrl +/-) — scoped to container to avoid affecting other panels
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !onScaleChange) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;

      if (e.key === "=" || e.key === "+") {
        e.preventDefault();
        onScaleChange(clampPdfScale(scale + 0.25));
      } else if (e.key === "-") {
        e.preventDefault();
        onScaleChange(clampPdfScale(scale - 0.25));
      } else if (e.key === "0") {
        e.preventDefault();
        onScaleChange(1);
      }
    };

    container.addEventListener("keydown", handleKeyDown);
    return () => container.removeEventListener("keydown", handleKeyDown);
  }, [scale, onScaleChange]);

  // Intercept link clicks
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      const anchor = target.closest("a") as HTMLAnchorElement | null;
      if (!anchor) return;
      if (!anchor.closest(".mupdf-link-layer")) return;

      e.preventDefault();
      e.stopPropagation();

      const href = anchor.getAttribute("href");
      if (!href) return;

      const origin = {
        top: container.scrollTop,
        left: container.scrollLeft,
        page: Number(
          anchor.closest<HTMLElement>("[data-page-number]")?.dataset
            .pageNumber ?? 1,
        ),
      };
      if (href.includes("#page=")) {
        const match = href.match(/#page=(\d+)/);
        if (match) {
          const pageNum = parseInt(match[1], 10);
          const pageEl = container.querySelector(
            `[data-page-number="${pageNum}"]`,
          ) as HTMLElement | null;
          if (pageEl) {
            setLinkReturn(origin);
            pageEl.scrollIntoView({ behavior: "smooth", block: "start" });
          }
        }
        return;
      }

      if (
        href.startsWith("http://") ||
        href.startsWith("https://") ||
        href.startsWith("mailto:")
      ) {
        ask(`Open in browser?\n${href}`, {
          title: "External Link",
          kind: "info",
          okLabel: "Open",
          cancelLabel: "Cancel",
        }).then((confirmed) => {
          if (confirmed) {
            setLinkReturn(origin);
            shellOpen(href);
          }
        });
      }
    };

    container.addEventListener("click", handleClick, true);
    return () => container.removeEventListener("click", handleClick, true);
  }, []);

  // Text layer click for onTextClick
  const handleTextLayerClick = useCallback(
    (e: React.MouseEvent) => {
      if (!onTextClick) return;
      // A drag also emits a click. Navigating to the editor here would steal
      // focus and collapse the PDF selection before its toolbar opens.
      if (window.getSelection()?.isCollapsed === false) return;
      const target = e.target as HTMLElement;
      if (target.tagName === "text" && target.closest(".mupdf-text-layer")) {
        const text = target.textContent?.trim();
        if (text && text.length > 2) {
          onTextClick(text);
        }
      }
    },
    [onTextClick],
  );

  return (
    <div
      ref={searchScope}
      tabIndex={-1}
      data-preview-search-scope
      className="relative flex min-h-0 flex-1 overflow-hidden outline-none"
    >
      <PreviewSearchPanel pdf search={search} {...pdfSearch} />
      <div
        ref={containerRef}
        data-testid="pdf-scroll-container"
        style={{ overflowAnchor: "none" }}
        tabIndex={-1}
        {...{ [LOCAL_ZOOM_SHORTCUTS_ATTR]: "true" }}
        className="app-scrollbar min-h-0 flex-1 overflow-auto outline-none"
        onWheelCapture={onScrollIntent}
        onTouchStartCapture={onScrollIntent}
        onKeyDownCapture={(event) => {
          if (
            [
              "ArrowUp",
              "ArrowDown",
              "PageUp",
              "PageDown",
              "Home",
              "End",
              " ",
            ].includes(event.key)
          )
            onScrollIntent?.();
        }}
        onPointerDownCapture={(event) => {
          if (event.target === event.currentTarget) onScrollIntent?.();
        }}
        onMouseDownCapture={(event) => {
          if (event.button === 0 && !event.ctrlKey)
            containerRef.current?.focus();
        }}
      >
        <div
          ref={contentRef}
          data-pdf-scroll-content="true"
          className="relative flex min-w-fit flex-col items-center p-4 pb-8"
          style={{
            gap: PDF_PAGE_GAP * displayScale,
            transition: pageTransitionDisabled ? "none" : "gap 180ms ease-out",
          }}
          onClick={handleTextLayerClick}
        >
          {loading && numPages === 0 && (
            <div className="flex items-center gap-2 text-muted-foreground">
              <LoaderIcon className="size-4 animate-spin" />
              Loading PDF...
            </div>
          )}
          {pageSizes.map((size, i) => (
            <MupdfPage
              key={`${documentWorkerRevision.current}:${pdfPageRenderKey(docIdRef.current, i)}`}
              canvasCache={canvasCache}
              viewportRef={containerRef}
              renderDetails={isActive && !pinching && !layoutAnimating}
              renderPaused={renderPaused}
              docId={docIdRef.current}
              pageIndex={i}
              scale={displayScale}
              renderScale={scale}
              disableZoomTransition={pageTransitionDisabled}
              pageWidth={size.width}
              pageHeight={size.height}
              isVisible={visiblePages.has(i + 1)}
              retainText={
                selectAllPages ||
                Boolean(
                  selectionPages &&
                    i + 1 >= selectionPages[0] &&
                    i + 1 <= selectionPages[1],
                )
              }
              searchHits={pdfSearch.highlights.get(i)}
            />
          ))}
        </div>
      </div>
      <PdfSelectionHighlight
        viewportRef={containerRef}
        retainedSelection={retainedSelection}
      />
      {linkReturn && (
        <button
          type="button"
          className="absolute top-3 right-3 z-10 inline-flex items-center gap-1.5 rounded-lg border border-border bg-background/95 px-2.5 py-1.5 text-xs shadow-sm hover:bg-accent"
          onClick={() => {
            containerRef.current?.scrollTo({
              top: linkReturn.top,
              left: linkReturn.left,
              behavior: "instant",
            });
            setLinkReturn(null);
          }}
        >
          <ChevronLeftIcon className="size-3.5" aria-hidden="true" />
          Jump back to page {linkReturn.page}
        </button>
      )}
    </div>
  );
}
