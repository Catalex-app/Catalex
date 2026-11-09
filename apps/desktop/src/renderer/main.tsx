import { useApplicationMenu } from "./hooks/use-application-menu";
import { installImeKeyBoundary } from "./lib/keyboard-events";
import { installMouseBoundary } from "./lib/mouse-events";
import { AppContextMenu } from "./components/ui/app-context-menu";
import { installSelectionBoundaries } from "./lib/selection-boundaries";
import { installFocusModality } from "./lib/focus-modality";
import React from "react";
import ReactDOM from "react-dom/client";
import { invoke } from "@/lib/desktop/core";
import { isDesktop } from "@/lib/desktop/bridge";
import { getCurrentWindow } from "@/lib/desktop/window";
import { listen } from "@/lib/desktop/event";
import { ThemeProvider } from "next-themes";
import { initializeAppZoom } from "./lib/app-zoom";
import { createLogger } from "./lib/debug/logger";
import { APP_VISIBILITY_RESTORED } from "./lib/debug/log-store";
import {
  collectFrontendHealthSnapshot,
  FRONTEND_HEALTH_INTERVAL_MS,
} from "./lib/debug/frontend-health";
import "./styles/globals.css";

const removeImeKeyBoundary = installImeKeyBoundary();
if (import.meta.hot) import.meta.hot.dispose(removeImeKeyBoundary);

const removeMouseBoundary = installMouseBoundary();
if (import.meta.hot) import.meta.hot.dispose(removeMouseBoundary);

const removeSelectionBoundaries = installSelectionBoundaries();
if (import.meta.hot) import.meta.hot.dispose(removeSelectionBoundaries);
const removeFocusModality = installFocusModality();
if (import.meta.hot) import.meta.hot.dispose(removeFocusModality);

const urlParams = new URLSearchParams(window.location.search);
const isDebugWindow = urlParams.has("debug");
const isSettingsWindow = urlParams.has("settings");
const debugMode = urlParams.get("debug");

const log = createLogger("app");
const isDesktopRuntime = isDesktop();

function reportFrontendHealth(source: string) {
  if (!isDesktopRuntime) return;
  try {
    const snapshot = collectFrontendHealthSnapshot();
    invoke("js_log", {
      msg: `[health][frontend][${source}] ${JSON.stringify(snapshot)}`,
    }).catch(() => {
      // Health reporting must not affect the app itself.
    });
  } catch (error) {
    invoke("js_log", {
      msg: `[health][frontend][${source}] failed to collect snapshot: ${String(error)}`,
    }).catch(() => {
      // Health reporting must not affect the app itself.
    });
  }
}

function startFrontendHealthLogger() {
  reportFrontendHealth("startup");
  window.setInterval(
    () => reportFrontendHealth("interval"),
    FRONTEND_HEALTH_INTERVAL_MS,
  );
}

// Coalesce native focus and visibility events for the same app switch.
let _visibilityTimer: ReturnType<typeof setTimeout> | null = null;
function dispatchVisibilityRestored(source: string) {
  if (_visibilityTimer) return; // already scheduled
  log.info(`Visibility restored (${source})`);
  reportFrontendHealth(source);
  _visibilityTimer = setTimeout(() => {
    _visibilityTimer = null;
    window.dispatchEvent(new CustomEvent(APP_VISIBILITY_RESTORED));
  }, 200);
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    dispatchVisibilityRestored("visibilitychange");
  }
});

window.addEventListener("pageshow", () => {
  dispatchVisibilityRestored("pageshow");
});

// Native focus catches app switches that leave document visibility unchanged.
if (isDesktopRuntime) {
  listen("window-focus-restored", () => {
    reportFrontendHealth("window-focus-restored-event");
    dispatchVisibilityRestored("window-focus-restored");
  }).catch(() => {
    // The window may have closed before the event was delivered.
  });
}

// Platform-specific titlebar height adjustments
if (navigator.userAgent.includes("Windows")) {
  // Windows overlay titlebar is ~12px (title + window controls)
  document.documentElement.style.setProperty("--titlebar-height", "12px");
  document.documentElement.style.setProperty("--traffic-light-width", "0px");
} else if (navigator.userAgent.includes("Macintosh")) {
  // macOS overlay titlebar is integrated into the first visible toolbar row.
  document.documentElement.style.setProperty("--titlebar-height", "0px");
  document.documentElement.style.setProperty("--traffic-light-width", "72px");
} else if (!navigator.userAgent.includes("Macintosh")) {
  // Linux and others: no overlay titlebar
  document.documentElement.style.setProperty("--titlebar-height", "0px");
  document.documentElement.style.setProperty("--traffic-light-width", "0px");
}

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("Root element #root not found");
const rootContainer: HTMLElement = rootEl;
const reactRoot = ReactDOM.createRoot(rootContainer);
function ApplicationMenuBridge() {
  useApplicationMenu();
  return null;
}

const root = {
  render: (children: React.ReactNode) =>
    reactRoot.render(
      <>
        <ApplicationMenuBridge />
        <AppContextMenu />
        {children}
      </>,
    ),
};
startFrontendHealthLogger();
let loadingScreenHidden = false;
let startupReady = false;
let fatalScreenRendered = false;

