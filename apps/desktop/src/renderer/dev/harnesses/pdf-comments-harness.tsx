import listsPdf from "../fixtures/pdf-comments/lists.pdf?url";
import listsSource from "../fixtures/pdf-comments/lists.tex?raw";
import { Toaster } from "@/components/ui/sonner";
import hyperlinksPdf from "../fixtures/pdf-comments/hyperlinks.pdf?url";
import { preparePdfCommentLayout } from "@/lib/workspace-events";
import { AgentChatDrawer } from "@/components/agent-chat/agent-chat-drawer";
import multipagePdf from "../fixtures/pdf-comments/multipage.pdf?url";
import multipageSource from "../fixtures/pdf-comments/multipage.tex?raw";
import multipageMap from "../fixtures/pdf-comments/multipage-map.json";
import { useEffect, useState } from "react";
import { LatexEditor } from "@/components/workspace/editor/latex-editor";
import { PdfPreview } from "@/components/workspace/preview/pdf-preview";
import { useDocumentStore } from "@/stores/document-store";
import { useAgentChatStore } from "@/stores/agent-chat-store";
import { useSettingsStore } from "@/stores/settings-store";
import { ensureDesktopBrowserMocks } from "../desktop-browser-mocks";
import { getMupdfClient } from "@/lib/mupdf/mupdf-client";
import { getOrOpenDocument } from "@/lib/mupdf/pdf-doc-cache";

