import { useLayoutEffect, useRef } from "react";

/** Keep animated content mounted, but return focus before making it inert. */
export function useCollapsedSidebarBody(collapsed: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const body = ref.current;
    if (!body) return;
    if (collapsed && body.contains(document.activeElement)) {
      body.parentElement
        ?.querySelector<HTMLButtonElement>("[data-sidebar-toggle]")
        ?.focus({ preventScroll: true });
    }
    body.inert = collapsed;
  }, [collapsed]);
  return ref;
}
