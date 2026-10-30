import { useEffect, useRef, type RefObject } from "react";
import { getMupdfClient } from "@/lib/mupdf/mupdf-client";
import type { PageRasterRegion } from "@/lib/mupdf/types";
import { APP_VISIBILITY_RESTORED } from "@/lib/debug/log-store";
import { createLogger } from "@/lib/debug/logger";
import type { PdfCanvasCache } from "./pdf-canvas-cache";
import { pdfDetailCovers, pdfDetailRegion } from "./pdf-detail-region";

const log = createLogger("pdf-detail");

export function usePdfDetailCanvas({
  pageRef,
  viewportRef,
  canvasCache,
  docId,
  pageIndex,
  pageWidth,
  pageHeight,
  density,
  baseDensity,
  enabled,
}: {
  pageRef: RefObject<HTMLDivElement | null>;
  viewportRef?: RefObject<HTMLDivElement | null>;
  canvasCache: PdfCanvasCache;
  docId: number;
  pageIndex: number;
  pageWidth: number;
  pageHeight: number;
  density: number;
  baseDensity: number;
  enabled: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const page = pageRef.current;
    const viewport = viewportRef?.current;
    let rendered: PageRasterRegion | null = null;
    const release = () => {
      rendered = null;
      canvas.width = canvas.height = 0;
      canvas.style.display = "none";
      delete canvas.dataset.pdfRenderedScale;
    };
    release();
    if (
      !enabled ||
      !page ||
      !viewport ||
      docId <= 0 ||
      density <= baseDensity + 0.01
    )
      return;

    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    let pending: AbortController | undefined;
    const visibleArea = () => {
      const bounds = page.getBoundingClientRect();
      const frame = viewport.getBoundingClientRect();
      if (
        !bounds.width ||
        !bounds.height ||
        !viewport.clientWidth ||
        !viewport.clientHeight
      )
        return null;
      const left = Math.max(bounds.left, frame.left + viewport.clientLeft);
      const top = Math.max(bounds.top, frame.top + viewport.clientTop);
      const right = Math.min(
        bounds.right,
        frame.left + viewport.clientLeft + viewport.clientWidth,
      );
      const bottom = Math.min(
        bounds.bottom,
        frame.top + viewport.clientTop + viewport.clientHeight,
      );
      if (right <= left || bottom <= top) return null;
      return {
        x: ((left - bounds.left) * pageWidth) / bounds.width,
        y: ((top - bounds.top) * pageHeight) / bounds.height,
        w: ((right - left) * pageWidth) / bounds.width,
        h: ((bottom - top) * pageHeight) / bounds.height,
      };
    };

    const render = async () => {
      const visible = visibleArea();
      if (!visible) {
        canvasCache.remove(canvas);
        release();
        return;
      }
      const region = pdfDetailRegion(pageWidth, pageHeight, visible, density);
      if (!region || region.scale <= baseDensity + 0.01) return;
      if (
        rendered &&
        Math.abs(rendered.scale - region.scale) < 0.001 &&
        pdfDetailCovers(rendered, visible)
      )
        return;
      const request = new AbortController();
      pending = request;
      try {
        const bitmap = await getMupdfClient().drawPageRegion(
          docId,
          pageIndex,
          region,
          request.signal,
        );
        try {
          if (disposed || request.signal.aborted) return;
          const context = canvas.getContext("2d");
          if (!context)
            throw new Error("PDF detail canvas context unavailable");
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
          context.drawImage(bitmap, 0, 0);
          Object.assign(canvas.style, {
            display: "block",
            left: `${(100 * region.x) / region.scale / pageWidth}%`,
            top: `${(100 * region.y) / region.scale / pageHeight}%`,
            width: `${(100 * region.width) / region.scale / pageWidth}%`,
            height: `${(100 * region.height) / region.scale / pageHeight}%`,
          });
          canvas.dataset.pdfRenderedScale = String(region.scale);
          rendered = region;
          canvasCache.store(canvas, () => !disposed, release);
        } finally {
          bitmap.close();
        }
      } catch (error) {
        if (!disposed && !request.signal.aborted) {
          canvasCache.remove(canvas);
          release();
          log.error(`Render error page ${pageIndex}`, { error: String(error) });
        }
      }
    };

    const schedule = () => {
      clearTimeout(timer);
      pending?.abort();
      // The base page remains visible during movement and while this job runs.
      timer = setTimeout(() => void render(), 100);
    };
    const restore = () => {
      canvasCache.remove(canvas);
      release();
      schedule();
    };
    const resize = new ResizeObserver(schedule);
    resize.observe(viewport);
    resize.observe(page);
    viewport.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener(APP_VISIBILITY_RESTORED, restore);
    schedule();
    return () => {
      disposed = true;
      clearTimeout(timer);
      pending?.abort();
      resize.disconnect();
      viewport.removeEventListener("scroll", schedule);
      window.removeEventListener(APP_VISIBILITY_RESTORED, restore);
      canvasCache.remove(canvas);
      release();
    };
  }, [
    pageRef,
    viewportRef,
    canvasCache,
    docId,
    pageIndex,
    pageWidth,
    pageHeight,
    density,
    baseDensity,
    enabled,
  ]);

  return canvasRef;
}
