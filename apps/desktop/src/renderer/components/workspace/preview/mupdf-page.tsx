import { pdfRasterScale } from "./pdf-zoom";
import { usePdfDetailCanvas } from "./use-pdf-detail-canvas";
import type { PdfCanvasCache } from "./pdf-canvas-cache";
import type { PdfSearchHit } from "./pdf-search";
import { alignPdfLinkToText } from "./pdf-link-geometry";
import {
  useEffect,
  useRef,
  useState,
  useCallback,
  useMemo,
  memo,
  type RefObject,
} from "react";
import { getMupdfClient } from "@/lib/mupdf/mupdf-client";
import { createLogger } from "@/lib/debug/logger";
import { APP_VISIBILITY_RESTORED } from "@/lib/debug/log-store";
import type { StructuredTextData, LinkData } from "@/lib/mupdf/types";

import { PdfCommentLayer } from "./pdf-comments";

const log = createLogger("mupdf-page");

interface MupdfPageProps {
  canvasCache: PdfCanvasCache;
  viewportRef?: RefObject<HTMLDivElement | null>;
  renderDetails?: boolean;
  renderPaused?: boolean;
  docId: number;
  pageIndex: number;
  scale: number;
  renderScale?: number;
  disableZoomTransition?: boolean;
  pageWidth: number;
  pageHeight: number;
  isVisible: boolean;
  retainText?: boolean;
  searchHits?: PdfSearchHit[];
}

/** Check if a canvas appears blank (GPU context was silently invalidated).
 *  Uses a single getImageData call covering a small center region. */
function isCanvasBlank(canvas: HTMLCanvasElement): boolean {
  if (canvas.width === 0 || canvas.height === 0) return true;
  const ctx = canvas.getContext("2d");
  if (!ctx) return true; // context fully lost
  // Sample a 2x2 region from the center in one GPU readback
  const cx = Math.max(0, Math.floor(canvas.width / 2) - 1);
  const cy = Math.max(0, Math.floor(canvas.height / 2) - 1);
  try {
    const data = ctx.getImageData(cx, cy, 2, 2).data;
    // If all sampled pixels have zero alpha, canvas is blank
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] !== 0) return false;
    }
  } catch {
    // A lost context can also reject readback; let rendering recover it.
    return true;
  }
  return true;
}

