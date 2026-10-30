export const NAVIGATION_SCROLL_DURATION_MS = 180;
export const NAVIGATION_SCROLL_END = "catalex:navigation-scroll-end";

type Position = { top: number; left?: number };
const active = new WeakMap<HTMLElement, () => void>();

export function isNavigationScrolling(element: HTMLElement) {
  return active.has(element);
}

export function cancelNavigationScroll(element: HTMLElement) {
  active.get(element)?.();
}

/** Short, interruptible motion for explicit navigation, never live scroll sync. */
export function scrollForNavigation(
  element: HTMLElement,
  destination: Position | (() => Position),
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
    else cancel();
  };
  frame = win.requestAnimationFrame(step);
}
