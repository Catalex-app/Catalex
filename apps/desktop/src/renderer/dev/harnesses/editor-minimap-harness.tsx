import { useEffect, useState } from "react";
import { EditorView } from "@codemirror/view";
import { LatexEditor } from "@/components/workspace/editor/latex-editor";
import type { InlineCommentsByFile } from "@/components/workspace/editor/inline-comment-storage";
import { useDocumentStore } from "@/stores/document-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useProposedChangesStore } from "@/stores/proposed-changes-store";
import { ensureDesktopBrowserMocks } from "../desktop-browser-mocks";

const markdown = new URLSearchParams(location.search).has("markdown");
const fileName = markdown ? "manuscript.md" : "manuscript.tex";
const prefix = markdown
  ? "# A long manuscript\n"
  : "\\documentclass{article}\n\\begin{document}\n\\section{A long manuscript}\n";
const BASELINE = `${prefix}${Array.from({ length: 1200 }, (_, i) => `Paragraph ${i + 1}. This is a line of the research manuscript.`).join("\n")}\n${markdown ? "" : "\\end{document}\n"}Obsolete final note.`;
const spelling = new URLSearchParams(location.search).has("spelling");
const spellingSample = markdown
  ? "# Speling sample\n\nThis sentnce has a speling mistake. Colour and color.\n`badcode` [visible link](https://badurl.invalid)\n\n"
  : String.raw`\section{Speling sample}
This sentnce has a speling mistake. Colour and color.
The model produces embeddings.
\textbf{Bold speling} \cite{badcite} \ref{badref} \label{badlabel}
$badmath$ \url{https://badurl.invalid} \includegraphics{badfile}
\begin{equation}badmath\end{equation}
\begin{verbatim}badcode\end{verbatim}
`;
const CURRENT =
  (spelling ? spellingSample : "") +
  BASELINE.replace(
    "Paragraph 110.",
    "A newly added observation.\nAnother new observation.\nParagraph 110.",
  )
    .replace(
      "Paragraph 470. This is a line of the research manuscript.",
      "Paragraph 470. The revised result now accounts for the full experiment.",
    )
    .replace("Paragraph 750. This is a line of the research manuscript.\n", "")
    .replace("\nObsolete final note.", "");

const comments: InlineCommentsByFile = {
  [fileName]: [
    { line: 270, text: "Please clarify the motivation for this experiment." },
    {
      line: 271,
      text: "Compare this result against the baseline.",
      agent: true,
    },
    { line: 920, text: "The conclusion should mention the sample size." },
  ].map((item, index) => {
    const needle = `Paragraph ${item.line}.`;
    const from = CURRENT.indexOf(needle);
    return {
      id: `minimap-comment-${index}`,
      from,
      to: from + needle.length,
      line: CURRENT.slice(0, from).split("\n").length,
      text: item.text,
      number: index + 1,
      ...(item.agent
        ? { origin: { provider: "claude" as const, sessionId: "minimap-demo" } }
        : {}),
    };
  }),
};

ensureDesktopBrowserMocks();
const bridge = (
  window as unknown as {
    __TAURI_INTERNALS__: {
      invoke: (
        command: string,
        args?: Record<string, unknown>,
      ) => Promise<unknown>;
    };
  }
).__TAURI_INTERNALS__;
const fallback = bridge.invoke;
bridge.invoke = async (command, args = {}) =>
  command === "git_head_file_content"
    ? {
        repo_found: true,
        head_content:
          args.filePath === fileName
            ? BASELINE
            : "Short document.\nNo changes here.",
        ignored: false,
      }
    : fallback(command, args);

declare global {
  interface Window {
    __editorMinimapHarness?: {
      insertAtStart: () => void;
      state: () => {
        first: number;
        last: number;
        lines: number;
        scrollTop: number;
        selection: number;
      } | null;
    };
  }
}

