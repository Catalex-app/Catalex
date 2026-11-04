import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { WORKSPACE_PANEL_EXPAND_ANIMATION_MS } from "./use-workspace-layout-animation";

interface PanelRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface PanelExpansionMotion {
  floating: boolean;
  animating: boolean;
  rect: PanelRect | null;
  shade: number;
}

const RESTING_MOTION: PanelExpansionMotion = {
  floating: false,
  animating: false,
  rect: null,
  shade: 0,
};

/** Animate live bounds, keeping the original split slot available on restore. */
export function usePanelExpansionMotion(
  panelRef: RefObject<HTMLDivElement | null>,
  expanded: boolean,
) {
  const [motion, setMotion] = useState(RESTING_MOTION);
  const motionRef = useRef(motion);
  motionRef.current = motion;

  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    let frame = 0;
    const animate = () => {
      cancelAnimationFrame(frame);
      if (!expanded && !motionRef.current.floating) return;
      const from = panel.getBoundingClientRect();
      let to: PanelRect;
      if (expanded) {
        to = {
          left: 12,
          // Leave a compact gap below the native traffic lights.
          top: 36,
          width: Math.max(1, window.innerWidth - 24),
          height: Math.max(1, window.innerHeight - 48),
        };
      } else {
        // Measure with the normal clipping rules: overflow-visible ancestors can
        // otherwise let the editor's minimum content width enlarge its split slot.
        // Restore everything synchronously, before the browser can paint.
        const label = panel.getAttribute("data-expanded-workspace-panel");
        const ancestors: HTMLElement[] = [];
        for (
          let ancestor = panel.parentElement;
          ancestor;
          ancestor = ancestor.parentElement
        ) {
          if (ancestor.hasAttribute("data-expanded-panel-ancestor")) {
            ancestors.push(ancestor);
            ancestor.removeAttribute("data-expanded-panel-ancestor");
          }
        }
        panel.removeAttribute("data-expanded-workspace-panel");
        to = panel.getBoundingClientRect();
        if (label !== null)
          panel.setAttribute("data-expanded-workspace-panel", label);
        for (const ancestor of ancestors)
          ancestor.setAttribute("data-expanded-panel-ancestor", "");
      }
      const fromShade = motionRef.current.shade;
      const toShade = expanded ? 1 : 0;
      const complete = () =>
        setMotion({
          floating: expanded,
          animating: false,
          rect: null,
          shade: toShade,
        });
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        complete();
        return;
      }
      setMotion({
        floating: true,
        animating: true,
        rect: from,
        shade: fromShade,
      });
      let previousFrame: number | null = null;
      let elapsed = 0;
      const tick = (now: number) => {
        if (previousFrame !== null)
          elapsed += Math.min(32, Math.max(0, now - previousFrame));
        previousFrame = now;
        const progress = Math.min(
          1,
          elapsed / WORKSPACE_PANEL_EXPAND_ANIMATION_MS,
        );
        const eased = 1 - (1 - progress) ** 3;
        if (progress === 1) {
          complete();
          return;
        }
        setMotion({
          floating: true,
          animating: true,
          rect: {
            left: from.left + (to.left - from.left) * eased,
            top: from.top + (to.top - from.top) * eased,
            width: from.width + (to.width - from.width) * eased,
            height: from.height + (to.height - from.height) * eased,
          },
          shade: fromShade + (toShade - fromShade) * eased,
        });
        frame = requestAnimationFrame(tick);
      };
      frame = requestAnimationFrame(tick);
    };
    animate();
    window.addEventListener("resize", animate);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", animate);
    };
  }, [expanded, panelRef]);

  return motion;
}
