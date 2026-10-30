import {
  useCallback,
  useEffect,
  useRef,
  type ReactNode,
  type RefCallback,
} from "react";

const resizeTiming = { duration: 180, easing: "ease-out" };
type Props = { children: (ref: RefCallback<HTMLDivElement>) => ReactNode };

/** Observe the rendered dialog so nested state changes also animate its height. */
export function DialogResizeTransition({ children }: Props) {
  const previous = useRef<{ element: HTMLDivElement; height: number } | null>(
    null,
  );
  const cleanup = useRef<() => void>(() => {});
  const ref = useCallback((element: HTMLDivElement | null) => {
    cleanup.current();
    cleanup.current = () => {};
    if (!element) return;
    let animation: Animation | null = null;
    // Radix may reattach the same node when its parent renders. Keep the
    // previous height so those updates animate just like nested updates.
    let targetHeight =
      previous.current?.element === element
        ? previous.current.height
        : element.getBoundingClientRect().height;
    const motion = matchMedia("(prefers-reduced-motion: reduce)");
    const measure = () => {
      if (element.dataset.state !== "open") return;
      // Measure natural height without the previous animation's height override.
      const current = animation
        ? element.getBoundingClientRect().height
        : targetHeight;
      animation?.cancel();
      animation = null;
      const next = element.getBoundingClientRect().height;
      targetHeight = next;
      if (motion.matches || Math.abs(next - current) < 1) return;
      const nextAnimation = element.animate(
        [{ height: `${current}px` }, { height: `${next}px` }],
        resizeTiming,
      );
      animation = nextAnimation;
      nextAnimation.onfinish = () => {
        if (animation === nextAnimation) animation = null;
      };
    };
    // The dialog itself reports natural size changes (including fonts/images).
    // Ignore frames produced by our own animation; DOM mutations still retarget it.
    const resize = new ResizeObserver(() => {
      if (!animation) measure();
    });
    resize.observe(element);
    const mutations = new MutationObserver(measure);
    mutations.observe(element, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["class", "style", "hidden", "data-state"],
    });
    const reduceMotion = () => {
      if (motion.matches) {
        animation?.cancel();
        animation = null;
        targetHeight = element.getBoundingClientRect().height;
      }
    };
    motion.addEventListener("change", reduceMotion);
    cleanup.current = () => {
      previous.current = {
        element,
        height: animation
          ? element.getBoundingClientRect().height
          : targetHeight,
      };
      resize.disconnect();
      mutations.disconnect();
      motion.removeEventListener("change", reduceMotion);
      animation?.cancel();
    };
    measure();
  }, []);
  useEffect(() => () => cleanup.current(), []);
  return children(ref);
}
