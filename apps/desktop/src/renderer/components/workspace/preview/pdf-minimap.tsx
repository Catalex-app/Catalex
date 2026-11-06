import { useContext, useEffect, useRef, useState, type RefObject } from "react";
import { useSettingsStore } from "@/stores/settings-store";
import type { PageSize } from "@/lib/mupdf/types";
import {
  DocumentMinimap,
  type MinimapGeometry,
} from "../editor/document-minimap";
import {
  clusterMinimapMarkers,
  type MinimapLayer,
  type MinimapMarker,
} from "../editor/editor-minimap-model";
import { commentLabel } from "../editor/inline-comments";
import {
  PdfCommentsContext,
  useRevealPdfComment,
  type PdfCommentTarget,
} from "./pdf-comments";
import { findPdfPageAtY } from "./pdf-reading-anchor";

const layerGroups: { label: string; layers: MinimapLayer[] }[] = [
  { label: "Human comments", layers: ["human"] },
  { label: "Agent comments", layers: ["agent"] },
];
type Location = { target: PdfCommentTarget; page: number; y: number };

/** Use the existing immutable anchors or current SyncTeX map, never page rasters. */
export async function locatePdfMinimapComments(
  context: NonNullable<React.ContextType<typeof PdfCommentsContext>>,
  pageCount: number,
  signal: AbortSignal,
): Promise<Location[]> {
  const locations: Location[] = [];
  const pending = new Set(context.targets);
  for (const target of pending) {
    const anchor = target.comment.pdf;
    if (!anchor) continue;
    pending.delete(target);
    const region = anchor.regions[0];
    if (region && region.page <= pageCount)
      locations.push({ target, page: region.page, y: region.y });
  }
  for (let page = 1; page <= pageCount && pending.size; page++) {
    if (signal.aborted) return [];
    const boxes = await context.lookup(page, signal);
    if (signal.aborted) return [];
    for (const target of pending) {
      let y = Infinity;
      for (const box of boxes) {
        if (
          box.sources.some(
            (source) =>
              source.file === target.filePath &&
              source.line >= target.firstLine &&
              source.line <= target.lastLine,
          )
        )
          y = Math.min(y, box.y);
      }
      if (Number.isFinite(y)) {
        locations.push({ target, page, y });
        pending.delete(target);
      }
    }
  }
  return signal.aborted
    ? []
    : locations.sort((a, b) => a.page - b.page || a.y - b.y);
}

