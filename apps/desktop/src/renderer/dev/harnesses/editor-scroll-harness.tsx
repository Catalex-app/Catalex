import { useEffect, useState } from "react";
import { EditorView } from "@codemirror/view";
import { LatexEditor } from "@/components/workspace/editor/latex-editor";
import { useDocumentStore } from "@/stores/document-store";
import { ensureDesktopBrowserMocks } from "../desktop-browser-mocks";

const SAMPLE_MAIN_TEX = `% Scroll harness
\\documentclass{article}
\\begin{document}
\\section{Scroll Harness}
${Array.from({ length: 400 }, (_, i) => `Harness line ${i + 1}`).join("\n")}
\\end{document}
`;

export function EditorScrollHarness() {
  ensureDesktopBrowserMocks();
  const [debugState, setDebugState] = useState<{
    activeElement: string;
    cmSelection: {
      anchor: number;
      head: number;
      from: number;
      to: number;
    } | null;
    domSelectionText: string;
    eventLog: Array<{
      type: string;
      target: string;
      clientX: number;
      clientY: number;
      selectionText: string;
    }>;
  }>({
    activeElement: "",
    cmSelection: null,
    domSelectionText: "",
    eventLog: [],
  });

  useEffect(() => {
    useDocumentStore.setState((state) => ({
      ...state,
      projectRoot: "/tmp/harness",
      files: [
        {
          id: "main.tex",
          name: "main.tex",
          relativePath: "main.tex",
          absolutePath: "/tmp/harness/main.tex",
          type: "tex",
          content: SAMPLE_MAIN_TEX,
          isDirty: false,
        },
      ],
      folders: [],
      activeFileId: "main.tex",
      openFileIds: ["main.tex"],
      initialized: true,
      selectionRange: null,
      cursorPosition: 0,
      jumpToPosition: null,
    }));
  }, []);

  useEffect(() => {
    type HarnessEvent = {
      type: string;
      target: string;
      button: number;
      buttons: number;
      detail: number;
      clientX: number;
      clientY: number;
      shiftKey: boolean;
      selectionText: string;
    };

    const eventLog: HarnessEvent[] = [];
    const root = document.documentElement;
    let cleanup: (() => void) | null = null;
    const pushEvent = (event: MouseEvent) => {
      const target =
        event.target instanceof HTMLElement
          ? `${event.target.tagName}.${event.target.className}`
          : event.target instanceof Node
            ? event.target.nodeName
            : "unknown";
      eventLog.push({
        type: event.type,
        target,
        button: event.button,
        buttons: event.buttons,
        detail: event.detail,
        clientX: event.clientX,
        clientY: event.clientY,
        shiftKey: event.shiftKey,
        selectionText: window.getSelection()?.toString() ?? "",
      });
      if (eventLog.length > 40) eventLog.shift();
    };
    const listener = pushEvent as EventListener;

    const attach = () => {
      const cmRoot = document.querySelector(".cm-editor");
      if (!(cmRoot instanceof HTMLElement)) {
        requestAnimationFrame(attach);
        return;
      }

      const getView = () => EditorView.findFromDOM(cmRoot);
      const scroller = cmRoot.querySelector(".cm-scroller");
      const content = cmRoot.querySelector(".cm-content");
      cmRoot.addEventListener("mousedown", listener, true);
      cmRoot.addEventListener("mouseup", listener, true);
      cmRoot.addEventListener("click", listener, true);
      scroller?.addEventListener("mousedown", listener, true);
      scroller?.addEventListener("mouseup", listener, true);
      scroller?.addEventListener("click", listener, true);
      content?.addEventListener("mousedown", listener, true);
      content?.addEventListener("mouseup", listener, true);
      content?.addEventListener("click", listener, true);

      cleanup = () => {
        root.removeEventListener("mousedown", listener, true);
        root.removeEventListener("mouseup", listener, true);
        root.removeEventListener("click", listener, true);
        cmRoot.removeEventListener("mousedown", listener, true);
        cmRoot.removeEventListener("mouseup", listener, true);
        cmRoot.removeEventListener("click", listener, true);
        scroller?.removeEventListener("mousedown", listener, true);
        scroller?.removeEventListener("mouseup", listener, true);
        scroller?.removeEventListener("click", listener, true);
        content?.removeEventListener("mousedown", listener, true);
        content?.removeEventListener("mouseup", listener, true);
        content?.removeEventListener("click", listener, true);
      };

      (
        window as Window & {
          __editorScrollHarness?: Record<string, unknown>;
        }
      ).__editorScrollHarness = {
        ready: true,
        getState: () => {
          const view = getView();
          const selection = window.getSelection();
          const activeElement = document.activeElement;
          return {
            hasView: !!view,
            activeElement:
              activeElement instanceof HTMLElement
                ? `${activeElement.tagName}.${activeElement.className}`
                : (activeElement?.nodeName ?? ""),
            cmSelection: view
              ? {
                  anchor: view.state.selection.main.anchor,
                  head: view.state.selection.main.head,
                  from: view.state.selection.main.from,
                  to: view.state.selection.main.to,
                }
              : null,
            scrollTop: view?.scrollDOM.scrollTop ?? null,
            domSelection: selection
              ? {
                  text: selection.toString(),
                  anchorOffset: selection.anchorOffset,
                  focusOffset: selection.focusOffset,
                }
              : null,
            eventLog: [...eventLog],
          };
        },
      };
    };

    root.addEventListener("mousedown", listener, true);
    root.addEventListener("mouseup", listener, true);
    root.addEventListener("click", listener, true);
    attach();

    return () => {
      cleanup?.();
      delete (
        window as Window & {
          __editorScrollHarness?: Record<string, unknown>;
        }
      ).__editorScrollHarness;
    };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const next = (
        window as Window & {
          __editorScrollHarness?: { getState?: () => unknown };
        }
      ).__editorScrollHarness?.getState?.() as
        | {
            activeElement?: string;
            cmSelection?: {
              anchor: number;
              head: number;
              from: number;
              to: number;
            } | null;
            domSelection?: { text?: string } | null;
            eventLog?: Array<{
              type: string;
              target: string;
              clientX: number;
              clientY: number;
              selectionText: string;
            }>;
          }
        | undefined;
      if (!next) return;
      setDebugState({
        activeElement: next.activeElement ?? "",
        cmSelection: next.cmSelection ?? null,
        domSelectionText: next.domSelection?.text ?? "",
        eventLog: next.eventLog ?? [],
      });
    }, 120);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <div className="flex min-h-screen items-start justify-center bg-background p-8 text-foreground">
      <div className="w-[980px]">
        <h1 className="mb-3 font-semibold text-sm">Editor Scroll Harness</h1>
        <div
          data-testid="editor-scroll-harness-shell"
          className="h-[720px] overflow-hidden rounded-2xl border border-border/70 bg-card"
        >
          <LatexEditor
            assistantMode={
              new URLSearchParams(window.location.search).get(
                "assistantMode",
              ) === "duet"
                ? "duet"
                : "artisan"
            }
            suppressToolbar
          />
        </div>
        <div className="mt-4 rounded-xl border border-border/70 bg-card p-3 text-xs">
          <div className="font-medium">Live Debug</div>
          <div data-testid="debug-active-element" className="mt-2 font-mono">
            activeElement: {debugState.activeElement || "(none)"}
          </div>
          <div data-testid="debug-cm-selection" className="font-mono">
            cmSelection:{" "}
            {debugState.cmSelection
              ? `${debugState.cmSelection.from}-${debugState.cmSelection.to} (anchor ${debugState.cmSelection.anchor}, head ${debugState.cmSelection.head})`
              : "(none)"}
          </div>
          <div data-testid="debug-dom-selection" className="font-mono">
            domSelection:{" "}
            {debugState.domSelectionText
              ? JSON.stringify(debugState.domSelectionText)
              : "(empty)"}
          </div>
          <div className="mt-3 font-medium">Recent Events</div>
          <div
            data-testid="debug-event-log"
            className="mt-2 max-h-48 overflow-auto rounded border border-border/60 bg-muted/30 p-2 font-mono"
          >
            {debugState.eventLog.length === 0 ? (
              <div>(none)</div>
            ) : (
              debugState.eventLog.map((event, index) => (
                <div key={`${event.type}-${index}`}>
                  {event.type} @ ({Math.round(event.clientX)},
                  {Math.round(event.clientY)}) {event.target} sel=
                  {event.selectionText
                    ? JSON.stringify(event.selectionText)
                    : '""'}
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
