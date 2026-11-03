import { useEffect, useRef, useState } from "react";
import { emit } from "@/lib/desktop/event";
import { PdfPreview } from "@/components/workspace/preview/pdf-preview";
import { useAgentEvents } from "@/hooks/use-agent-events";
import { useDocumentStore } from "@/stores/document-store";
import { ensureDesktopBrowserMocks } from "../desktop-browser-mocks";
import { MERGE_PREVIEW_REFRESH_EVENT } from "@/lib/workspace-events";

const projectSuffix = new URLSearchParams(window.location.search).get(
  "project",
);
const PROJECT_ROOT = `/tmp/pdf-preview-harness${projectSuffix ? `-${projectSuffix}` : ""}`;

const SAMPLE_MAIN_TEX = `% !TEX program = lualatex
\\documentclass{article}
\\begin{document}
PDF preview compiler harness
\\end{document}
`;

let compiledPdfBuffer: ArrayBuffer | null = null;

declare global {
  interface Window {
    __pdfPreviewHarness?: {
      getCompileRequestCount: () => number;
      getCompileRequestContents: () => string[];
      getCompileRequestChoices: () => Array<{
        backend: unknown;
        engine: unknown;
      }>;
      initialize: () => void;
      failNextCompile: () => void;
      isCompiling: () => boolean;
      requestMergePreviewRefresh: () => void;
      setCompileDelay: (delayMs: number) => void;
      setCancellationDelay: (delayMs: number) => void;
      getCancellationCount: () => number;
      getPreviewState: () => {
        pdfRevision: number;
        compileError: string | null;
      };
      setSourceContent: (content: string) => void;
    };
  }
}

