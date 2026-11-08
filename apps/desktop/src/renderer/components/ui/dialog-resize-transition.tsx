import {
  useCallback,
  useEffect,
  useRef,
  type ReactNode,
  type RefCallback,
} from "react";

const resizeTiming = { duration: 180, easing: "ease-out" };
type Props = {
  children: (ref: RefCallback<HTMLDivElement>) => ReactNode;
  animateWidth?: boolean;
};
type Size = { width: number; height: number };

/** Animate natural height changes, optionally including content-sized width. */
export function DialogResizeTransition({
  children,
  animateWidth = false,
}: Props) {
  const previous = useRef<{ element: HTMLDivElement; size: Size } | null>(null);
  const cleanup = useRef<() => void>(() => {});
  const ref = useCallback(
    (element: HTMLDivElement | null) => {
      cleanup.current();
      cleanup.current = () => {};
      if (!element) return;
      let animation: Animation | null = null;
      // Radix may reattach the same node when its parent renders. Keep the
      // previous size so those updates animate just like nested updates.
      let targetSize =
        previous.current?.element === element
          ? previous.current.size
          : element.getBoundingClientRect();
      const motion = matchMedia("(prefers-reduced-motion: reduce)");
      const measure = () => {
        if (element.dataset.state !== "open") return;
        // Measure natural size without the previous animation's overrides.
        const current = animation
          ? element.getBoundingClientRect()
          : targetSize;
        animation?.cancel();
        animation = null;
        const next = element.getBoundingClientRect();
        targetSize = next;
        if (
          motion.matches ||
          (Math.abs(next.height - current.height) < 1 &&
            (!animateWidth || Math.abs(next.width - current.width) < 1))
        )
          return;
        const nextAnimation = element.animate(
          [
            {
              height: `${current.height}px`,
              ...(animateWidth ? { width: `${current.width}px` } : {}),
            },
            {
              height: `${next.height}px`,
              ...(animateWidth ? { width: `${next.width}px` } : {}),
            },
          ],
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
          targetSize = element.getBoundingClientRect();
        }
      };
      motion.addEventListener("change", reduceMotion);
      cleanup.current = () => {
        previous.current = {
          element,
          size: animation ? element.getBoundingClientRect() : targetSize,
        };
        resize.disconnect();
        mutations.disconnect();
        motion.removeEventListener("change", reduceMotion);
        animation?.cancel();
      };
      measure();
    },
    [animateWidth],
  );
  useEffect(() => () => cleanup.current(), []);
  return children(ref);
}
