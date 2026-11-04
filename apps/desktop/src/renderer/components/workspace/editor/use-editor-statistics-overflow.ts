import { useLayoutEffect, useRef, useState } from "react";
import { useWorkspacePanelMotion } from "../workspace-panel";

/** Keep counts inline until even the compact formatting menu needs their space. */
export function useEditorStatisticsOverflow() {
  const headerRef = useRef<HTMLDivElement>(null);
  const statisticsRef = useRef<HTMLDivElement>(null);
  const otherControlsRef = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState(false);
  const [otherControlsVisible, setOtherControlsVisible] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const animating = useWorkspacePanelMotion()?.animating ?? false;

  useLayoutEffect(() => {
    const header = headerRef.current;
    const statistics = statisticsRef.current;
    const other = otherControlsRef.current;
    if (!header || !statistics || !other) return;
    const typeLabel = header.querySelector<HTMLElement>(
      "[data-editor-type-label] > span",
    );
    const measure = () => {
      const style = getComputedStyle(header);
      const formatting = header.querySelector<HTMLElement>(
        "[data-formatting-collapsed]",
      );
      const minimumFormattingWidth = formatting
        ? Number.parseFloat(getComputedStyle(formatting).minWidth)
        : Math.min(120, typeLabel?.offsetWidth ?? 44);
      const gestureWidth =
        header.querySelector<HTMLElement>("[data-panel-header-space]")
          ?.offsetWidth ?? 56;
      // Measure the counts even when hidden. Reserve the menu and separator so
      // removing the counts never immediately makes them fit again.
      const required =
        minimumFormattingWidth +
        gestureWidth +
        statistics.offsetWidth +
        other.offsetWidth +
        41 +
        Number.parseFloat(style.paddingLeft) +
        Number.parseFloat(style.paddingRight) +
        2 * (Number.parseFloat(style.columnGap) || 0);
      setOtherControlsVisible(other.offsetWidth > 0);
      setOverflow((previous) => {
        if (previous && (actionsOpen || animating)) return true;
        return header.clientWidth < required + (previous ? 16 : 0);
      });
    };
    measure();
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    });
    for (const element of [header, statistics, other, typeLabel])
      if (element) observer.observe(element);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [actionsOpen, animating]);

  return {
    headerRef,
    statisticsRef,
    otherControlsRef,
    overflow,
    otherControlsVisible,
    setActionsOpen,
  };
}
