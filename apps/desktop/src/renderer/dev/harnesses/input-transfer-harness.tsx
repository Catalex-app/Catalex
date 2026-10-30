import { SolarModeEffect } from "@/components/settings/solar-mode-effect";
import { useAgentEvents } from "@/hooks/use-agent-events";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAgentChatStore } from "@/stores/agent-chat-store";
import { WorkspaceLayout } from "@/components/workspace/workspace-layout";
import { useDocumentStore, type ProjectFile } from "@/stores/document-store";

interface TransferSample {
  elapsedMs: number;
  drawerComposerOpacity: number | null;
  drawerComposerTranslateY: number | null;
  drawerComposerPhase: string | null;
  panelComposerOpacity: number | null;
  panelComposerTranslateY: number | null;
  panelComposerPhase: string | null;
}

interface TransferCheck {
  name: "drawer_to_workspace" | "workspace_to_drawer";
  pass: boolean;
  sourceExitStartFrame: number;
  targetEnterPrepStartFrame: number;
  targetEnterStartFrame: number;
  maxSourceTranslateY: number;
  minSourceOpacity: number;
  maxTargetTranslateY: number;
  finalTargetTranslateY: number;
  finalTargetOpacity: number;
  totalFrames: number;
  targetModeReached: boolean;
}

interface InputTransferHarnessReport {
  pass: boolean;
  checks: TransferCheck[];
  finishedAtIso: string;
}

interface SelectionChipHarnessState {
  selectionRange: { start: number; end: number } | null;
  selectionPreviewRange: {
    fileId: string;
    start: number;
    end: number;
  } | null;
}

declare global {
  interface Window {
    __newInputTransferChat?: () => string;
    __runInputTransferHarness?: () => Promise<InputTransferHarnessReport>;
    __inputTransferHarnessReport?: InputTransferHarnessReport;
    __selectInputTransferHarnessText?: (text: string) => boolean;
    __getInputTransferHarnessSelectionState?: () => SelectionChipHarnessState;
  }
}

const SAMPLE_MAIN_TEX = `% Harness sample
\\documentclass{article}
\\begin{document}
\\section{Introduction}
Hello harness
\\end{document}
`;

const CAPTURE_DURATION_MS = 760;
const FRAME_SETTLE_DELAY_MS = 80;

