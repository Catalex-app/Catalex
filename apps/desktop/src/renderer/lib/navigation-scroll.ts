export const NAVIGATION_SCROLL_DURATION_MS = 180;
export const NAVIGATION_SCROLL_END = "catalex:navigation-scroll-end";

type Position = { top: number; left?: number };
const active = new WeakMap<HTMLElement, () => void>();
const highlights = new WeakMap<HTMLElement, () => void>();
const HIGHLIGHT_DURATION_MS = 1100;

export function isNavigationScrolling(element: HTMLElement) {
  return active.has(element);
}

export function cancelNavigationScroll(element: HTMLElement) {
  active.get(element)?.();
  highlights.get(element)?.();
}

/** Mark the actual destination once the scroller and its content have settled. */
export function highlightNavigationTarget(
  scroller: HTMLElement,
  pane: "editor" | "markdown" | "pdf",
  getBounds: () => DOMRectReadOnly | null,
) {
  highlights.get(scroller)?.();
  const doc = scroller.ownerDocument;
  const win = doc.defaultView;
  if (!win) return;
  const rootScroll = scroller === doc.scrollingElement;
  const scrollTarget = rootScroll ? doc : scroller;
  const marker = doc.createElement("div");
  let timer = 0;
  let resizeObserver: ResizeObserver | undefined;
  const clear = () => {
    win.cancelAnimationFrame(frame);
    win.clearTimeout(timer);
    scrollTarget.removeEventListener("scroll", clear);
    win.removeEventListener("resize", clear);
    resizeObserver?.disconnect();
    marker.remove();
    highlights.delete(scroller);
  };
  const frame = win.requestAnimationFrame(() => {
    const bounds = scroller.isConnected ? getBounds() : null;
    if (!bounds || bounds.width <= 0 || bounds.height <= 0) return clear();
    const viewport = scroller.getBoundingClientRect();
    const viewportLeft = rootScroll ? 0 : viewport.left + scroller.clientLeft;
    const viewportTop = rootScroll ? 0 : viewport.top + scroller.clientTop;
    const left = Math.max(bounds.left - 2, viewportLeft);
    const top = Math.max(bounds.top - 2, viewportTop);
    const right = Math.min(
      bounds.right + 2,
      viewportLeft + scroller.clientWidth,
    );
    const bottom = Math.min(
      bounds.bottom + 2,
      viewportTop + scroller.clientHeight,
    );
    if (right <= left || bottom <= top) return clear();
    marker.dataset.navigationHighlight = pane;
    marker.setAttribute("aria-hidden", "true");
    Object.assign(marker.style, {
      position: "absolute",
      left: "0",
      top: "0",
      pointerEvents: "none",
    });
    (rootScroll ? doc.body : scroller).append(marker);
    // Convert viewport bounds into the marker's containing block coordinates.
    const origin = marker.getBoundingClientRect();
    const appRoot = (win.frameElement?.ownerDocument ?? doc).documentElement;
    const colorScheme =
      doc.documentElement.dataset.colorScheme ??
      (appRoot.classList.contains("dark") ? "dark" : "light");
    const azure = colorScheme === "dark" ? "81 183 246" : "8 123 190";
    Object.assign(marker.style, {
      left: `${left - origin.left}px`,
      top: `${top - origin.top}px`,
      width: `${right - left}px`,
      height: `${bottom - top}px`,
      boxSizing: "border-box",
      zIndex: "30",
      border: `1px solid rgb(${azure} / 0.9)`,
      borderRadius: "4px",
      background: `rgb(${azure} / 0.1)`,
    });
    if (!win.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      marker.animate(
        [{ opacity: 1 }, { opacity: 1, offset: 0.72 }, { opacity: 0 }],
        HIGHLIGHT_DURATION_MS,
      );
    }
    scrollTarget.addEventListener("scroll", clear);
    win.addEventListener("resize", clear);
    const { clientWidth, clientHeight } = scroller;
    resizeObserver = new ResizeObserver(() => {
      if (
        !scroller.isConnected ||
        scroller.clientWidth !== clientWidth ||
        scroller.clientHeight !== clientHeight
      )
        clear();
    });
    resizeObserver.observe(scroller);
    timer = win.setTimeout(clear, HIGHLIGHT_DURATION_MS);
  });
  highlights.set(scroller, clear);
}

/** Short, interruptible motion for explicit navigation, never live scroll sync. */
export function scrollForNavigation(
  element: HTMLElement,
  destination: Position | (() => Position),
  onArrival?: () => void,
): void {
  cancelNavigationScroll(element);
  const startTop = element.scrollTop;
  const startLeft = element.scrollLeft;
  const readTarget = () => {
    const target =
      typeof destination === "function" ? destination() : destination;
    return {
      top: Math.max(
        0,
        Math.min(element.scrollHeight - element.clientHeight, target.top),
      ),
      left: Math.max(
        0,
        Math.min(
          element.scrollWidth - element.clientWidth,
          target.left ?? startLeft,
        ),
      ),
    };
  };
  const initial = readTarget();
  const win = element.ownerDocument.defaultView ?? window;
  if (
    win.matchMedia?.("(prefers-reduced-motion: reduce)").matches ||
    element.clientWidth <= 1 ||
    element.clientHeight <= 1 ||
    Math.max(
      Math.abs(initial.top - startTop),
      Math.abs(initial.left - startLeft),
    ) <= 1
  ) {
    element.scrollTop = initial.top;
    element.scrollLeft = initial.left;
    onArrival?.();
    return;
  }
  let frame = 0;
  const began = win.performance.now();
  const interruptEvents = [
    "wheel",
    "touchstart",
    "pointerdown",
    "keydown",
  ] as const;
  const cancel = () => {
    win.cancelAnimationFrame(frame);
    for (const event of interruptEvents)
      element.removeEventListener(event, cancel);
    active.delete(element);
    element.dispatchEvent(new Event(NAVIGATION_SCROLL_END));
  };
  active.set(element, cancel);
  for (const event of interruptEvents)
    element.addEventListener(event, cancel, { passive: true });
  const step = (now: number) => {
    if (!element.isConnected) {
      cancel();
      return;
    }
    // Editor virtualization may refine its height map as the target comes into view.
    const target = typeof destination === "function" ? readTarget() : initial;
    const progress = Math.max(
      0,
      Math.min(1, (now - began) / NAVIGATION_SCROLL_DURATION_MS),
    );
    const eased = 1 - (1 - progress) ** 3;
    element.scrollTop = startTop + (target.top - startTop) * eased;
    element.scrollLeft = startLeft + (target.left - startLeft) * eased;
    if (progress < 1) frame = win.requestAnimationFrame(step);
    else {
      cancel();
      onArrival?.();
    }
  };
  frame = win.requestAnimationFrame(step);
}