export const MupdfPage = memo(function MupdfPage({
  canvasCache,
  viewportRef,
  renderDetails = true,
  renderPaused = false,
  docId,
  pageIndex,
  scale,
  renderScale = scale,
  disableZoomTransition = false,
  pageWidth,
  pageHeight,
  isVisible,
  retainText = false,
  searchHits,
}: MupdfPageProps) {
  const pageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [textData, setTextData] = useState<StructuredTextData | null>(null);
  const [links, setLinks] = useState<LinkData[]>([]);
  const renderGenRef = useRef(0);
  const pendingRender = useRef<AbortController | null>(null);
  const renderedKey = useRef<string | null>(null);
  const pixelsNeedValidation = useRef(true);
  // Offscreen canvases may lose backing pixels. Ordinary motion of an already
  // visible page does not need a synchronous GPU readback to reuse its pixels.
  if (!isVisible) pixelsNeedValidation.current = true;
  const protectedPage = useRef(isVisible);
  protectedPage.current = isVisible;

  const releasePixels = useCallback(() => {
    renderGenRef.current++;
    pendingRender.current?.abort();
    renderedKey.current = null;
    const canvas = canvasRef.current;
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
      delete canvas.dataset.pdfRenderedScale;
    }
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current!;
    // Even pages never rendered should not allocate the default 300x150 canvas.
    canvas.width = 0;
    canvas.height = 0;
    return () => {
      renderGenRef.current++;
      renderedKey.current = null;
      canvasCache.remove(canvas);
      canvas.width = 0;
      canvas.height = 0;
    };
  }, [canvasCache]);

  const cssW = pageWidth * scale;
  const cssH = pageHeight * scale;
  const zoomTransition = disableZoomTransition
    ? "none"
    : "width 180ms ease-out, height 180ms ease-out";

  const dpr = window.devicePixelRatio || 1;
  const rasterScale = pdfRasterScale(pageWidth, pageHeight, renderScale, dpr);
  const rasterKey = `${docId}:${pageIndex}:${rasterScale}`;
  const detailRef = usePdfDetailCanvas({
    pageRef,
    viewportRef,
    canvasCache,
    docId,
    pageIndex,
    pageWidth,
    pageHeight,
    density: renderScale * dpr,
    baseDensity: rasterScale,
    enabled:
      isVisible && !renderPaused && renderDetails && scale === renderScale,
  });

  const renderPage = useCallback(
    (force = false) => {
      const canvas = canvasRef.current;
      if (!canvas || !isVisible || renderPaused || docId <= 0) return;
      const key = rasterKey;
      if (
        !force &&
        renderedKey.current === key &&
        (!pixelsNeedValidation.current || !isCanvasBlank(canvas))
      ) {
        pixelsNeedValidation.current = false;
        canvasCache.touch(canvas);
        return;
      }
      const gen = ++renderGenRef.current;
      pendingRender.current?.abort();
      const request = new AbortController();
      pendingRender.current = request;
      getMupdfClient()
        .drawPage(docId, pageIndex, rasterScale * 72, request.signal)
        .then((bitmap) => {
          try {
            if (gen !== renderGenRef.current) return;
            const ctx = canvas.getContext("2d");
            if (!ctx) throw new Error("PDF canvas context unavailable");
            // Publish only once the worker's bitmap is ready.
            canvas.width = bitmap.width;
            canvas.height = bitmap.height;
            ctx.drawImage(bitmap, 0, 0);
            canvas.dataset.pdfRenderedScale = String(rasterScale / dpr);
            renderedKey.current = key;
            pixelsNeedValidation.current = false;
            canvasCache.store(
              canvas,
              () => protectedPage.current,
              releasePixels,
            );
          } catch (err) {
            canvasCache.remove(canvas);
            releasePixels();
            log.error(`Render error page ${pageIndex}`, { error: String(err) });
          } finally {
            bitmap.close();
          }
        })
        .catch((err) => {
          if (gen !== renderGenRef.current) return;
          log.error(`Render error page ${pageIndex}`, { error: String(err) });
        });
    },
    [
      docId,
      pageIndex,
      rasterKey,
      rasterScale,
      dpr,
      isVisible,
      renderPaused,
      canvasCache,
      releasePixels,
    ],
  );

  useEffect(() => {
    if (isVisible) renderPage();
    else {
      if (renderedKey.current !== rasterKey && canvasRef.current)
        canvasCache.remove(canvasRef.current);
    }
    canvasCache.trim();
    // Do not let a late worker/bitmap result repopulate a page after leaving it.
    return () => {
      renderGenRef.current++;
      pendingRender.current?.abort();
    };
  }, [renderPage, isVisible, rasterKey, canvasCache]);

  useEffect(() => {
    setTextData(null);
    setLinks([]);
  }, [docId, pageIndex]);

  useEffect(() => {
    if (isVisible || retainText) return;
    setTextData(null);
    setLinks([]);
  }, [isVisible, retainText]);

  // Initial render and re-render on dependency changes
  useEffect(() => {
    if ((!isVisible && !retainText) || docId <= 0) return;

    const client = getMupdfClient();
    let cancelled = false;

    const overlayTimer = setTimeout(() => {
      if (cancelled) return;

      client
        .getPageText(docId, pageIndex)
        .then((data) => {
          if (cancelled) return;
          setTextData(data);
        })
        .catch(() => {});

      client
        .getPageLinks(docId, pageIndex)
        .then((data) => {
          if (cancelled) return;
          setLinks(data);
        })
        .catch(() => {});
    }, 100);

    return () => {
      cancelled = true;
      clearTimeout(overlayTimer);
    };
  }, [docId, pageIndex, isVisible, retainText]);

  // Re-render canvas when returning from background if content was lost
  useEffect(() => {
    const handleVisibilityRestored = () => {
      const canvas = canvasRef.current;
      if (!canvas || !isVisible || docId <= 0) return;
      if (isCanvasBlank(canvas)) {
        pixelsNeedValidation.current = true;
        log.warn(
          `Canvas blank after visibility restore, re-rendering page ${pageIndex}`,
        );
        renderPage(true);
      }
    };

    window.addEventListener(APP_VISIBILITY_RESTORED, handleVisibilityRestored);
    return () =>
      window.removeEventListener(
        APP_VISIBILITY_RESTORED,
        handleVisibilityRestored,
      );
  }, [docId, pageIndex, renderScale, isVisible, retainText, renderPage]);

  // Text/link coordinates are in PDF space and do not change with CSS zoom.
  const textLines = useMemo(
    () =>
      textData?.blocks.map(
        (block, bi) =>
          block.type === "text" &&
          block.lines.map((line, li) => (
            <text
              key={`${bi}-${li}`}
              x={
                line.chars?.length
                  ? line.chars
                      .flatMap((char) =>
                        Array.from(
                          char.c,
                          (_, index) =>
                            char.origin.x +
                            (index * (char.quad[2] - char.quad[0])) /
                              Array.from(char.c).length,
                        ),
                      )
                      .join(" ")
                  : line.bbox.x
              }
              y={
                line.chars?.length
                  ? line.chars
                      .flatMap((char) =>
                        Array.from(char.c, () => char.origin.y),
                      )
                      .join(" ")
                  : line.y
              }
              fontSize={line.font.size}
              fontFamily={line.font.family || line.font.name || "serif"}
              fontWeight={line.font.weight}
              fontStyle={line.font.style}
              textLength={
                !line.chars?.length && line.bbox.w > 0 ? line.bbox.w : undefined
              }
              lengthAdjust="spacingAndGlyphs"
            >
              {line.text}
            </text>
          )),
      ),
    [textData],
  );
  const alignedLinks = useMemo(
    () => links.map((link) => alignPdfLinkToText(link, textData)),
    [links, textData],
  );

  return (
    <div
      ref={pageRef}
      className="mupdf-page relative bg-white"
      data-page-number={pageIndex + 1}
      style={{
        width: cssW,
        height: cssH,
        // Match shadow-lg at 100%, scaling its geometry with the paper.
        boxShadow: `0 ${10 * scale}px ${15 * scale}px ${-3 * scale}px rgb(0 0 0 / 0.1), 0 ${4 * scale}px ${6 * scale}px ${-4 * scale}px rgb(0 0 0 / 0.1)`,
        transition: disableZoomTransition
          ? "none"
          : `${zoomTransition}, box-shadow 180ms ease-out`,
      }}
    >
      <canvas
        ref={canvasRef}
        data-pdf-page-canvas
        style={{
          width: cssW,
          height: cssH,
          display: "block",
          transition: zoomTransition,
        }}
      />

      {viewportRef && renderScale * dpr > rasterScale + 0.01 && (
        <canvas
          ref={detailRef}
          data-pdf-detail-canvas
          aria-hidden="true"
          tabIndex={-1}
          className="pointer-events-none absolute"
          style={{ display: "none" }}
        />
      )}

      {searchHits?.length ? (
        <svg
          aria-hidden="true"
          data-pdf-search-highlights
          className="pointer-events-none absolute top-0 left-0"
          viewBox={`0 0 ${pageWidth} ${pageHeight}`}
          style={{ width: cssW, height: cssH, transition: zoomTransition }}
        >
          {searchHits.flatMap((hit, index) =>
            hit.rects.map((rect, part) => (
              <rect
                key={`${index}-${part}`}
                x={rect.x}
                y={rect.y}
                width={rect.w}
                height={rect.h}
                fill={
                  hit.active
                    ? "rgba(249, 115, 22, 0.45)"
                    : "rgba(250, 204, 21, 0.35)"
                }
              />
            )),
          )}
        </svg>
      ) : null}

      {/* Text layer for selection */}
      {textData && (
        <svg
          className="mupdf-text-layer"
          viewBox={`0 0 ${pageWidth} ${pageHeight}`}
          preserveAspectRatio="none"
          style={{ width: cssW, height: cssH, transition: zoomTransition }}
        >
          {textLines}
        </svg>
      )}

      {textData && (
        <PdfCommentLayer
          textData={textData}
          pageNumber={pageIndex + 1}
          pageWidth={pageWidth}
          pageHeight={pageHeight}
          pageElement={pageRef}
          links={alignedLinks}
        />
      )}

      {/* Link layer */}
      {links.length > 0 && (
        <div className="mupdf-link-layer">
          {alignedLinks.map((link, i) => (
            // biome-ignore lint/a11y/useAnchorContent: PDF link overlays need an accessible name without hidden text that can paint in WebKit.
            <a
              key={i}
              href={link.href}
              aria-label="Link"
              data-external={link.isExternal ? "true" : undefined}
              style={{
                left: `${(link.x / pageWidth) * 100}%`,
                top: `${(link.y / pageHeight) * 100}%`,
                width: `${(link.w / pageWidth) * 100}%`,
                height: `${(link.h / pageHeight) * 100}%`,
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
});
