import { useWorkspaceTheme } from "@/hooks/use-workspace-theme";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Sidebar } from "@/components/workspace/sidebar";
import type { WorkspaceAssistantMode } from "@/components/workspace/assistant-mode-switch";
import { useDocumentStore, type ProjectFile } from "@/stores/document-store";
import { useProposedChangesStore } from "@/stores/proposed-changes-store";

type SidebarContentMode = "files" | "sessions";
type SidebarSectionId =
  | "files"
  | "sessions"
  | "outline"
  | "zotero"
  | "environment";

interface FrameSample {
  elapsedMs: number;
  maxOverlapPx: number;
  targetHeightPx: number;
}

interface TransitionCheck {
  name: string;
  mode: SidebarContentMode;
  section: SidebarSectionId;
  pass: boolean;
  maxOverlapPx: number;
  targetHeightDeltaPx: number;
  distinctTargetHeights: number;
  frameCount: number;
}

interface HarnessReport {
  pass: boolean;
  checks: TransitionCheck[];
  finishedAtIso: string;
}

declare global {
  interface Window {
    __runSidebarAnimationHarness?: () => Promise<HarnessReport>;
    __sidebarAnimationHarnessReport?: HarnessReport;
    __setSidebarPendingReview?: (pending: boolean) => void;
    __sidebarTrashRequests?: string[];
  }
}

const TRANSITION_CAPTURE_MS = 320;
const NO_OVERLAP_TOLERANCE_PX = 0.75;
const HEIGHT_DELTA_MIN_PX = 8;

const SAMPLE_MAIN_TEX = `% Harness sample
\\documentclass{article}
\\begin{document}
\\section{Introduction}
Text
\\section{Method}
Text
\\subsection{Model Design}
Text
\\section{Results}
Text
\\end{document}
`;

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
    {
      id: "references.bib",
      name: "references.bib",
      relativePath: "references.bib",
      absolutePath: "/tmp/harness/references.bib",
      type: "other",
      content: "",
      isDirty: false,
    },
    {
      id: "comments.json",
      name: "comments.json",
      relativePath: "comments.json",
      absolutePath: "/tmp/harness/comments.json",
      type: "other",
      content: '{"version":1,"files":{}}',
      isDirty: false,
    },
  ];
}

function sampleFrame(
  root: HTMLElement,
  mode: SidebarContentMode,
  targetSection: SidebarSectionId,
  elapsedMs: number,
): FrameSample {
  const activeStack = root.querySelector<HTMLElement>(
    `[data-sidebar-content-stack="${mode}"]`,
  );
  const sectionElements = Array.from(
    activeStack?.querySelectorAll<HTMLElement>("[data-sidebar-section]") ?? [],
  );
  const visibleRects = sectionElements
    .map((el) => el.getBoundingClientRect())
    .filter((rect) => rect.height > 0.5)
    .sort((a, b) => a.top - b.top);
  let maxOverlapPx = 0;
  for (let i = 1; i < visibleRects.length; i += 1) {
    const overlap = visibleRects[i - 1].bottom - visibleRects[i].top;
    if (overlap > maxOverlapPx) {
      maxOverlapPx = overlap;
    }
  }

  const targetRect = activeStack
    ?.querySelector<HTMLElement>(`[data-sidebar-section="${targetSection}"]`)
    ?.getBoundingClientRect();

  return {
    elapsedMs,
    maxOverlapPx,
    targetHeightPx: targetRect?.height ?? 0,
  };
}

