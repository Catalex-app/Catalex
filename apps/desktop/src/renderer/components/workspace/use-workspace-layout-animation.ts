import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import type { ImperativePanelGroupHandle } from "react-resizable-panels";

// Shared with composer handoff, which waits for panel expansion to finish.
export const WORKSPACE_PANEL_EXPAND_ANIMATION_MS = 220;

export function areWorkspaceLayoutsClose(left: number[], right: number[]) {
  return (
    left.length === right.length &&
    left.every((value, index) => Math.abs(value - right[index]) < 0.25)
  );
}

type AnimatedPanel = {
  index: number;
  ref: RefObject<HTMLElement | null>;
};

/** Shared panel motion; layout selection and pane-specific effects stay with the caller. */
export function useWorkspaceLayoutAnimation({
  groupRef,
  panels,
  onStart,
  onFrame,
  onStop,
  onComplete,
}: {
  groupRef: RefObject<ImperativePanelGroupHandle | null>;
  panels: readonly AnimatedPanel[];
  onStart: (from: number[], to: number[]) => void;
  onFrame?: (layout: number[], progress: number) => void;
  onStop?: () => void;
  onComplete: (layout: number[]) => void;
}) {
  const targetRef = useRef<number[] | null>(null);
  const frameRef = useRef<number | null>(null);
  const isAnimatingRef = useRef(false);
  const [isAnimating, setIsAnimating] = useState(false);

  const stop = useCallback(() => {
    if (frameRef.current != null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    targetRef.current = null;
    isAnimatingRef.current = false;
    setIsAnimating(false);
    onStop?.();
  }, [onStop]);

  const applyOpacity = useCallback(
    (layout: number[]) => {
      for (const { index, ref } of panels) {
        if (ref.current)
          ref.current.style.opacity = layout[index] <= 0.5 ? "0" : "1";
      }
    },
    [panels],
  );

  const animate = useCallback(
    (
      from: number[],
      to: number[],
      duration = WORKSPACE_PANEL_EXPAND_ANIMATION_MS,
    ) => {
      // Layout effects can request the same destination after a mode commit.
      // Preserve the running transition instead of restarting its timing.
      if (
        isAnimatingRef.current &&
        targetRef.current &&
        areWorkspaceLayoutsClose(targetRef.current, to)
      )
        return;
      stop();
      const group = groupRef.current;
      if (!group) return;
      if (areWorkspaceLayoutsClose(from, to)) {
        group.setLayout(to);
        applyOpacity(to);
        onComplete(to);
        return;
      }

      targetRef.current = [...to];
      onStart(from, to);
      isAnimatingRef.current = true;
      setIsAnimating(true);
      // Reveal opening content immediately; closing content remains until completion.
      for (const { index, ref } of panels) {
        if (from[index] <= 0.5 && to[index] > 0.5 && ref.current) {
          ref.current.style.opacity = "1";
        }
      }

      // Preserve rendered-frame timing: editor setup must not skip visible motion.
      let previousFrame: number | null = null;
      let elapsed = 0;
      const tick = (now: number) => {
        if (previousFrame !== null)
          elapsed += Math.min(32, Math.max(0, now - previousFrame));
        previousFrame = now;
        const progress = Math.min(1, elapsed / duration);
        const eased = 1 - (1 - progress) ** 3;
        const layout = from.map(
          (value, index) => value + (to[index] - value) * eased,
        );
        group.setLayout(layout);
        onFrame?.(layout, progress);
        if (progress < 1) {
          frameRef.current = requestAnimationFrame(tick);
          return;
        }
        group.setLayout(to);
        applyOpacity(to);
        targetRef.current = null;
        onStop?.();
        isAnimatingRef.current = false;
        setIsAnimating(false);
        onComplete(to);
        frameRef.current = null;
      };
      frameRef.current = requestAnimationFrame(tick);
    },
    [
      stop,
      groupRef,
      applyOpacity,
      onComplete,
      onStart,
      onFrame,
      onStop,
      panels,
    ],
  );

  useEffect(() => stop, [stop]);
  return { animate, stop, applyOpacity, isAnimating, isAnimatingRef };
}
