import { useLayoutEffect, useMemo, useRef, type RefObject } from "react";
import type { PageSize } from "@/lib/mupdf/types";
import { cancelNavigationScroll } from "@/lib/navigation-scroll";
import {
  alignPdfReadingAnchor,
  createPdfAnchorInterpolator,
  readPdfReadingAnchor,
  type PdfReadingAnchor,
  type PdfReadingAnchorControl,
} from "./pdf-reading-anchor";

/** Scroll synchronization and panel motion share this exact PDF reading point. */
export function usePdfLayoutAnchor(
  containerRef: RefObject<HTMLDivElement | null>,
  layoutAnimating: boolean,
  scale: number,
  sizes: PageSize[],
  documentIdentity: string | Uint8Array,
): PdfReadingAnchorControl {
  const interpolate = useMemo(
    () => createPdfAnchorInterpolator(sizes),
    [sizes],
  );
  const interpolateRef = useRef(interpolate);
  interpolateRef.current = interpolate;
  const anchor = useRef<PdfReadingAnchor | null>(null);
  const preserving = useRef(false);
  const pending = useRef(false);
  const sizesRef = useRef(sizes);
  sizesRef.current = sizes;
  const control = useRef<PdfReadingAnchorControl>({
    read: () => {
      const container = containerRef.current;
      if (!preserving.current && !pending.current && container) {
        anchor.current =
          readPdfReadingAnchor(container, sizesRef.current) ?? anchor.current;
      }
      return anchor.current;
    },
    align: (point, animate = false) => {
      anchor.current = point;
      const container = containerRef.current;
      pending.current =
        !container ||
        !alignPdfReadingAnchor(container, sizesRef.current, point, animate);
    },
    interpolate: (from, to, fraction) =>
      interpolateRef.current(from, to, fraction),
    restore: () => {
      const container = containerRef.current;
      if (
        (preserving.current || pending.current) &&
        anchor.current &&
        container
      ) {
        pending.current = !alignPdfReadingAnchor(
          container,
          sizesRef.current,
          anchor.current,
        );
      }
    },
    preserving: () => preserving.current,
  });

  useLayoutEffect(() => {
    if (containerRef.current) cancelNavigationScroll(containerRef.current);
    anchor.current = null;
    pending.current = false;
    preserving.current = false;
    return () => {
      if (containerRef.current) cancelNavigationScroll(containerRef.current);
    };
  }, [documentIdentity, containerRef]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    if (!layoutAnimating && !preserving.current) {
      if (pending.current && anchor.current) {
        pending.current = !alignPdfReadingAnchor(
          container,
          sizes,
          anchor.current,
        );
      }
      return;
    }
    if (!preserving.current) {
      if (!pending.current) {
        anchor.current =
          readPdfReadingAnchor(container, sizes) ?? anchor.current;
      }
      preserving.current = true;
    }
    let frame = 0;
    let previousGeometry = "";
    let stableFrames = 0;
    const restore = () => {
      const rect = anchor.current
        ? alignPdfReadingAnchor(container, sizes, anchor.current)
        : null;
      pending.current = anchor.current !== null && !rect;
      const geometry = `${container.clientWidth}:${container.clientHeight}:${rect?.width}:${rect?.height}:${scale}`;
      stableFrames = geometry === previousGeometry ? stableFrames + 1 : 0;
      previousGeometry = geometry;
      if (!layoutAnimating && stableFrames >= 3) {
        preserving.current = false;
      } else frame = requestAnimationFrame(restore);
    };
    restore();
    return () => cancelAnimationFrame(frame);
  }, [containerRef, layoutAnimating, scale, sizes, documentIdentity]);

  return control.current;
}