async function captureTransitionFrames(
  root: HTMLElement,
  mode: SidebarContentMode,
  targetSection: SidebarSectionId,
  durationMs: number,
): Promise<FrameSample[]> {
  const frames: FrameSample[] = [];
  const start = performance.now();
  return new Promise((resolve) => {
    const step = () => {
      const now = performance.now();
      frames.push(sampleFrame(root, mode, targetSection, now - start));
      if (now - start >= durationMs) {
        resolve(frames);
        return;
      }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

function analyzeTransition(
  name: string,
  mode: SidebarContentMode,
  section: SidebarSectionId,
  frames: FrameSample[],
): TransitionCheck {
  const maxOverlapPx = frames.reduce(
    (max, frame) => Math.max(max, frame.maxOverlapPx),
    0,
  );
  const heights = frames.map((frame) => Math.round(frame.targetHeightPx));
  const minHeight = Math.min(...heights);
  const maxHeight = Math.max(...heights);
  const targetHeightDeltaPx = maxHeight - minHeight;
  const distinctTargetHeights = new Set(heights).size;
  const pass =
    maxOverlapPx <= NO_OVERLAP_TOLERANCE_PX &&
    targetHeightDeltaPx >= HEIGHT_DELTA_MIN_PX &&
    distinctTargetHeights >= 3;

  return {
    name,
    mode,
    section,
    pass,
    maxOverlapPx,
    targetHeightDeltaPx,
    distinctTargetHeights,
    frameCount: frames.length,
  };
}

export function SidebarAnimationHarness() {
  const rootRef = useRef<HTMLDivElement>(null);
  const [contentMode, setContentMode] = useState<SidebarContentMode>("files");
  const [assistantMode, setAssistantMode] =
    useState<WorkspaceAssistantMode>("duet");
  useWorkspaceTheme(assistantMode);
  const [report, setReport] = useState<HarnessReport | null>(null);
  const [isRunning, setIsRunning] = useState(false);

  useEffect(() => {
    const trashTest = new URLSearchParams(window.location.search).has(
      "trash-confirmation",
    );
    if (trashTest) window.__sidebarTrashRequests = [];
    useDocumentStore.setState((state) => ({
      ...state,
      projectRoot: null,
      files: trashTest
        ? [
            ...buildMockFiles(),
            {
              id: "chapters/intro.tex",
              name: "intro.tex",
              relativePath: "chapters/intro.tex",
              absolutePath: "/tmp/harness/chapters/intro.tex",
              type: "tex",
              content: "Chapter",
              isDirty: false,
            },
          ]
        : buildMockFiles(),
      ...(trashTest
        ? {
            deleteFile: async (id: string) => {
              window.__sidebarTrashRequests?.push(`file:${id}`);
            },
            deleteFolder: async (folder: string) => {
              window.__sidebarTrashRequests?.push(`folder:${folder}`);
            },
          }
        : {}),
      folders: [],
      activeFileId: "main.tex",
      openFileIds: ["main.tex"],
      initialized: true,
    }));
    const setPendingReview = (pending: boolean) => {
      useProposedChangesStore.setState({
        changes: pending
          ? [
              {
                id: "sidebar-pending-review",
                filePath: "references.bib",
                absolutePath: "/tmp/harness/references.bib",
                oldContent: "",
                newContent: "@article{pending-review}",
                toolName: "CodexEdit",
                timestamp: 1,
              },
            ]
          : [],
      });
    };
    setPendingReview(true);
    window.__setSidebarPendingReview = setPendingReview;
    return () => {
      setPendingReview(false);
      delete window.__setSidebarPendingReview;
      delete window.__sidebarTrashRequests;
    };
  }, []);

  const runHarness = useCallback(async (): Promise<HarnessReport> => {
    const root = rootRef.current;
    if (!root) {
      const emptyReport: HarnessReport = {
        pass: false,
        checks: [],
        finishedAtIso: new Date().toISOString(),
      };
      setReport(emptyReport);
      return emptyReport;
    }

    setIsRunning(true);
    const checks: TransitionCheck[] = [];

    const runCase = async (
      mode: SidebarContentMode,
      section: SidebarSectionId,
      toggleSelector: string,
    ) => {
      setContentMode(mode);
      await new Promise((resolve) =>
        requestAnimationFrame(() => resolve(null)),
      );
      await new Promise((resolve) => setTimeout(resolve, 30));
      const activeStack = root.querySelector<HTMLElement>(
        `[data-sidebar-content-stack="${mode}"]`,
      );
      const toggle = activeStack?.querySelector<HTMLElement>(toggleSelector);
      if (!toggle) {
        checks.push({
          name: `${mode}:${section}:toggle-missing`,
          mode,
          section,
          pass: false,
          maxOverlapPx: Number.POSITIVE_INFINITY,
          targetHeightDeltaPx: 0,
          distinctTargetHeights: 0,
          frameCount: 0,
        });
        return;
      }

      toggle.click();
      const collapseFrames = await captureTransitionFrames(
        root,
        mode,
        section,
        TRANSITION_CAPTURE_MS,
      );
      checks.push(
        analyzeTransition(
          `${mode}:${section}:collapse`,
          mode,
          section,
          collapseFrames,
        ),
      );

      toggle.click();
      const expandFrames = await captureTransitionFrames(
        root,
        mode,
        section,
        TRANSITION_CAPTURE_MS,
      );
      checks.push(
        analyzeTransition(
          `${mode}:${section}:expand`,
          mode,
          section,
          expandFrames,
        ),
      );
    };

    await runCase("files", "files", '[data-sidebar-toggle="files"]');
    await runCase("sessions", "sessions", '[data-sidebar-toggle="sessions"]');

    const nextReport: HarnessReport = {
      pass: checks.every((check) => check.pass),
      checks,
      finishedAtIso: new Date().toISOString(),
    };
    window.__sidebarAnimationHarnessReport = nextReport;
    setReport(nextReport);
    setIsRunning(false);
    return nextReport;
  }, []);

  useEffect(() => {
    window.__runSidebarAnimationHarness = runHarness;
    return () => {
      delete window.__runSidebarAnimationHarness;
      delete window.__sidebarAnimationHarnessReport;
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
    <div className="flex h-screen min-h-0 bg-background text-foreground">
      <div className="w-[360px] border-border border-r p-2">
        <div className="mb-2 flex items-center gap-2">
          <button
            type="button"
            className="rounded border px-2 py-1 text-xs"
            onClick={() => void runHarness()}
            disabled={isRunning}
          >
            {isRunning ? "Running..." : "Run Harness"}
          </button>
          <button
            type="button"
            className="rounded border px-2 py-1 text-xs"
            onClick={() =>
              setContentMode((prev) =>
                prev === "files" ? "sessions" : "files",
              )
            }
            disabled={isRunning}
          >
            Toggle Mode ({contentMode})
          </button>
        </div>
        <div
          ref={rootRef}
          className="h-[calc(100vh-5rem)] min-h-0 rounded border"
        >
          <Sidebar
            assistantMode={assistantMode}
            onAssistantModeChange={setAssistantMode}
            contentMode={contentMode}
            sessionPanel={<div />}
            disableInteractiveIntegrations={
              !new URLSearchParams(window.location.search).has(
                "trash-confirmation",
              )
            }
          />
        </div>
      </div>
      <div className="flex-1 overflow-auto p-3">
        <h1 className="mb-2 font-semibold text-sm">
          Sidebar Animation Harness
        </h1>
        <p className="mb-3 text-muted-foreground text-xs">
          Runs frame-sampled checks for top panel collapse/expand transitions
          and reports overlap/height-change invariants.
        </p>
        {report ? (
          <pre className="rounded border bg-muted/30 p-3 font-mono text-xs">
            {reportJson}
          </pre>
        ) : (
          <div className="rounded border border-dashed p-3 text-muted-foreground text-xs">
            No report yet.
          </div>
        )}
      </div>
    </div>
  );
}
