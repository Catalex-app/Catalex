import { clampPdfScale } from "./pdf-zoom";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";

/** Preview a pinch with existing pixels; render the PDF only when it settles. */
export function usePdfPinchZoom(
  containerRef: RefObject<HTMLDivElement | null>,
  contentRef: RefObject<HTMLDivElement | null>,
  scale: number,
  onScaleChange: ((scale: number) => void) | undefined,
  documentId: number,
  isActive: boolean,
) {
  const [pinching, setPinching] = useState(false);
  const current = useRef({ scale, onScaleChange });
  current.current = { scale, onScaleChange };
  const gesture = useRef<{
    scale: number;
    baseScale: number;
    page: HTMLElement;
    x: number;
    y: number;
    clientX: number;
    clientY: number;
  } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const frame = useRef(0);
  const settlingAnimation = useRef<Animation | null>(null);

  const clearPreview = () => {
    settlingAnimation.current?.cancel();
    settlingAnimation.current = null;
    const content = contentRef.current;
    if (content) {
      content.style.transform = "";
      content.style.transformOrigin = "";
      content.style.willChange = "";
    }
  };

  useLayoutEffect(() => {
    const pending = gesture.current;
    const container = containerRef.current;
    if (!pending || !container) return;
    clearTimeout(timer.current);
    cancelAnimationFrame(frame.current);
    frame.current = 0;
    clearPreview();
    if (pending.page.isConnected) {
      const rect = pending.page.getBoundingClientRect();
      container.scrollLeft +=
        rect.left + pending.x * rect.width - pending.clientX;
      container.scrollTop +=
        rect.top + pending.y * rect.height - pending.clientY;
      // Animate only the displacement that the available scroll range cannot absorb.
      const settledRect = pending.page.getBoundingClientRect();
      const offsetX =
        pending.clientX - (settledRect.left + pending.x * settledRect.width);
      const content = contentRef.current;
      if (
        content?.animate &&
        Math.abs(offsetX) > 0.5 &&
        !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
      ) {
        settlingAnimation.current = content.animate(
          [
            { transform: `translateX(${offsetX}px)` },
            { transform: "translateX(0)" },
          ],
          { duration: 140, easing: "ease-out" },
        );
      }
    }
    gesture.current = null;
    setPinching(false);
  }, [scale]);

  useEffect(() => {
    const container = containerRef.current;
    const content = contentRef.current;
    if (!container || !content || !isActive || !onScaleChange) return;
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      let pending = gesture.current;
      if (!pending) {
        clearPreview();
        const pages = [
          ...content.querySelectorAll<HTMLElement>("[data-page-number]"),
        ];
        const page =
          pages.find((page) => {
            const rect = page.getBoundingClientRect();
            return rect.bottom >= event.clientY;
          }) ?? pages[pages.length - 1];
        if (!page) return;
        const rect = page.getBoundingClientRect();
        const bounds = content.getBoundingClientRect();
        pending = {
          scale: current.current.scale,
          baseScale: current.current.scale,
          page,
          x: (event.clientX - rect.left) / rect.width,
          y: (event.clientY - rect.top) / rect.height,
          clientX: event.clientX,
          clientY: event.clientY,
        };
        gesture.current = pending;
        content.style.transformOrigin = `${event.clientX - bounds.left}px ${event.clientY - bounds.top}px`;
        content.style.willChange = "transform";
        setPinching(true);
      }
      const delta =
        event.deltaY *
        (event.deltaMode === 1
          ? 16
          : event.deltaMode === 2
            ? container.clientHeight
            : 1);
      pending.scale = clampPdfScale(pending.scale * Math.exp(-delta * 0.005));
      // Keep the scheduled frame: high-frequency wheel events only update its
      // target, rather than repeatedly postponing the visible response.
      if (!frame.current) {
        frame.current = requestAnimationFrame(() => {
          frame.current = 0;
          const latest = gesture.current;
          if (latest)
            content.style.transform = `scale(${latest.scale / latest.baseScale})`;
        });
      }
      clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        const latest = gesture.current;
        if (!latest) return;
        if (latest.scale === current.current.scale) {
          cancelAnimationFrame(frame.current);
          frame.current = 0;
          clearPreview();
          gesture.current = null;
          setPinching(false);
        } else current.current.onScaleChange?.(latest.scale);
      }, 140);
    };
    container.addEventListener("wheel", wheel, { passive: false });
    return () => {
      container.removeEventListener("wheel", wheel);
      clearTimeout(timer.current);
      cancelAnimationFrame(frame.current);
      frame.current = 0;
      clearPreview();
      gesture.current = null;
      setPinching(false);
    };
  }, [documentId, isActive, Boolean(onScaleChange)]);
  return pinching;
}