function ensureDesktopBrowserMocks() {
  if (typeof window === "undefined") return;
  const win = window as Window & {
    __TAURI_INTERNALS__?: {
      invoke?: (
        cmd: string,
        args?: Record<string, unknown>,
        options?: Record<string, unknown>,
      ) => Promise<unknown>;
      transformCallback?: (
        callback: (...args: unknown[]) => void,
        once?: boolean,
      ) => number;
      unregisterCallback?: (id: number) => void;
      convertFileSrc?: (filePath: string, protocol?: string) => string;
      metadata?: {
        currentWindow?: { label: string };
        currentWebview?: { label: string };
      };
      plugins?: {
        path?: {
          sep?: string;
          delimiter?: string;
        };
      };
    };
    __TAURI_EVENT_PLUGIN_INTERNALS__?: {
      unregisterListener: (event: string, eventId: number) => void;
    };
  };
  if (!win.__TAURI_EVENT_PLUGIN_INTERNALS__) {
    win.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
      unregisterListener: () => {},
    };
  }
  const existing = win.__TAURI_INTERNALS__ ?? {};
  let callbackId = 1;
  const callbacks = new Map<number, (...args: unknown[]) => void>();
  let listenerId = 1;
  const invokeFallback = async (
    cmd: string,
    _args?: Record<string, unknown>,
    _options?: Record<string, unknown>,
  ): Promise<unknown> => {
    if (cmd === "history_list") return [];
    if (cmd === "slash_commands_list") return [];
    if (cmd === "history_storage_info") {
      return {
        usageBytes: 0,
        limitBytes: 0,
        snapshotCount: 0,
        protectedSnapshotCount: 0,
      };
    }
    if (cmd === "detect_editors") {
      return [];
    }
    if (cmd === "list_shared_sessions") {
      return [];
    }
    if (cmd === "check_claude_status" || cmd === "check_codex_status") {
      return {
        installed: true,
        authenticated: true,
        missing_git: false,
        version: "demo",
      };
    }
    if (
      cmd === "plugin:event|listen" ||
      cmd === "plugin:webview|listen" ||
      cmd === "plugin:window|listen"
    ) {
      listenerId += 1;
      return listenerId;
    }
    if (
      cmd === "plugin:event|unlisten" ||
      cmd === "plugin:webview|unlisten" ||
      cmd === "plugin:window|unlisten"
    ) {
      return null;
    }
    if (cmd === "list_codex_models")
      return [
        {
          model: "demo",
          display_name: "Demo",
          description: "Browser harness",
          supported_reasoning_efforts: [
            { value: "medium", description: "Medium" },
          ],
          default_reasoning_effort: "medium",
          is_default: true,
        },
      ];
    if (cmd === "list_claude_models")
      return [
        {
          value: "default",
          displayName: "Demo",
          description: "Browser harness",
          supportsEffort: false,
        },
      ];
    if (cmd.startsWith("list_")) {
      return [];
    }
    if (cmd.startsWith("get_")) {
      return {};
    }
    return null;
  };

  win.__TAURI_INTERNALS__ = {
    ...existing,
    metadata: existing.metadata ?? {
      currentWindow: { label: "main" },
      currentWebview: { label: "main" },
    },
    transformCallback:
      existing.transformCallback ??
      ((callback, once = false) => {
        const id = callbackId++;
        callbacks.set(id, (...args: unknown[]) => {
          callback(...args);
          if (once) callbacks.delete(id);
        });
        return id;
      }),
    unregisterCallback:
      existing.unregisterCallback ??
      ((id) => {
        callbacks.delete(id);
      }),
    invoke: existing.invoke ?? invokeFallback,
    convertFileSrc: existing.convertFileSrc ?? ((filePath) => filePath),
    plugins: {
      path: {
        sep: existing.plugins?.path?.sep ?? "/",
        delimiter: existing.plugins?.path?.delimiter ?? ":",
      },
    },
  };
}

function buildMockFiles(): ProjectFile[] {
  return [
    {
      id: "main.tex",
      name: "main.tex",
      relativePath: "main.tex",
      absolutePath: "/tmp/harness/main.tex",
      type: "tex",
      content: SAMPLE_MAIN_TEX,
      isDirty: false,
    },
    {
      id: "template.pdf",
      name: "template.pdf",
      relativePath: "template.pdf",
      absolutePath: "/tmp/harness/template.pdf",
      type: "pdf",
      isDirty: false,
    },
  ];
}

