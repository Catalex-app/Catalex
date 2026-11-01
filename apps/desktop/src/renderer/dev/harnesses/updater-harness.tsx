import { useUpdaterStore } from "@/stores/updater-store";
import { ThemeProvider } from "next-themes";
import { ProjectPicker } from "@/components/project-picker";
import { SettingsWindow } from "@/components/settings/settings-window";
import { useSettingsStore } from "@/stores/settings-store";
import { browserHarness } from "@/lib/desktop/bridge";
import { ensureDesktopBrowserMocks } from "../desktop-browser-mocks";

declare global {
  interface Window {
    __updaterHarness?: {
      openedUrls: string[];
      calls: string[];
      scenario: string;
    };
  }
}
function prepare() {
  if (window.__updaterHarness) return;
  ensureDesktopBrowserMocks();
  useSettingsStore.setState({
    enabledProviders: { claude: false, codex: false, pi: false },
  });
  const params = new URLSearchParams(location.search);
  const state = {
    openedUrls: [] as string[],
    calls: [] as string[],
    scenario: params.get("scenario") || "available",
  };
  window.__updaterHarness = state;
  const harness = browserHarness()!;
  const fallback = harness.invoke.bind(harness);
  harness.invoke = async (command, args, options) => {
    state.calls.push(command);
    if (command === "desktop:updater:check") {
      await new Promise((resolve) =>
        setTimeout(
          resolve,
          Math.min(
            10_000,
            Math.max(0, Number(params.get("update-delay")) || 150),
          ),
        ),
      );
      if (state.scenario === "error")
        throw new Error(
          "Could not reach GitHub. Check your connection and try again.",
        );
      if (state.scenario === "unavailable")
        return {
          unavailable: true,
          message: "Update checks are unavailable until releases are public.",
        };
      if (state.scenario === "current") return null;
      return {
        mode: "manual",
        version: "0.1.1-beta",
        body: "A beta update",
        releaseUrl:
          "https://github.com/Catalex-app/Catalex/releases/tag/v0.1.1-beta",
      };
    }
    if (command === "open_settings_window") {
      const url = new URL(location.href);
      url.searchParams.set("view", "settings");
      url.searchParams.set("scenario", state.scenario);
      url.searchParams.set(
        "section",
        (args as { section?: string })?.section ?? "appearance",
      );
      window.open(url.href, "catalex-updater-settings");
      return;
    }
    if (command === "plugin:app|version") return "0.1.0-beta";
    if (command === "plugin:shell|open") {
      state.openedUrls.push((args as { path: string }).path);
      return;
    }
    return fallback(command, args, options);
  };
  void useUpdaterStore.getState().checkForUpdate(false);
}
export function UpdaterHarness() {
  prepare();
  const settings =
    new URLSearchParams(location.search).get("view") === "settings";
  return (
    <ThemeProvider attribute="class" defaultTheme="light">
      <div className="h-screen">
        {settings ? <SettingsWindow /> : <ProjectPicker />}
      </div>
    </ThemeProvider>
  );
}
