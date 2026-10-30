import { CommentDeleteButtons } from "@/components/workspace/editor/comment-delete-buttons";
import { Toaster } from "@/components/ui/sonner";
import { useEffect } from "react";
import { useAgentCommentReveal } from "@/hooks/use-agent-comment-reveal";
import { EditorView } from "@codemirror/view";
import { LatexEditor } from "@/components/workspace/editor/latex-editor";
import { useDocumentStore } from "@/stores/document-store";
import { ensureDesktopBrowserMocks } from "../desktop-browser-mocks";

const SAMPLE_MAIN_TEX = `% Comment harness
\\documentclass{article}
\\begin{document}
\\section{Comment Harness}
Harness line 1
Harness line 2
Harness line 3
Harness line 4
Harness line 5
Harness line 6
Harness line 7
Harness line 8
Harness line 9
Harness line 10
Harness line 11
Harness line 12
Harness line 13
Harness line 14
Harness line 15
Harness line 16
Harness line 17
Harness line 18
Harness line 19
Harness line 20
Harness line 21
Harness line 22
Harness line 23
Harness line 24
Harness line 25
Harness line 26
Harness line 27
Harness line 28
Harness line 29
Harness line 30
Harness line 31
Harness line 32
Harness line 33
Harness line 34
Harness line 35
Harness line 36
Harness line 37
Harness line 38
Harness line 39
Harness line 40
\\end{document}
`;

declare global {
  interface Window {
    __editorCommentsHarness?: {
      ready?: boolean;
      selectText?: (needle: string) => boolean;
      selectRange?: (from: number, to: number) => boolean;
      selectTextInRow?: (rowNeedle: string, segmentNeedle: string) => boolean;
      replaceTextInRow?: (
        rowNeedle: string,
        segmentNeedle: string,
        replacement: string,
      ) => boolean;
      replaceDocument?: (replacement: string) => boolean;
      insertTextInRow?: (
        rowNeedle: string,
        offset: number,
        text: string,
      ) => boolean;
      coordsForText?: (needle: string) => {
        start: { x: number; y: number };
        end: { x: number; y: number };
      } | null;
      getState?: () => {
        cards: string[];
        markCount: number;
        cmSelection: {
          from: number;
          to: number;
          empty: boolean;
        } | null;
        docLength: number | null;
        docText: string | null;
        storedText: string | undefined;
        contentGeneration: number;
        isDirty: boolean | undefined;
        storeSelection: { start: number; end: number } | null;
      };
    };
  }
}