export function PdfMinimap({
  viewportRef,
  contentRef,
  pageSizes,
  onScrollIntent,
}: {
  viewportRef: RefObject<HTMLDivElement | null>;
  contentRef: RefObject<HTMLDivElement | null>;
  pageSizes: PageSize[];
  onScrollIntent?: () => void;
}) {
  const context = useContext(PdfCommentsContext);
  const reveal = useRevealPdfComment();
  const trackRef = useRef<HTMLDivElement>(null);
  const layers = useSettingsStore((state) => state.editorMinimapLayers);
  const [located, setLocated] = useState<{
    context: typeof context;
    pages: PageSize[];
    locations: Location[];
  } | null>(null);
  useEffect(() => {
    if (!context || !pageSizes.length) return;
    const controller = new AbortController();
    void locatePdfMinimapComments(context, pageSizes.length, controller.signal)
      .then((locations) => {
        if (!controller.signal.aborted)
          setLocated({ context, pages: pageSizes, locations });
      })
      .catch(() => {
        if (!controller.signal.aborted) setLocated(null);
      });
    return () => controller.abort();
  }, [context, pageSizes]);
  // A recompile, replacement, or comments visibility change invalidates old markers immediately.
  const locations =
    located?.context === context && located?.pages === pageSizes
      ? located.locations
      : [];
  const [geometry, setGeometry] = useState<
    MinimapGeometry & {
      first: number;
      last: number;
      positions: Map<string, { top: number; bottom: number }>;
    }
  >({
    height: 1,
    scrollTop: 0,
    scrollHeight: 1,
    clientHeight: 1,
    first: 1,
    last: 1,
    positions: new Map(),
  });
  useEffect(() => {
    const viewport = viewportRef.current;
    const track = trackRef.current;
    const content = contentRef.current;
    if (!viewport || !track || !content) return;
    let frame = 0;
    const measure = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const height = track.clientHeight;
        const { scrollTop, scrollHeight, clientHeight } = viewport;
        const handle = Math.min(
          height,
          Math.max(12, (height * clientHeight) / Math.max(1, scrollHeight)),
        );
        const maxScroll = scrollHeight - clientHeight;
        const scale =
          maxScroll > 0
            ? (height - handle) / maxScroll
            : height / Math.max(1, scrollHeight);
        const inset = maxScroll > 0 ? (handle - clientHeight * scale) / 2 : 0;
        const rect = viewport.getBoundingClientRect();
        const positions = new Map<string, { top: number; bottom: number }>();
        for (const location of locations) {
          const page = viewport.querySelector<HTMLElement>(
            `[data-page-number="${location.page}"]`,
          );
          if (!page) continue;
          const pageRect = page.getBoundingClientRect();
          const y =
            pageRect.top -
            rect.top +
            scrollTop +
            (location.y * pageRect.height) /
              pageSizes[location.page - 1].height;
          const top = inset + y * scale;
          positions.set(location.target.comment.id, { top, bottom: top });
        }
        setGeometry({
          height,
          scrollTop,
          scrollHeight,
          clientHeight,
          positions,
          first: findPdfPageAtY(viewport, pageSizes.length, rect.top),
          last: findPdfPageAtY(viewport, pageSizes.length, rect.bottom),
        });
      });
    };
    const resize = new ResizeObserver(measure);
    for (const element of [viewport, content, track]) resize.observe(element);
    viewport.addEventListener("scroll", measure, { passive: true });
    measure();
    return () => {
      resize.disconnect();
      viewport.removeEventListener("scroll", measure);
      cancelAnimationFrame(frame);
    };
  }, [viewportRef, contentRef, pageSizes, located, context]);
  const markers: MinimapMarker[] = locations.map(({ target, page }, index) => ({
    id: target.comment.id,
    commentId: target.comment.id,
    layer: target.comment.origin ? "agent" : "human",
    kind: target.comment.origin ? "agent" : "human",
    line: page,
    endLine: page,
    from: index,
    title: `Comment ${commentLabel(target.comment)}`,
    detail: target.comment.text.trim().slice(0, 260),
  }));
  return (
    <DocumentMinimap
      kind="pdf"
      trackRef={trackRef}
      scrollElement={viewportRef.current}
      geometry={geometry}
      layerGroups={layerGroups}
      clusters={clusterMinimapMarkers(
        markers,
        pageSizes.length,
        geometry.height,
        layers,
        geometry.positions,
      )}
      navigationLabel={`Navigate PDF, visible pages ${geometry.first} to ${geometry.last} of ${pageSizes.length}`}
      locationLabel={(marker) => `Page ${marker.line}`}
      onScrollIntent={onScrollIntent}
      onNavigate={(items) => {
        const location = locations.find(
          ({ target }) => target.comment.id === items[0]?.id,
        );
        const viewport = viewportRef.current;
        if (!location || !viewport) return;
        const page = viewport.querySelector<HTMLElement>(
          `[data-page-number="${location.page}"]`,
        );
        if (!page) return;
        onScrollIntent?.();
        const rect = page.getBoundingClientRect();
        viewport.scrollTop +=
          rect.top -
          viewport.getBoundingClientRect().top +
          (location.y * rect.height) / pageSizes[location.page - 1].height -
          viewport.clientHeight * 0.35;
        reveal?.(location.target);
      }}
      onKeyDown={(event) => {
        const viewport = viewportRef.current;
        if (!viewport) return;
        const top =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? viewport.scrollHeight
              : event.key === "ArrowUp"
                ? viewport.scrollTop - 40
                : event.key === "ArrowDown"
                  ? viewport.scrollTop + 40
                  : event.key === "PageUp"
                    ? viewport.scrollTop - viewport.clientHeight
                    : event.key === "PageDown"
                      ? viewport.scrollTop + viewport.clientHeight
                      : null;
        if (top !== null) {
          event.preventDefault();
          onScrollIntent?.();
          viewport.scrollTo({ top, behavior: "instant" });
        }
      }}
    />
  );
}
