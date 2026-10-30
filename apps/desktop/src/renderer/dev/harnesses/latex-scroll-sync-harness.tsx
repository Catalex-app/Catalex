import { useEffect, useMemo, useRef, useState } from "react";
import { LatexEditor } from "@/components/workspace/editor/latex-editor";
import { PdfPreview } from "@/components/workspace/preview/pdf-preview";
import { SyncNavigationControl } from "@/components/workspace/sync-navigation-control";
import { useDocumentStore } from "@/stores/document-store";
import { useSettingsStore } from "@/stores/settings-store";
import { shouldMuteLatexScrollSync } from "@/lib/latex-project";
import { ensureDesktopBrowserMocks } from "../desktop-browser-mocks";

const LINES_PER_PDF_PAGE = 50;
const PDF_PAGE_HEIGHT = 842;
const SOURCE_LINES = Array.from(
  { length: 400 },
  (_, index) => `Sync harness source line ${index + 1}`,
);
const SAMPLE_TEX = `% SyncTeX harness
\\documentclass{book}
\\begin{document}
${SOURCE_LINES.join("\n")}
\\end{document}
`;
const CHAPTER_TEX = Array.from(
  { length: 150 },
  (_, index) => `Included chapter source line ${index + 1}`,
).join("\n");

function LatexScrollSyncHarnessContent({ multiFile }: { multiFile: boolean }) {
  ensureDesktopBrowserMocks();
  const [ready, setReady] = useState(false);
  const [pdfScrollTarget, setPdfScrollTarget] = useState<{
    id: number;
    position: number;
  } | null>({ id: 1, position: 0 });
  const [editorScrollTarget, setEditorScrollTarget] = useState<{
    id: number;
    position: number;
  } | null>(null);
  const [syncNavigationRequest, setSyncNavigationRequest] = useState<{
    id: number;
    direction: "to-editor" | "to-pdf";
  } | null>(null);
  const [mapCalls, setMapCalls] = useState(0);
  const nativeWorkRef = useRef({ running: 0, max: 0 });
  const [viewCalls, setViewCalls] = useState(0);
  const [editCalls, setEditCalls] = useState(0);
  const targetIdRef = useRef(1);
  const editorTargetIdRef = useRef(0);
  const navigationIdRef = useRef(0);
  const samplePdfRef = useRef<Uint8Array | null>(null);
  const cursorPosition = useDocumentStore((state) => state.cursorPosition);
  const activeFileId = useDocumentStore((state) => state.activeFileId);
  const projectRoot = useDocumentStore((state) => state.projectRoot);
  const scrollSyncLocked = useSettingsStore(
    (state) =>
      (projectRoot
        ? state.scrollSyncByProject[projectRoot]?.[activeFileId]
        : undefined) ?? true,
  );
  const files = useDocumentStore((state) => state.files);
  const scrollSyncMuted = useMemo(
    () => ready && shouldMuteLatexScrollSync(activeFileId, files),
    [activeFileId, files, ready],
  );
  const scrollSyncEnabled = scrollSyncLocked && !scrollSyncMuted;

  useEffect(() => {
    const win = window as Window & {
      __TAURI_INTERNALS__?: {
        invoke?: (
          cmd: string,
          args?: Record<string, unknown>,
          options?: Record<string, unknown>,
        ) => Promise<unknown>;
      };
    };
    const previousInvoke = win.__TAURI_INTERNALS__?.invoke;
    const params = new URLSearchParams(location.search);
    const delay = async () => {
      const work = nativeWorkRef.current;
      work.running += 1;
      work.max = Math.max(work.max, work.running);
      document
        .querySelector("[data-native-concurrency]")
        ?.setAttribute("data-native-concurrency", String(work.max));
      if (params.has("slow-native"))
        await new Promise((resolve) => setTimeout(resolve, 220));
      work.running -= 1;
    };
    if (win.__TAURI_INTERNALS__) {
      win.__TAURI_INTERNALS__.invoke = async (cmd, args, options) => {
        if (cmd === "get_synctex_source_map") {
          setMapCalls((count) => count + 1);
          if (!params.has("cached-map")) return null;
          return {
            inputs: { 1: "main.tex" },
            boxes: SOURCE_LINES.map((_, i) => ({
              page: Math.floor(i / LINES_PER_PDF_PAGE) + 1,
              x: 200,
              y:
                ((i % LINES_PER_PDF_PAGE) * PDF_PAGE_HEIGHT) /
                LINES_PER_PDF_PAGE,
              width: 200,
              height: 8,
              sources: [{ tag: 1, line: i + 1 }],
            })),
          };
        }
        if (cmd === "synctex_view") {
          const line = Number(args?.line ?? 1);
          setViewCalls((count) => count + 1);
          await delay();
          return {
            page: Math.max(
              1,
              Math.min(8, Math.ceil(line / LINES_PER_PDF_PAGE)),
            ),
            x: 300,
            y:
              ((Math.max(1, line) - 1) % LINES_PER_PDF_PAGE) *
              (PDF_PAGE_HEIGHT / LINES_PER_PDF_PAGE),
          };
        }
        if (cmd === "synctex_edit") {
          const page = Number(args?.page ?? 1);
          const y = Number(args?.y ?? 0);
          setEditCalls((count) => count + 1);
          await delay();
          return {
            file:
              multiFile && page >= 6 ? "chapters/chapter-two.tex" : "main.tex",
            line: Math.max(
              1,
              Math.min(
                SOURCE_LINES.length,
                (page - 1) * LINES_PER_PDF_PAGE +
                  Math.round((y / PDF_PAGE_HEIGHT) * LINES_PER_PDF_PAGE) +
                  1,
              ),
            ),
            column: 1,
          };
        }
        return previousInvoke?.(cmd, args, options) ?? null;
      };
    }

    useSettingsStore.setState({
      compilerBackend: "latexmk",
      compilerEngine: "auto",
      compilerChoicesByRoot: {},
    });
    useDocumentStore.setState({
      projectRoot: "/tmp/latex-scroll-sync-harness",
      files: [
        {
          id: "main.tex",
          name: "main.tex",
          relativePath: "main.tex",
          absolutePath: "/tmp/latex-scroll-sync-harness/main.tex",
          type: "tex",
          content: multiFile
            ? SAMPLE_TEX.replace(
                "\\begin{document}",
                "\\begin{document}\n\\include{chapters/chapter-two}",
              )
            : SAMPLE_TEX,
          isDirty: false,
        },
        {
          id: "chapters/chapter-two.tex",
          name: "chapter-two.tex",
          relativePath: "chapters/chapter-two.tex",
          absolutePath:
            "/tmp/latex-scroll-sync-harness/chapters/chapter-two.tex",
          type: "tex",
          content: CHAPTER_TEX,
          isDirty: false,
        },
      ],
      folders: ["chapters"],
      activeFileId: "main.tex",
      openFileIds: ["main.tex"],
      cursorPosition: 0,
      selectionRange: null,
      jumpToPosition: null,
      initialized: false,
      compileError: null,
      isCompiling: false,
      pendingRecompile: false,
      isSaving: false,
      contentGeneration: 1,
    });

    let cancelled = false;
    fetch("/examples/book-standard/main.pdf")
      .then((response) => response.arrayBuffer())
      .then((buffer) => {
        if (cancelled) return;
        const pdfData = new Uint8Array(buffer);
        samplePdfRef.current = pdfData;
        useDocumentStore.getState().setPdfData(pdfData, "main.tex");
        useDocumentStore.setState({ initialized: true });
        setReady(true);
      });

    return () => {
      cancelled = true;
      if (win.__TAURI_INTERNALS__) {
        win.__TAURI_INTERNALS__.invoke = previousInvoke;
      }
    };
  }, [multiFile]);

  const syncCurrentEditorPosition = () => {
    const state = useDocumentStore.getState();
    targetIdRef.current += 1;
    setPdfScrollTarget({
      id: targetIdRef.current,
      position: state.selectionRange?.start ?? state.cursorPosition,
    });
  };

  const simulateRecompile = () => {
    const pdfData = samplePdfRef.current;
    if (!pdfData) return;
    const pdfScroller = document.querySelector<HTMLElement>(
      '[data-testid="pdf-scroll-container"]',
    );
    if (pdfScroller) pdfScroller.scrollTop = 0;
    useDocumentStore.getState().setPdfData(new Uint8Array(pdfData), "main.tex");
  };

  return (
    <div
      className="flex h-screen w-screen flex-col bg-muted p-4"
      data-testid="latex-scroll-sync-harness-shell"
      data-ready={ready}
      data-multi-file={multiFile}
      data-native-concurrency="0"
    >
      <div className="mb-3 flex h-8 items-center gap-4 text-xs">
        <span className="font-medium">
          LaTeX synchronized scrolling harness
        </span>
        <span>
          Map: <b data-testid="synctex-map-calls">{mapCalls}</b>
        </span>
        <span>
          SyncTeX view calls:{" "}
          <b data-testid="synctex-view-calls">{viewCalls}</b>
        </span>
        <span>
          SyncTeX edit calls:{" "}
          <b data-testid="synctex-edit-calls">{editCalls}</b>
        </span>
        <span className="ml-auto">
          Active file: <b data-testid="latex-active-file">{activeFileId}</b>
        </span>
        <span>
          Editor cursor:{" "}
          <b data-testid="latex-editor-cursor">{cursorPosition}</b>
        </span>
        <span>
          PDF target:{" "}
          <b data-testid="latex-pdf-scroll-target">
            {pdfScrollTarget?.position ?? -1}
          </b>
        </span>
        <button
          type="button"
          className="rounded border border-border px-2 py-1"
          data-testid="simulate-latex-recompile"
          onClick={simulateRecompile}
        >
          Simulate recompile
        </button>
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="min-h-0 w-1/2 overflow-hidden rounded-panel border border-border/70 bg-card">
          <LatexEditor
            assistantMode="artisan"
            suppressToolbar
            scrollSyncEnabled={scrollSyncEnabled}
            scrollSyncTarget={editorScrollTarget}
            onScrollPositionChange={(position) => {
              if (!scrollSyncEnabled) return;
              targetIdRef.current += 1;
              setPdfScrollTarget({ id: targetIdRef.current, position });
            }}
          />
        </div>
        <div className="relative w-2 shrink-0 bg-transparent">
          <SyncNavigationControl
            previewLabel="PDF"
            onScrollSyncEnabledChange={(enabled) => {
              if (!projectRoot) return;
              useSettingsStore
                .getState()
                .setFileScrollSync(projectRoot, activeFileId, enabled);
              setPdfScrollTarget(null);
              setEditorScrollTarget(null);
              if (enabled) syncCurrentEditorPosition();
            }}
            scrollSyncMuted={scrollSyncMuted}
            scrollSyncLocked={scrollSyncEnabled}
            onNavigateToPreview={() => {
              navigationIdRef.current += 1;
              setSyncNavigationRequest({
                id: navigationIdRef.current,
                direction: "to-pdf",
              });
            }}
            onNavigateToEditor={() => {
              navigationIdRef.current += 1;
              setSyncNavigationRequest({
                id: navigationIdRef.current,
                direction: "to-editor",
              });
            }}
          />
        </div>
        <div className="min-h-0 w-1/2 overflow-hidden rounded-panel border border-border/70 bg-card">
          <PdfPreview
            syncNavigationRequest={syncNavigationRequest}
            onSyncNavigationHandled={(id) => {
              setSyncNavigationRequest((request) =>
                request?.id === id ? null : request,
              );
            }}
            scrollSyncEnabled={scrollSyncEnabled}
            scrollSyncSourceTarget={pdfScrollTarget}
            onScrollSyncToEditor={(position) => {
              editorTargetIdRef.current += 1;
              setEditorScrollTarget({
                id: editorTargetIdRef.current,
                position,
              });
            }}
          />
        </div>
      </div>
    </div>
  );
}

export function LatexScrollSyncHarness() {
  return <LatexScrollSyncHarnessContent multiFile={false} />;
}

export function LatexMultiFileScrollSyncHarness() {
  return <LatexScrollSyncHarnessContent multiFile />;
}
