import { useLayoutEffect } from "react";
import type { WorkspaceMode } from "@/lib/ui-theme";
import { useSettingsStore } from "@/stores/settings-store";

/** Apply appearance at the window root so body portals share the workspace theme. */
export function useWorkspaceTheme(mode: WorkspaceMode) {
  const theme = useSettingsStore((state) => state.modeThemes[mode]);
  useLayoutEffect(() => {
    document.documentElement.dataset.uiTheme = theme;
    document.documentElement.dataset.workspaceMode = mode;
    return () => {
      // The welcome screen uses Modern after leaving a workspace.
      document.documentElement.dataset.uiTheme = "modern";
      delete document.documentElement.dataset.workspaceMode;
    };
  }, [theme, mode]);
}