export function EditorMinimapHarness() {
  const [ready, setReady] = useState(false);
  const [dark, setDark] = useState(false);
  const [showComments, setShowComments] = useState(true);
  useEffect(() => {
    useSettingsStore.setState({
      displayComments: true,
      editorProblemsPanelOpenByProject: {
        [JSON.stringify("/tmp/minimap-harness")]: false,
      },
    });
    useDocumentStore.setState({
      projectRoot: "/tmp/minimap-harness",
      files: [
        {
          id: fileName,
          name: fileName,
          relativePath: fileName,
          absolutePath: `/tmp/minimap-harness/${fileName}`,
          type: markdown ? "other" : "tex",
          content: CURRENT,
          isDirty: false,
        },
        {
          id: "short.md",
          name: "short.md",
          relativePath: "short.md",
          absolutePath: "/tmp/minimap-harness/short.md",
          type: "other",
          content: "Short document.\nNo changes here.",
          isDirty: false,
        },
      ],
      folders: [],
      openFileIds: [fileName, "short.md"],
      activeFileId: fileName,
      initialized: true,
      cursorPosition: 0,
      selectionRange: null,
      jumpToPosition: null,
    });
    useDocumentStore
      .getState()
      .setCompileError("Fixture diagnostics", fileName, [
        {
          severity: "error",
          message: "Undefined control sequence in the experiment description.",
          file: fileName,
          line: 620,
        },
        {
          severity: "warning",
          message: "Reference needs another compilation pass.",
          file: fileName,
          line: new URLSearchParams(location.search).has("mixed-markers")
            ? comments[fileName][0].line
            : 621,
        },
        {
          severity: "warning",
          message: "A global message without a source location.",
        },
      ]);
    useProposedChangesStore.setState({ changes: [] });
    setReady(true);
    const getView = () => {
      const node = document.querySelector<HTMLElement>(".cm-editor");
      return node ? EditorView.findFromDOM(node) : null;
    };
    window.__editorMinimapHarness = {
      insertAtStart: () => {
        getView()?.dispatch({
          changes: {
            from: 0,
            insert: Array.from(
              { length: 50 },
              (_, i) => `% New line ${i + 1}\n`,
            ).join(""),
          },
        });
      },
      state: () => {
        const view = getView();
        if (!view) return null;
        const bounds = view.scrollDOM.getBoundingClientRect();
        return {
          first: view.state.doc.lineAt(
            view.lineBlockAtHeight(Math.max(0, bounds.top - view.documentTop))
              .from,
          ).number,
          last: view.state.doc.lineAt(
            view.lineBlockAtHeight(
              Math.max(0, bounds.bottom - view.documentTop),
            ).to,
          ).number,
          lines: view.state.doc.lines,
          scrollTop: view.scrollDOM.scrollTop,
          selection: view.state.selection.main.head,
        };
      },
    };
    return () => {
      delete window.__editorMinimapHarness;
    };
  }, []);
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);
  return (
    <div className="flex h-screen flex-col bg-background p-4 text-foreground">
      <div className="mb-3 flex flex-wrap items-center gap-3 text-sm">
        <strong>Document minimap</strong>
        <span className="text-muted-foreground">
          1,200 lines · changes, comments and problems
        </span>
        <button
          type="button"
          onClick={() => useDocumentStore.getState().setActiveFile(fileName)}
        >
          Long document
        </button>
        <button
          type="button"
          onClick={() => useDocumentStore.getState().setActiveFile("short.md")}
        >
          Short document
        </button>
        <button type="button" onClick={() => setDark(!dark)}>
          Toggle theme
        </button>
        <button type="button" onClick={() => setShowComments(!showComments)}>
          Toggle fixture comments
        </button>
        <button
          type="button"
          onClick={() => {
            useDocumentStore.getState().setActiveFile(fileName);
            useProposedChangesStore.setState({
              changes: [
                {
                  id: "minimap-review",
                  filePath: fileName,
                  absolutePath: `/tmp/minimap-harness/${fileName}`,
                  oldContent: CURRENT,
                  newContent: CURRENT.replace(
                    "Paragraph 850. This is a line of the research manuscript.\n",
                    "",
                  ),
                  toolName: "Edit",
                  timestamp: Date.now(),
                },
              ],
            });
          }}
        >
          Review changes
        </button>
      </div>
      <div className="min-h-0 flex-1" data-testid="minimap-harness-editor">
        {ready && (
          <LatexEditor
            suppressToolbar
            assistantMode="artisan"
            selectionAiEnabled={new URLSearchParams(location.search).has(
              "selectable-comments",
            )}
            debugInlineCommentsByFile={showComments ? comments : {}}
          />
        )}
      </div>
    </div>
  );
}