export function PdfPreviewHarness() {
  ensureDesktopBrowserMocks();
  useAgentEvents();
  const sampleId =
    new URLSearchParams(window.location.search).get("sample") ??
    "paper-standard";
  const [compilePhase, setCompilePhase] = useState("loading");
  const [renderPhase, setRenderPhase] = useState("loading");
  const [renderedPageDataUrl, setRenderedPageDataUrl] = useState<string | null>(
    null,
  );
  const compileRequestCountRef = useRef(0);
  const compileRequestContentsRef = useRef<string[]>([]);
  const compileDelayRef = useRef(0);
  const cancellationDelayRef = useRef(0);
  const cancellationCountRef = useRef(0);
  const pendingCompilationsRef = useRef(new Map<string, () => Promise<void>>());
  const failNextCompileRef = useRef(false);
  const compileChoicesRef = useRef<
    Array<{ backend: unknown; engine: unknown }>
  >([]);

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
    if (win.__TAURI_INTERNALS__) {
      win.__TAURI_INTERNALS__.invoke = async (cmd, args, options) => {
        if (cmd === "compile_latex") {
          compileRequestCountRef.current += 1;
          compileChoicesRef.current.push({
            backend: args?.backend,
            engine: args?.engine,
          });
          compileRequestContentsRef.current.push(
            useDocumentStore.getState().files[0]?.content ?? "",
          );
          if (compileDelayRef.current > 0) {
            const id = String(args?.compilationId);
            const cancelled = await new Promise<boolean>((resolve) => {
              const timer = setTimeout(
                () => resolve(false),
                compileDelayRef.current,
              );
              let cleanup: Promise<void> | undefined;
              pendingCompilationsRef.current.set(id, () => {
                cleanup ??= new Promise<void>((finished) => {
                  clearTimeout(timer);
                  setTimeout(() => {
                    resolve(true);
                    finished();
                  }, cancellationDelayRef.current);
                });
                return cleanup;
              });
            });
            pendingCompilationsRef.current.delete(id);
            if (cancelled) {
              throw {
                code: "cancelled",
                message: "Compilation cancelled",
                diagnostics: [],
              };
            }
          }
          if (failNextCompileRef.current) {
            failNextCompileRef.current = false;
            throw new Error("Harness compilation failed");
          }
          (
            args?.diagnostics as
              | { onmessage: (value: unknown[]) => void }
              | undefined
          )?.onmessage([]);
          return compiledPdfBuffer ?? new ArrayBuffer(0);
        }
        if (cmd === "cancel_compilation") {
          cancellationCountRef.current += 1;
          if (args?.projectDir === PROJECT_ROOT) {
            await Promise.all(
              ((args?.compilationIds as string[]) ?? []).map((id) =>
                pendingCompilationsRef.current.get(id)?.(),
              ),
            );
          }
          return null;
        }
        if (cmd === "get_compiled_pdf") {
          return compiledPdfBuffer ?? new ArrayBuffer(0);
        }
        if (cmd === "resolve_verification_render_request") {
          const result = args?.result as
            | {
                status: "success";
                pages: Array<{ imageDataUrl: string }>;
              }
            | { status: "error" }
            | undefined;
          if (result?.status === "success" && result.pages[0]) {
            setRenderedPageDataUrl(result.pages[0].imageDataUrl);
            setRenderPhase("succeeded");
          } else {
            setRenderPhase("failed");
          }
          return null;
        }
        return previousInvoke?.(cmd, args, options) ?? null;
      };
    }

    useDocumentStore.setState({
      projectRoot: PROJECT_ROOT,
      files: [
        {
          id: "main.tex",
          name: "main.tex",
          relativePath: "main.tex",
          absolutePath: `${PROJECT_ROOT}/main.tex`,
          type: "tex",
          content: SAMPLE_MAIN_TEX,
          isDirty: false,
        },
      ],
      folders: [],
      activeFileId: "main.tex",
      openFileIds: ["main.tex"],
      initialized: false,
      compileError: null,
      isCompiling: false,
      pendingRecompile: false,
      isSaving: false,
      contentGeneration: 1,
    });
  }, []);

  useEffect(() => {
    window.__pdfPreviewHarness = {
      getCompileRequestCount: () => compileRequestCountRef.current,
      getCompileRequestContents: () => [...compileRequestContentsRef.current],
      getCompileRequestChoices: () => [...compileChoicesRef.current],
      initialize: () => useDocumentStore.setState({ initialized: true }),
      failNextCompile: () => {
        failNextCompileRef.current = true;
      },
      isCompiling: () => useDocumentStore.getState().isCompiling,
      requestMergePreviewRefresh: () => {
        useDocumentStore.setState({ initialized: true });
        window.dispatchEvent(new CustomEvent(MERGE_PREVIEW_REFRESH_EVENT));
      },
      setCompileDelay: (delayMs) => {
        compileDelayRef.current = delayMs;
      },
      setCancellationDelay: (delayMs) => {
        cancellationDelayRef.current = delayMs;
      },
      getCancellationCount: () => cancellationCountRef.current,
      getPreviewState: () => {
        const { pdfRevision, compileError } = useDocumentStore.getState();
        return { pdfRevision, compileError };
      },
      setSourceContent: (content) => {
        useDocumentStore.getState().updateFileContent("main.tex", content);
      },
    };
    return () => {
      delete window.__pdfPreviewHarness;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    fetch(`/examples/${sampleId}/main.pdf`)
      .then((response) => response.arrayBuffer())
      .then(async (buffer) => {
        if (cancelled) return;
        compiledPdfBuffer = buffer;
        if (new URLSearchParams(window.location.search).has("empty")) {
          useDocumentStore.setState({ initialized: true });
          setCompilePhase("succeeded");
          return;
        }
        await emit("catalex-verification-compile", {
          request_id: "pdf-preview-harness-initial",
          tab_id: "pdf-preview-harness",
          project_path: PROJECT_ROOT,
          root_id: "main.tex",
          main_file: "main.tex",
          backend: "latexmk",
          engine: "lualatex",
          status: "started",
        });
        await emit("catalex-verification-compile", {
          request_id: "pdf-preview-harness-initial",
          tab_id: "pdf-preview-harness",
          project_path: PROJECT_ROOT,
          root_id: "main.tex",
          main_file: "main.tex",
          backend: "latexmk",
          engine: "lualatex",
          status: "succeeded",
          duration_ms: 42,
        });
        await emit("catalex-verification-render-page", {
          request_id: "pdf-preview-harness-render",
          tab_id: "pdf-preview-harness",
          project_path: PROJECT_ROOT,
          root_id: "main.tex",
          pages: [1],
          target_width: 900,
        });
        if (!cancelled) setCompilePhase("succeeded");
      })
      .catch(() => {
        if (!cancelled) setCompilePhase("failed");
      });

    return () => {
      cancelled = true;
    };
  }, [sampleId]);

  return (
    <div
      className="h-screen w-screen bg-background"
      data-testid="pdf-preview-harness-shell"
      data-compile-phase={compilePhase}
      data-render-phase={renderPhase}
    >
      <PdfPreview />
      <aside className="fixed top-4 right-4 z-50 w-44 rounded-lg border border-border bg-background/95 p-2 shadow-xl">
        <div className="mb-2 font-medium text-foreground text-xs">
          Agent page inspection
        </div>
        {renderedPageDataUrl ? (
          <img
            src={renderedPageDataUrl}
            alt="Page 1 returned to Codex"
            className="h-auto w-full rounded border border-border"
            data-testid="agent-rendered-page"
          />
        ) : (
          <div className="text-muted-foreground text-xs">{renderPhase}</div>
        )}
      </aside>
    </div>
  );
}