export function EditorCommentsHarness() {
  ensureDesktopBrowserMocks();
  useAgentCommentReveal();

  useEffect(() => {
    useDocumentStore.setState((state) => ({
      ...state,
      projectRoot: "/tmp/comment-harness",
      files: [
        {
          id: "main.tex",
          name: "main.tex",
          relativePath: "main.tex",
          absolutePath: "/tmp/comment-harness/main.tex",
          type: "tex",
          content: SAMPLE_MAIN_TEX,
          isDirty: false,
        },
        {
          id: "figure.svg",
          name: "figure.svg",
          relativePath: "figure.svg",
          absolutePath: "/tmp/comment-harness/figure.svg",
          type: "image",
          dataUrl: `data:image/svg+xml,${encodeURIComponent(
            '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="100"><rect width="160" height="100" fill="#7252b5"/></svg>',
          )}`,
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
    if (new URLSearchParams(window.location.search).has("problems-preview")) {
      useDocumentStore.getState().setCompileError("Harness error", "main.tex", [
        {
          severity: "error",
          message: "Harness error",
          file: "main.tex",
          line: 3,
        },
      ]);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    const attach = () => {
      if (cancelled) return;
      const editorRoot = document.querySelector(".cm-editor");
      if (!(editorRoot instanceof HTMLElement)) {
        requestAnimationFrame(attach);
        return;
      }

      const getView = () => {
        const currentEditorRoot = document.querySelector(".cm-editor");
        return currentEditorRoot instanceof HTMLElement
          ? EditorView.findFromDOM(currentEditorRoot)
          : null;
      };

      window.__editorCommentsHarness = {
        ready: true,
        selectText: (needle: string) => {
          const view = getView();
          if (!view) return false;
          const from = view.state.doc.toString().indexOf(needle);
          if (from < 0) return false;
          view.dispatch({
            selection: { anchor: from, head: from + needle.length },
            effects: EditorView.scrollIntoView(from, { y: "center" }),
          });
          useDocumentStore
            .getState()
            .setSelectionRange({ start: from, end: from + needle.length });
          view.focus();
          return true;
        },
        selectRange: (from: number, to: number) => {
          const view = getView();
          if (!view) return false;
          const docLength = view.state.doc.length;
          const selectionFrom = Math.max(0, Math.min(from, docLength));
          const selectionTo = Math.max(0, Math.min(to, docLength));
          view.dispatch({
            selection: { anchor: selectionFrom, head: selectionTo },
            effects: EditorView.scrollIntoView(selectionFrom, { y: "center" }),
          });
          useDocumentStore
            .getState()
            .setSelectionRange({ start: selectionFrom, end: selectionTo });
          view.focus();
          return true;
        },
        selectTextInRow: (rowNeedle: string, segmentNeedle: string) => {
          const view = getView();
          if (!view) return false;
          const doc = view.state.doc.toString();
          const rowStart = doc.indexOf(rowNeedle);
          if (rowStart < 0) return false;
          const segmentOffset = rowNeedle.indexOf(segmentNeedle);
          if (segmentOffset < 0) return false;
          const from = rowStart + segmentOffset;
          const to = from + segmentNeedle.length;
          view.dispatch({
            selection: { anchor: from, head: to },
            effects: EditorView.scrollIntoView(from, { y: "center" }),
          });
          useDocumentStore
            .getState()
            .setSelectionRange({ start: from, end: to });
          view.focus();
          return true;
        },
        replaceTextInRow: (
          rowNeedle: string,
          segmentNeedle: string,
          replacement: string,
        ) => {
          const view = getView();
          if (!view) return false;
          const doc = view.state.doc.toString();
          const rowStart = doc.indexOf(rowNeedle);
          if (rowStart < 0) return false;
          const segmentOffset = rowNeedle.indexOf(segmentNeedle);
          if (segmentOffset < 0) return false;
          const from = rowStart + segmentOffset;
          const to = from + segmentNeedle.length;
          view.dispatch({
            changes: { from, to, insert: replacement },
            selection: { anchor: from + replacement.length },
            effects: EditorView.scrollIntoView(from, { y: "center" }),
          });
          view.focus();
          return true;
        },
        replaceDocument: (replacement: string) => {
          const view = getView();
          if (!view) return false;
          view.dispatch({
            changes: {
              from: 0,
              to: view.state.doc.length,
              insert: replacement,
            },
            selection: { anchor: 0 },
          });
          view.focus();
          return true;
        },
        insertTextInRow: (rowNeedle: string, offset: number, text: string) => {
          const view = getView();
          if (!view) return false;
          const doc = view.state.doc.toString();
          const rowStart = doc.indexOf(rowNeedle);
          if (rowStart < 0 || offset < 0 || offset > rowNeedle.length) {
            return false;
          }
          const pos = rowStart + offset;
          view.dispatch({
            changes: { from: pos, insert: text },
            selection: { anchor: pos + text.length },
            effects: EditorView.scrollIntoView(pos, { y: "center" }),
          });
          view.focus();
          return true;
        },
        coordsForText: (needle: string) => {
          const view = getView();
          if (!view) return null;
          const from = view.state.doc.toString().indexOf(needle);
          if (from < 0) return null;
          const start = view.coordsAtPos(from);
          const end = view.coordsAtPos(from + needle.length);
          if (!start || !end) return null;
          return {
            start: {
              x: start.left + 1,
              y: start.top + (start.bottom - start.top) / 2,
            },
            end: {
              x: end.right - 1,
              y: end.top + (end.bottom - end.top) / 2,
            },
          };
        },
        getState: () => {
          const view = getView();
          return {
            cards: Array.from(
              document.querySelectorAll(".cm-inlineCommentText"),
            )
              .map((card) => card.textContent ?? "")
              .filter(Boolean),
            markCount: document.querySelectorAll(".cm-inlineCommentMark")
              .length,
            cmSelection: view
              ? {
                  from: view.state.selection.main.from,
                  to: view.state.selection.main.to,
                  empty: view.state.selection.main.empty,
                }
              : null,
            docLength: view?.state.doc.length ?? null,
            docText: view?.state.doc.toString() ?? null,
            storedText: useDocumentStore
              .getState()
              .files.find((file) => file.id === "main.tex")?.content,
            contentGeneration: useDocumentStore.getState().contentGeneration,
            isDirty: useDocumentStore
              .getState()
              .files.find((file) => file.id === "main.tex")?.isDirty,
            storeSelection: useDocumentStore.getState().selectionRange,
          };
        },
      };
    };

    attach();
    return () => {
      cancelled = true;
      delete window.__editorCommentsHarness;
    };
  }, []);

  return (
    <div className="flex min-h-screen items-start justify-center bg-background p-8 text-foreground">
      <div className="w-[980px]">
        <Toaster />
        <div className="w-[200px] rounded-md border">
          <CommentDeleteButtons />
        </div>
        <h1 className="mb-3 font-semibold text-sm">Editor Comments Harness</h1>
        <div className="mb-3 flex gap-3">
          {["main.tex", "figure.svg"].map((fileId) => (
            <button
              key={fileId}
              type="button"
              className="rounded border px-3 py-1 text-sm"
              onClick={() => useDocumentStore.getState().setActiveFile(fileId)}
            >
              {fileId}
            </button>
          ))}
        </div>
        <div
          data-testid="editor-comments-harness-shell"
          className="h-[520px] overflow-hidden rounded-2xl border border-border/70 bg-card"
        >
          <LatexEditor
            assistantMode={
              new URLSearchParams(window.location.search).has("artisan")
                ? "artisan"
                : "duet"
            }
            chatLayout={
              new URLSearchParams(window.location.search).has("vibe")
                ? "workspace"
                : "drawer"
            }
            selectionAiEnabled={
              !new URLSearchParams(window.location.search).has("artisan")
            }
            suppressToolbar
            debugInlineCommentsByFile={
              new URLSearchParams(window.location.search).has("draft-preview")
                ? {
                    "main.tex": [
                      {
                        ...editingPreviewComments["main.tex"][0],
                        number: undefined,
                        expectedNumber: 13,
                        text: "",
                      },
                    ],
                  }
                : new URLSearchParams(window.location.search).has(
                      "confirmation-preview",
                    )
                  ? new URLSearchParams(window.location.search).has(
                      "edit-preview",
                    )
                    ? editingPreviewComments
                    : confirmationPreviewComments
                  : undefined
            }
          />
        </div>
      </div>
    </div>
  );
}

const confirmationPreviewComments = {
  "main.tex": [
    {
      id: "preview-human",
      number: 12,
      from: 0,
      to: 9,
      line: 1,
      text: "Human comment confirmation preview.",
      createdAt: "2026-09-10T10:00:00Z",
    },
    {
      id: "preview-agent",
      number: 123,
      from: 20,
      to: 30,
      line: 2,
      text: "AI comment confirmation preview.",
      createdAt: "2026-09-10T10:00:00Z",
      origin: {
        provider: "codex" as const,
        sessionId: "preview",
        model: "gpt-5.4",
        thinkingEffort: "high",
      },
    },
  ],
};

const editingPreviewComments = {
  "main.tex": confirmationPreviewComments["main.tex"].map((comment) => ({
    ...comment,
    isEditing: true,
  })),
};
