import {
  type ComponentPropsWithoutRef,
  type ReactNode,
  useLayoutEffect,
  useRef,
} from "react";
import { cn } from "@/lib/utils";
import {
  documentBarClassName,
  documentBarGapClassName,
} from "./document-navigation-styles";
import "./review-bar-layout.css";

interface ReviewBarLayoutProps extends ComponentPropsWithoutRef<"div"> {
  heading: ReactNode;
  navigation?: ReactNode;
  actions: ReactNode;
}

export function ReviewBarLayout({
  heading,
  navigation,
  actions,
  className,
  ...props
}: ReviewBarLayoutProps) {
  const barRef = useRef<HTMLDivElement>(null);
  const actionsRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const bar = barRef.current;
    const actionRow = actionsRef.current;
    if (!bar || !actionRow || typeof ResizeObserver === "undefined") return;
    if (!actionRow.querySelector("kbd")) {
      actionRow.removeAttribute("data-hide-shortcuts");
      return;
    }

    let observedWidth: number | undefined;
    const measureShortcuts = () => {
      const styles = getComputedStyle(bar);
      const available =
        bar.getBoundingClientRect().width -
        parseFloat(styles.paddingLeft) -
        parseFloat(styles.paddingRight);
      // Read the unwrapped width with badges in place before the browser paints.
      actionRow.setAttribute("data-measuring", "");
      const naturalWidth = actionRow.getBoundingClientRect().width;
      actionRow.removeAttribute("data-measuring");
      actionRow.toggleAttribute(
        "data-hide-shortcuts",
        naturalWidth > available,
      );
    };
    measureShortcuts();
    const observer = new ResizeObserver(([entry]) => {
      const width = entry.contentRect.width;
      if (width === observedWidth) return;
      observedWidth = width;
      measureShortcuts();
    });
    observer.observe(bar);
    document.fonts?.addEventListener("loadingdone", measureShortcuts);
    return () => {
      observer.disconnect();
      document.fonts?.removeEventListener("loadingdone", measureShortcuts);
    };
  }, [actions]);

  return (
    <div
      {...props}
      ref={barRef}
      className={cn(
        documentBarClassName,
        "review-bar flex-wrap bg-muted/50",
        navigation && "review-bar-with-navigation",
        className,
      )}
    >
      <div
        className={cn(
          "review-bar-heading relative flex min-w-0 items-center justify-between",
          documentBarGapClassName,
        )}
      >
        {heading}
        {navigation && <div className="shrink-0">{navigation}</div>}
      </div>
      <div
        ref={actionsRef}
        className={cn(
          "review-bar-actions ml-auto flex max-w-full flex-wrap items-center justify-end",
          documentBarGapClassName,
        )}
      >
        {actions}
      </div>
    </div>
  );
}
