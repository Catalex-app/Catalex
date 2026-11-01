import { useEffect } from "react";
import { useSettingsStore } from "@/stores/settings-store";
import { useUpdaterStore, type UpdateStatus } from "@/stores/updater-store";
export type { UpdateStatus } from "@/stores/updater-store";

export function useUpdater() {
  const {
    status,
    update,
    checking,
    checkForUpdate,
    skipUpdate,
    openRelease,
    installUpdate,
  } = useUpdaterStore();
  const skippedVersions = useSettingsStore((s) => s.skippedUpdateVersions);

  // Browser demos replay detection without remounting the writing workspace.
  useEffect(() => {
    if (!import.meta.env.DEV || window.catalex) return;
    const recheck = () => {
      void checkForUpdate(true);
    };
    window.addEventListener("catalex:demo-updates-changed", recheck);
    return () =>
      window.removeEventListener("catalex:demo-updates-changed", recheck);
  }, [checkForUpdate]);

  const visibleStatus: UpdateStatus =
    status.state === "available" && skippedVersions.includes(status.version)
      ? { state: "skipped", version: status.version }
      : status;
  // A recheck or network error must not retract an already-known update notice.
  const notice: UpdateStatus =
    update && !["downloading", "installing", "ready"].includes(status.state)
      ? skippedVersions.includes(update.version)
        ? { state: "skipped", version: update.version }
        : {
            state: "available",
            mode: update.mode,
            version: update.version,
            notes: update.body,
          }
      : visibleStatus;
  return {
    status: visibleStatus,
    notice,
    checking,
    checkForUpdate,
    installUpdate,
    skipUpdate,
    openRelease,
  };
}
