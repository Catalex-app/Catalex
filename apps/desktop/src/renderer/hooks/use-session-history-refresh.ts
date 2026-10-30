import { useEffect, useState } from "react";
import { SHARED_SESSION_SAVED_EVENT } from "@/lib/workspace-events";

/** Refresh persisted activity after saves; age labels locally without polling IPC. */
export function useSessionHistoryRefresh(
  projectRoot: string | null,
  refresh: () => Promise<void>,
  active = true,
) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!active || !projectRoot) return;
    const saved = (event: Event) => {
      if (
        (event as CustomEvent<{ projectRoot: string }>).detail.projectRoot ===
        projectRoot
      )
        void refresh();
    };
    window.addEventListener(SHARED_SESSION_SAVED_EVENT, saved);
    const timer = setInterval(() => tick((value) => value + 1), 60_000);
    return () => {
      window.removeEventListener(SHARED_SESSION_SAVED_EVENT, saved);
      clearInterval(timer);
    };
  }, [active, projectRoot, refresh]);
}