function renderStartupError(error: unknown) {
  if (fatalScreenRendered) return;
  fatalScreenRendered = true;
  hideLoadingScreen();
  root.render(
    <div className="flex h-screen w-screen items-center justify-center bg-background p-8 text-foreground">
      <div className="w-full max-w-2xl space-y-3">
        <h1 className="font-semibold text-destructive text-lg">
          App failed to start
        </h1>
        <p className="text-muted-foreground text-sm">
          A startup error prevented the app from rendering.
        </p>
        <pre className="max-h-72 overflow-auto rounded-md border bg-muted/30 p-3 text-xs">
          {error instanceof Error
            ? `${error.message}${error.stack ? `\n\n${error.stack}` : ""}`
            : String(error)}
        </pre>
      </div>
    </div>,
  );
}

// Catch unhandled failures during startup to avoid silent blank-screen hangs.
window.addEventListener("unhandledrejection", (event) => {
  log.error("Unhandled promise rejection", { reason: String(event.reason) });
  reportFrontendHealth("unhandledrejection");
  if (!startupReady) {
    renderStartupError(event.reason);
  }
});

window.addEventListener("error", (event) => {
  log.error("Unhandled error", {
    message: event.message,
    error: String(event.error ?? event.message),
  });
  reportFrontendHealth("error");
  if (!startupReady) {
    renderStartupError(event.error ?? event.message);
  }
});

function hideLoadingScreen() {
  if (loadingScreenHidden) return;
  loadingScreenHidden = true;
  startupReady = true;
  const loading = document.getElementById("loading-screen");
  if (loading) {
    loading.style.opacity = "0";
    setTimeout(() => loading.remove(), 300);
  }
  if (isDesktopRuntime) {
    getCurrentWindow()
      .show()
      .catch(() => {
        // The window may have closed before the event was delivered.
      });
  }
}

async function bootstrap() {
  let announceRecovery = () => {};
  if (window.catalex && !urlParams.has("panel-window")) {
    const { migrateBrowserWorkspaceState, showWorkspaceMigrationNotice } =
      await import("./lib/workspace-state-storage");
    const backups = await migrateBrowserWorkspaceState();
    announceRecovery = () => showWorkspaceMigrationNotice(backups.splice(0));
    const [
      { useAgentReviewQueueStore },
      { useProposedChangesStore },
      { usePausedReviewStore },
    ] = await Promise.all([
      import("./stores/agent-review-queue-store"),
      import("./stores/proposed-changes-store"),
      import("./stores/paused-review-store"),
    ]);
    for (const store of [
      useAgentReviewQueueStore,
      useProposedChangesStore,
      usePausedReviewStore,
    ]) {
      await store.persist.rehydrate();
      if (!store.persist.hasHydrated())
        throw new Error(
          "Could not restore saved draft review data. No source files were changed.",
        );
    }
  }
  if (window.catalex && !urlParams.has("panel-window")) {
    const { initializeUpdater } = await import("./stores/updater-store");
    await initializeUpdater();
  }
  try {
    await initializeAppZoom();
  } catch (error) {
    log.error("Failed to initialize app zoom", { error: String(error) });
  }

  if (isDebugWindow) {
    if (import.meta.env.DEV) {
      const { renderDebugWindow } = await import("./dev/render-debug-window");
      await renderDebugWindow(root, debugMode);
    } else {
      // Release builds retain diagnostics, but never load development harnesses.
      const { DebugPage } = await import("./components/debug/debug-page");
      root.render(
        <React.StrictMode>
          <DebugPage />
        </React.StrictMode>,
      );
    }
    hideLoadingScreen();
    return;
  }

  if (urlParams.has("panel-window")) {
    const { PanelWindow } = await import("./components/workspace/panel-window");
    root.render(<PanelWindow />);
    hideLoadingScreen();
    return;
  }

  if (isSettingsWindow) {
    if (
      import.meta.env.DEV &&
      urlParams.has("onboarding-demo") &&
      !window.catalex
    ) {
      const { initializeOnboardingDemo } = await import(
        "./dev/onboarding-demo"
      );
      initializeOnboardingDemo();
    }
    const { SettingsWindow } = await import(
      "./components/settings/settings-window"
    );
    const { SolarModeEffect } = await import(
      "./components/settings/solar-mode-effect"
    );
    root.render(
      <React.StrictMode>
        <ThemeProvider attribute="class" defaultTheme="light" enableSystem>
          <SolarModeEffect />
          <SettingsWindow />
        </ThemeProvider>
      </React.StrictMode>,
    );
    hideLoadingScreen();
    return;
  }

  if (
    import.meta.env.DEV &&
    urlParams.has("onboarding-demo") &&
    !window.catalex
  ) {
    const { initializeOnboardingDemo, OnboardingDemo } = await import(
      "./dev/onboarding-demo"
    );
    initializeOnboardingDemo();
    root.render(<OnboardingDemo onReady={hideLoadingScreen} />);
    return;
  }

  // Main app window
  const { App } = await import("./App");
  root.render(
    <React.StrictMode>
      <App
        onReady={() => {
          hideLoadingScreen();
          announceRecovery();
        }}
      />
    </React.StrictMode>,
  );
}

void bootstrap().catch((error) => {
  log.error("Bootstrap failed", { error: String(error) });
  renderStartupError(error);
});
