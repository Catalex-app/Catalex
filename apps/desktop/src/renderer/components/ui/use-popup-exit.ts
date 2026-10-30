import { useCallback, useRef, type Ref } from "react";

/** Let custom popups unmount immediately; only an inert visual fades out. */
export function usePopupExit(forwardedRef?: Ref<HTMLDivElement>) {
  const current = useRef<HTMLDivElement | null>(null);
  const revision = useRef(0);
  const cleanup = useRef<(() => void) | null>(null);
  return useCallback(
    (node: HTMLDivElement | null) => {
      const nextRevision = ++revision.current;
      const previous = current.current;
      if (node) {
        cleanup.current?.();
        cleanup.current = null;
      } else if (
        previous?.isConnected &&
        !matchMedia("(prefers-reduced-motion: reduce)").matches
      ) {
        const rect = previous.getBoundingClientRect();
        const style = getComputedStyle(previous);
        const visual = previous.cloneNode(true) as HTMLElement;
        visual.inert = true;
        visual.setAttribute("aria-hidden", "true");
        visual.setAttribute("data-popup-exit", "");
        for (const element of [visual, ...visual.querySelectorAll("*")]) {
          element.removeAttribute("id");
          element.removeAttribute("role");
          element.removeAttribute("aria-describedby");
          element.removeAttribute("data-slot");
        }
        Object.assign(visual.style, {
          position: "fixed",
          left: `${rect.left}px`,
          top: `${rect.top}px`,
          right: "auto",
          bottom: "auto",
          width: `${rect.width}px`,
          height: `${rect.height}px`,
          margin: "0",
          transform: "none",
          pointerEvents: "none",
          animation: "none",
          zIndex: style.zIndex,
        });
        const opacity = style.opacity;
        const duration =
          Number.parseFloat(style.getPropertyValue("--popup-fade-duration")) ||
          200;
        const easing =
          style.getPropertyValue("--popup-fade-easing").trim() ||
          "cubic-bezier(0.2, 0, 0.2, 1)";
        queueMicrotask(() => {
          if (revision.current !== nextRevision || previous.isConnected) return;
          document.body.appendChild(visual);
          const animation = visual.animate([{ opacity }, { opacity: 0 }], {
            duration,
            easing,
            fill: "forwards",
          });
          const remove = () => {
            animation.cancel();
            visual.remove();
          };
          cleanup.current = remove;
          void animation.finished.then(remove, () => visual.remove());
        });
      }
      current.current = node;
      if (typeof forwardedRef === "function") return forwardedRef(node);
      if (forwardedRef) forwardedRef.current = node;
    },
    [forwardedRef],
  );
}