function getTranslateY(transform: string): number {
  if (!transform || transform === "none") return 0;
  const matrix3dMatch = transform.match(/matrix3d\((.+)\)/);
  if (matrix3dMatch) {
    const values = matrix3dMatch[1]
      .split(",")
      .map((value) => Number(value.trim()));
    const y = values[13];
    return Number.isFinite(y) ? y : 0;
  }
  const matrixMatch = transform.match(/matrix\((.+)\)/);
  if (matrixMatch) {
    const values = matrixMatch[1]
      .split(",")
      .map((value) => Number(value.trim()));
    const y = values[5];
    return Number.isFinite(y) ? y : 0;
  }
  const translate3dMatch = transform.match(
    /translate3d\(\s*[-+]?\d*\.?\d+(?:px|%)?\s*,\s*([-+]?\d*\.?\d+)(?:px|%)?/,
  );
  if (translate3dMatch) {
    const y = Number(translate3dMatch[1]);
    return Number.isFinite(y) ? y : 0;
  }
  const translateYMatch = transform.match(
    /translateY\(\s*([-+]?\d*\.?\d+)(?:px|%)?\s*\)/,
  );
  if (translateYMatch) {
    const y = Number(translateYMatch[1]);
    return Number.isFinite(y) ? y : 0;
  }
  return 0;
}

function sampleFrame(root: HTMLElement, elapsedMs: number): TransferSample {
  const drawerComposer = root.querySelector<HTMLElement>(
    "[data-chat-drawer-panel='true'] [data-chat-composer-shell='true']",
  );
  const panelComposer = root.querySelector<HTMLElement>(
    "[data-workspace-chat-pane='true'] [data-chat-composer-shell='true']",
  );
  const drawerStyle = drawerComposer
    ? window.getComputedStyle(drawerComposer)
    : null;
  const panelStyle = panelComposer
    ? window.getComputedStyle(panelComposer)
    : null;

  return {
    elapsedMs,
    drawerComposerOpacity: drawerStyle
      ? Number(drawerStyle.opacity) || 0
      : null,
    drawerComposerTranslateY: drawerStyle
      ? getTranslateY(drawerStyle.transform)
      : null,
    drawerComposerPhase:
      drawerComposer?.getAttribute("data-composer-transfer-phase") ?? null,
    panelComposerOpacity: panelStyle ? Number(panelStyle.opacity) || 0 : null,
    panelComposerTranslateY: panelStyle
      ? getTranslateY(panelStyle.transform)
      : null,
    panelComposerPhase:
      panelComposer?.getAttribute("data-composer-transfer-phase") ?? null,
  };
}

async function captureFrames(
  root: HTMLElement,
  durationMs: number,
  targetMode: "drawer" | "workspace",
): Promise<TransferSample[]> {
  const frames: TransferSample[] = [];
  const start = performance.now();
  return new Promise((resolve) => {
    const step = () => {
      const now = performance.now();
      const sample = sampleFrame(root, now - start);
      frames.push(sample);
      const targetPhase =
        targetMode === "drawer"
          ? sample.drawerComposerPhase
          : sample.panelComposerPhase;
      const targetOpacity =
        targetMode === "drawer"
          ? sample.drawerComposerOpacity
          : sample.panelComposerOpacity;
      const targetTranslateY =
        targetMode === "drawer"
          ? sample.drawerComposerTranslateY
          : sample.panelComposerTranslateY;
      const settled =
        targetPhase === "idle" &&
        targetOpacity !== null &&
        targetOpacity >= 0.95 &&
        targetTranslateY !== null &&
        Math.abs(targetTranslateY) <= 2;
      // Record through completion when rendering is slow; keep a hard timeout
      // so a stuck transfer still fails the existing phase and motion checks.
      if ((now - start >= durationMs && settled) || now - start >= 5000) {
        resolve(frames);
        return;
      }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

function analyzeTransfer(
  name: "drawer_to_workspace" | "workspace_to_drawer",
  samples: TransferSample[],
  targetModeReached: boolean,
): TransferCheck {
  const sourceIsDrawer = name === "drawer_to_workspace";
  const sourceExitPhase = sourceIsDrawer ? "drawer_exit" : "panel_exit";
  const targetEnterPrepPhase = sourceIsDrawer
    ? "panel_enter_prep"
    : "drawer_enter_prep";
  const targetEnterPhase = sourceIsDrawer ? "panel_enter" : "drawer_enter";

  const sourceTranslate = (sample: TransferSample) =>
    sourceIsDrawer
      ? (sample.drawerComposerTranslateY ?? 0)
      : (sample.panelComposerTranslateY ?? 0);
  const sourceOpacity = (sample: TransferSample) =>
    sourceIsDrawer
      ? (sample.drawerComposerOpacity ?? 1)
      : (sample.panelComposerOpacity ?? 1);
  const sourcePhase = (sample: TransferSample) =>
    sourceIsDrawer ? sample.drawerComposerPhase : sample.panelComposerPhase;

  const targetTranslate = (sample: TransferSample) =>
    sourceIsDrawer
      ? (sample.panelComposerTranslateY ?? 0)
      : (sample.drawerComposerTranslateY ?? 0);
  const targetOpacity = (sample: TransferSample) =>
    sourceIsDrawer
      ? (sample.panelComposerOpacity ?? 0)
      : (sample.drawerComposerOpacity ?? 0);
  const targetPhase = (sample: TransferSample) =>
    sourceIsDrawer ? sample.panelComposerPhase : sample.drawerComposerPhase;

  const sourceExitStartFrame = samples.findIndex(
    (sample) =>
      sourcePhase(sample) === sourceExitPhase || sourceTranslate(sample) > 4,
  );
  const targetEnterPrepStartFrame = samples.findIndex(
    (sample) =>
      targetPhase(sample) === targetEnterPrepPhase ||
      (targetTranslate(sample) > 4 && targetOpacity(sample) < 0.2),
  );
  const targetEnterStartFrame = samples.findIndex(
    (sample) => targetPhase(sample) === targetEnterPhase,
  );

  const maxSourceTranslateY = samples.reduce(
    (max, sample) => Math.max(max, sourceTranslate(sample)),
    0,
  );
  const minSourceOpacity = samples.reduce(
    (min, sample) => Math.min(min, sourceOpacity(sample)),
    1,
  );
  const maxTargetTranslateY = samples.reduce(
    (max, sample) => Math.max(max, targetTranslate(sample)),
    0,
  );
  const finalSample = samples[samples.length - 1];
  const finalTargetTranslateY = finalSample ? targetTranslate(finalSample) : 0;
  const finalTargetOpacity = finalSample ? targetOpacity(finalSample) : 0;
  const pass =
    sourceExitStartFrame >= 0 &&
    targetEnterPrepStartFrame > sourceExitStartFrame &&
    targetEnterStartFrame >= targetEnterPrepStartFrame &&
    maxSourceTranslateY >= (sourceIsDrawer ? 0 : 10) &&
    minSourceOpacity <= 1.01 &&
    maxTargetTranslateY >= 10 &&
    finalTargetTranslateY <= 2 &&
    finalTargetOpacity >= 0.95 &&
    targetModeReached;

  return {
    name,
    pass,
    sourceExitStartFrame,
    targetEnterPrepStartFrame,
    targetEnterStartFrame,
    maxSourceTranslateY,
    minSourceOpacity,
    maxTargetTranslateY,
    finalTargetTranslateY,
    finalTargetOpacity,
    totalFrames: samples.length,
    targetModeReached,
  };
}

async function waitMs(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export function InputTransferHarness() {
  useAgentEvents();
  ensureDesktopBrowserMocks();

  const rootRef = useRef<HTMLDivElement>(null);
  const [report, setReport] = useState<InputTransferHarnessReport | null>(null);
  const [isRunning, setIsRunning] = useState(false);

  useEffect(() => {
    useDocumentStore.setState((state) => ({
      ...state,
      projectRoot: "/tmp/harness",
      files: buildMockFiles(),
      folders: [],
      activeFileId: "main.tex",
      openFileIds: ["main.tex", "template.pdf"],
      initialized: true,
    }));

    window.__newInputTransferChat = () =>
      useAgentChatStore.getState().createTab();
    window.__selectInputTransferHarnessText = (text) => {
      const store = useDocumentStore.getState();
      const file = store.files.find(
        (candidate) => candidate.id === store.activeFileId,
      );
      const start = file?.content?.indexOf(text) ?? -1;
      if (start < 0) return false;
      store.setSelectionRange({ start, end: start + text.length });
      return true;
    };
    window.__getInputTransferHarnessSelectionState = () => {
      const store = useDocumentStore.getState();
      return {
        selectionRange: store.selectionRange,
        selectionPreviewRange: store.selectionPreviewRange,
      };
    };

    return () => {
      delete window.__newInputTransferChat;
      delete window.__selectInputTransferHarnessText;
      delete window.__getInputTransferHarnessSelectionState;
    };
  }, []);

  const runHarness =
    useCallback(async (): Promise<InputTransferHarnessReport> => {
      const root = rootRef.current;
      if (!root) {
        const empty: InputTransferHarnessReport = {
          pass: false,
          checks: [],
          finishedAtIso: new Date().toISOString(),
        };
        setReport(empty);
        return empty;
      }

      const clickMode = (mode: "drawer" | "workspace"): boolean => {
        const label = mode === "workspace" ? "Workspace" : "Expanded";
        const target = root.querySelector<HTMLButtonElement>(
          `button[data-chat-display="${label}"]`,
        );
        if (!target) return false;
        target.click();
        return true;
      };

      const isModeSelected = (mode: "drawer" | "workspace"): boolean =>
        root
          .querySelector("[data-workspace-mode-area]")
          ?.getAttribute("data-chat-layout") ===
        (mode === "workspace" ? "workspace" : "drawer");

      const runCase = async (
        name: "drawer_to_workspace" | "workspace_to_drawer",
        targetMode: "drawer" | "workspace",
      ): Promise<TransferCheck> => {
        const clicked = clickMode(targetMode);
        if (!clicked) {
          return {
            name,
            pass: false,
            sourceExitStartFrame: -1,
            targetEnterPrepStartFrame: -1,
            targetEnterStartFrame: -1,
            maxSourceTranslateY: 0,
            minSourceOpacity: 1,
            maxTargetTranslateY: 0,
            finalTargetTranslateY: 0,
            finalTargetOpacity: 0,
            totalFrames: 0,
            targetModeReached: false,
          };
        }
        const samples = await captureFrames(
          root,
          CAPTURE_DURATION_MS,
          targetMode,
        );
        await waitMs(FRAME_SETTLE_DELAY_MS);
        return analyzeTransfer(name, samples, isModeSelected(targetMode));
      };

      setIsRunning(true);
      setReport(null);

      // Baseline mode for deterministic sequencing.
      if (!isModeSelected("drawer")) {
        clickMode("drawer");
        await waitMs(CAPTURE_DURATION_MS);
      }
      await waitMs(220);

      const checks = [
        await runCase("drawer_to_workspace", "workspace"),
        await runCase("workspace_to_drawer", "drawer"),
      ];

      const nextReport: InputTransferHarnessReport = {
        pass: checks.every((check) => check.pass),
        checks,
        finishedAtIso: new Date().toISOString(),
      };
      window.__inputTransferHarnessReport = nextReport;
      setReport(nextReport);
      setIsRunning(false);
      return nextReport;
    }, []);

  useEffect(() => {
    window.__runInputTransferHarness = runHarness;
    return () => {
      delete window.__runInputTransferHarness;
      delete window.__inputTransferHarnessReport;
    };
  }, [runHarness]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("autorun") !== "1") return;
    void runHarness();
  }, [runHarness]);

  const reportJson = useMemo(
    () => (report ? JSON.stringify(report, null, 2) : ""),
    [report],
  );

  return (
    <div ref={rootRef} className="relative h-screen min-h-0 bg-background">
      <SolarModeEffect />
      <WorkspaceLayout />
      <div
        data-input-transfer-harness-overlay
        className="pointer-events-none absolute top-3 right-3 z-[100] w-[420px] rounded-lg border border-border/70 bg-background/95 p-3 shadow-lg backdrop-blur"
      >
        <div className="mb-2 flex items-center justify-between">
          <div className="font-semibold text-xs">Input Transfer Harness</div>
          <button
            type="button"
            onClick={() => void runHarness()}
            className="pointer-events-auto rounded border px-2 py-1 text-xs"
            disabled={isRunning}
          >
            {isRunning ? "Running..." : "Run"}
          </button>
        </div>
        {report ? (
          <pre className="max-h-[240px] overflow-auto rounded border bg-muted/30 p-2 font-mono text-[11px]">
            {reportJson}
          </pre>
        ) : (
          <div className="rounded border border-dashed p-2 text-muted-foreground text-xs">
            No report yet.
          </div>
        )}
      </div>
    </div>
  );
}