const ROOT = "/tmp/catalex-pdf-comments-harness";
export function PdfCommentsHarness() {
  useEffect(() => {
    const harness = window as Window & { __pdfChatDraft?: () => unknown };
    harness.__pdfChatDraft = () => {
      const state = useAgentChatStore.getState();
      return state.tabs.find((tab) => tab.id === state.activeTabId)?.draft
        .pinnedContexts;
    };
    return () => {
      delete harness.__pdfChatDraft;
    };
  }, []);
  const [layoutAnimating, setLayoutAnimating] = useState(false);
  const [showDrawer, setShowDrawer] = useState(false);
  const [editorVisible, setEditorVisible] = useState(true);
  const [ready, setReady] = useState(false);
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [lookupEnabled, setLookupEnabled] = useState(true);
  useEffect(() => {
    ensureDesktopBrowserMocks();
    let cancelled = false;
    const win = window as Window & {
      __TAURI_INTERNALS__?: {
        invoke?: (
          cmd: string,
          args?: Record<string, unknown>,
          options?: Record<string, unknown>,
        ) => Promise<unknown>;
      };
    };
    const original = win.__TAURI_INTERNALS__!.invoke;
    void (async () => {
      const performanceFixture = new URLSearchParams(
        window.location.search,
      ).has("performance");
      const multipage = new URLSearchParams(window.location.search).has(
        "multipage",
      );
      const listFixture = new URLSearchParams(window.location.search).has(
        "lists",
      );
      const pdf = new Uint8Array(
        await (
          await fetch(
            listFixture
              ? listsPdf
              : multipage
                ? new URLSearchParams(window.location.search).has("hyperlinks")
                  ? hyperlinksPdf
                  : multipagePdf
                : "/examples/paper-standard/main.pdf",
          )
        ).arrayBuffer(),
      );
      const { docId } = await getOrOpenDocument(pdf);
      const text = await getMupdfClient().getPageText(docId, 0);
      if (cancelled) return;
      const lines = text.blocks
        .flatMap((block) => block.lines)
        .filter((line) => line.text.trim().length > 8);
      const selected = multipage || listFixture ? lines : lines.slice(2, 5);
      const prefix = Array.from(
        { length: 80 },
        (_, i) => `% Source context ${i}\n`,
      ).join("");
      const formatted = new URLSearchParams(window.location.search).has(
        "formatted",
      );
      const sourceLines = selected.map((line) => line.text);
      if (formatted)
        sourceLines[0] = sourceLines[0].replace(
          "abstract",
          String.raw`\emph{abstract}`,
        );
      if (new URLSearchParams(window.location.search).has("generated-gap"))
        sourceLines[0] = sourceLines[0].replace(
          "abstract",
          String.raw`\custom{hidden}`,
        );
      if (new URLSearchParams(window.location.search).has("unmatched-source"))
        sourceLines[0] = "An entirely different sentence.";
      const content = listFixture
        ? `${prefix}${listsSource}`
        : `${prefix}${sourceLines.join("\n")}\n`;
      const from = prefix.length;
      const humanFrom = formatted
        ? from + sourceLines[0].indexOf(String.raw`\emph`)
        : from;
      const humanTo = formatted
        ? humanFrom + String.raw`\emph{abstract}`.length
        : from + selected[0].text.length;
      const agentFrom = formatted
        ? from + sourceLines[0].indexOf("abstract")
        : from;
      const agentTo = formatted
        ? agentFrom + "abstract".length
        : content.length - 1;
      localStorage.setItem(
        `catalex-harness-comments:${ROOT}`,
        JSON.stringify({
          "chapter.tex": [
            {
              id: "human-pdf",
              number: 1,
              from: humanFrom,
              to: humanTo,
              line: 81,
              text: "Clarify this sentence for the reader.",
            },
            {
              id: "agent-pdf",
              number: 1,
              from: agentFrom,
              to: agentTo,
              line: 81,
              text: "Check consistency across these lines.",
              origin: { provider: "codex", sessionId: "harness" },
            },
            {
              id: "resolved-pdf",
              from: humanFrom,
              to: humanTo,
              line: 81,
              text: "Resolved comment must stay hidden",
              resolved: true,
            },
          ],
        }),
      );
      if (performanceFixture) {
        const key = `catalex-harness-comments:${ROOT}`;
        const saved = JSON.parse(localStorage.getItem(key)!);
        for (let index = 0; index < 5; index++) {
          saved["chapter.tex"].push({
            ...saved["chapter.tex"][index % 2],
            id: `performance-${index}`,
            number: index + 2,
            text: `Performance review comment ${index + 1}`,
          });
        }
        const offscreenCount = Math.min(
          500,
          Math.max(
            0,
            Number(
              new URLSearchParams(window.location.search).get(
                "offscreenComments",
              ),
            ) || 0,
          ),
        );
        const paragraph =
          "A research paragraph discussing experiments, baselines, and evaluation.\n";
        for (let index = 0; index < offscreenCount; index++) {
          const offset = content.length + (500 + index * 2) * paragraph.length;
          saved["chapter.tex"].push({
            id: `offscreen-${index}`,
            number: index + 10,
            from: offset,
            to: offset + 20,
            line: 1,
            text: `Offscreen review comment ${index + 1}`,
          });
        }
        localStorage.setItem(key, JSON.stringify(saved));
      }
      win.__TAURI_INTERNALS__!.invoke = async (cmd, args, options) => {
        if (cmd === "get_synctex_source_map") {
          if (multipage)
            return {
              ...multipageMap,
              inputs: { ...multipageMap.inputs, 1: "multipage.tex" },
            };
          return {
            inputs: { 1: "chapter.tex" },
            boxes: selected.map((line, index) => ({
              page: 1,
              x: line.bbox.x,
              y: line.bbox.y,
              width: line.bbox.w,
              height: line.bbox.h,
              sources: [
                {
                  tag: 1,
                  line: 81 + (listFixture ? [3, 4, 6, 8, 9][index] : index),
                },
              ],
            })),
          };
        }
        if (cmd === "synctex_edit") {
          if (new URLSearchParams(window.location.search).has("auto-match"))
            return null;
          if (
            new URLSearchParams(window.location.search).has("delayed-source")
          ) {
            await new Promise((resolve) => setTimeout(resolve, 1200));
          }
          if (Number(args?.page) !== 1) return null;
          const index = selected.findIndex(
            (line) =>
              Number(args?.y) >= line.bbox.y - 1 &&
              Number(args?.y) <= line.bbox.y + line.bbox.h + 1,
          );
          return index < 0
            ? null
            : { file: "chapter.tex", line: 81 + index, column: 0 };
        }
        if (cmd === "compile_latex") return pdf.buffer;
        return original?.(cmd, args, options) ?? null;
      };
      useSettingsStore.setState({
        editorCommentsPanelOpenByProject: {},
        editorCommentFilterByProject: {},
      });
      useDocumentStore.setState({
        projectRoot: ROOT,
        activeFileId: "main.tex",
        files: [
          {
            id: "main.tex",
            name: "main.tex",
            relativePath: "main.tex",
            absolutePath: `${ROOT}/main.tex`,
            type: "tex",
            content:
              "\\documentclass{article}\n\\begin{document}\n\\input{chapter}\n\\end{document}",
            isDirty: false,
          },
          {
            id: "chapter.tex",
            name: "chapter.tex",
            relativePath: "chapter.tex",
            absolutePath: `${ROOT}/chapter.tex`,
            type: "tex",
            content: performanceFixture
              ? content +
                "A research paragraph discussing experiments, baselines, and evaluation.\n".repeat(
                  2000,
                )
              : content,
            isDirty: false,
          },
        ],
        content:
          "\\documentclass{article}\n\\begin{document}\n\\input{chapter}\n\\end{document}",
        initialized: false,
        isCompiling: false,
        compileError: null,
        contentGeneration: 0,
      });
      if (
        ["delayed-source", "auto-match"].some((key) =>
          new URLSearchParams(window.location.search).has(key),
        )
      ) {
        const chapter = useDocumentStore
          .getState()
          .files.find((file) => file.id === "chapter.tex")!;
        useDocumentStore.setState((state) => ({
          files: [
            ...state.files,
            {
              ...chapter,
              id: "duplicate.tex",
              name: "duplicate.tex",
              relativePath: "duplicate.tex",
              absolutePath: `${ROOT}/duplicate.tex`,
            },
          ],
        }));
      }
      if (multipage) {
        const selections = [
          { text: "First page comment target.", agent: false },
          {
            text: "and continues with a particular selected phrase",
            agent: true,
          },
          { text: "selected phrase", agent: false },
          { text: "Third page comment target.", agent: false },
        ];
        localStorage.setItem(
          `catalex-harness-comments:${ROOT}`,
          JSON.stringify({
            "multipage.tex": selections.map(({ text, agent }, index) => {
              const from = multipageSource.indexOf(text);
              return {
                id: `page-comment-${index}`,
                number: index + 1,
                from,
                to: from + text.length,
                line: multipageSource.slice(0, from).split("\n").length,
                text: `Review: ${text}`,
                ...(agent
                  ? { origin: { provider: "codex", sessionId: "harness" } }
                  : {}),
              };
            }),
          }),
        );
        useDocumentStore.setState({
          activeFileId: "multipage.tex",
          content: multipageSource,
          files: [
            {
              id: "multipage.tex",
              name: "multipage.tex",
              relativePath: "multipage.tex",
              absolutePath: `${ROOT}/multipage.tex`,
              type: "tex",
              content: multipageSource,
              isDirty: false,
            },
          ],
        });
      }
      useDocumentStore
        .getState()
        .setPdfData(pdf, multipage ? "multipage.tex" : "main.tex");
      setBytes(pdf);
      setReady(true);
    })();
    return () => {
      cancelled = true;
      win.__TAURI_INTERNALS__!.invoke = original;
    };
  }, []);
  return (
    <div
      data-workspace-mode-area="true"
      className="relative flex h-screen flex-col bg-background text-foreground"
    >
      <Toaster />
      <div className="flex gap-4 p-2 text-xs">
        <span>PDF comments harness</span>
        {new URLSearchParams(window.location.search).has("performance") && (
          <>
            <button
              type="button"
              onClick={() =>
                useDocumentStore.getState().setActiveFile("chapter.tex")
              }
            >
              Edit commented source
            </button>
            <button
              type="button"
              onClick={() =>
                useDocumentStore.getState().setActiveFile("main.tex")
              }
            >
              Edit main source
            </button>
            <button
              type="button"
              onClick={() => {
                const state = useDocumentStore.getState();
                if (bytes)
                  state.setPdfData(
                    new Uint8Array(bytes),
                    "main.tex",
                    state.contentGeneration,
                  );
              }}
            >
              Refresh fixture PDF
            </button>
          </>
        )}
        <button
          type="button"
          onClick={() => {
            const settings = useSettingsStore.getState();
            settings.setDisplayComments(!settings.displayComments);
          }}
        >
          Toggle comment visibility
        </button>
        <button
          type="button"
          onClick={() => {
            const settings = useSettingsStore.getState();
            settings.setShowPdfComments(!settings.showPdfComments);
          }}
        >
          Toggle PDF comments
        </button>
        <button
          type="button"
          onClick={() => useDocumentStore.getState().setIsCompiling(true)}
        >
          Start compilation
        </button>
        <button type="button" onClick={() => setShowDrawer(!showDrawer)}>
          Toggle chat drawer
        </button>
        <button
          type="button"
          onClick={() => {
            const next = !editorVisible;
            const delay = preparePdfCommentLayout(
              document.querySelector("[data-workspace-mode-area]"),
              next,
            );
            window.setTimeout(() => {
              setLayoutAnimating(true);
              setEditorVisible(next);
              window.setTimeout(() => setLayoutAnimating(false), 220);
            }, delay);
          }}
        >
          Toggle editor
        </button>
        <button
          type="button"
          onClick={() => {
            useDocumentStore
              .getState()
              .setContent(
                `${useDocumentStore.getState().files.find((file) => file.id === useDocumentStore.getState().activeFileId)?.content ?? ""}\n% edited`,
              );
          }}
        >
          Edit source
        </button>
        <button
          type="button"
          onClick={() => {
            if (bytes)
              useDocumentStore
                .getState()
                .setPdfData(
                  new Uint8Array(bytes),
                  useDocumentStore.getState().activeFileId ?? "main.tex",
                );
          }}
        >
          Recompile
        </button>
        <button
          type="button"
          onClick={() => {
            setLookupEnabled(!lookupEnabled);
            useDocumentStore.setState({
              agentWorkspaceRoot: lookupEnabled ? "/tmp/draft" : null,
            });
          }}
        >
          Toggle draft
        </button>
      </div>
      {showDrawer && (
        <div
          data-chat-drawer-overlay="true"
          className="pointer-events-none absolute inset-0 z-20"
        >
          <AgentChatDrawer />
        </div>
      )}
      {ready && (
        <div className="flex min-h-0 flex-1">
          <div
            className="min-h-0 shrink-0 overflow-hidden border-r transition-[width] duration-[220ms]"
            style={{ width: editorVisible ? "50%" : "0%" }}
          >
            <LatexEditor assistantMode="artisan" suppressToolbar />
          </div>
          <div className="flex min-w-0 flex-1 flex-col">
            <PdfPreview
              aiEnabled={["duet", "vibe"].includes(
                new URLSearchParams(window.location.search).get("mode") ??
                  "artisan",
              )}
              onRevealSource={() => setEditorVisible(true)}
              editorVisible={editorVisible}
              layoutAnimating={layoutAnimating}
            />
          </div>
        </div>
      )}
    </div>
  );
}
