import { useEffect, useRef, useState } from "react";
import { AgentChatDrawer } from "@/components/agent-chat/agent-chat-drawer";
import { LatexEditor } from "@/components/workspace/editor/latex-editor";
import { useDocumentStore } from "@/stores/document-store";
import { useProposedChangesStore } from "@/stores/proposed-changes-store";
import { ensureDesktopBrowserMocks } from "../desktop-browser-mocks";
import { EditorView } from "@codemirror/view";
import { type InlineCommentsByFile } from "@/components/workspace/editor/inline-comment-storage";
import { MERGE_PREVIEW_REFRESH_EVENT } from "@/lib/workspace-events";
import { PdfPreview } from "@/components/workspace/preview/pdf-preview";
import {
  type AgentStreamMessage,
  useAgentChatStore,
} from "@/stores/agent-chat-store";

const OLD_MAIN_TEX = `% Diff harness
\\documentclass{article}
\\begin{document}
\\section{Draft}
This paragraph is the original text.
\\end{document}
`;

const NEW_MAIN_TEX = `% Diff harness
\\documentclass{article}
\\begin{document}
\\section{Revised Draft}
This paragraph has a proposed change from the assistant.
\\end{document}
`;

const RAW_CONFLICT_MAIN_TEX = `% Conflict harness
\\documentclass{article}
\\begin{document}
\\section{Introduction}
${"<".repeat(7)} HEAD
Making some issues
${"=".repeat(7)}
Making some problems
${">".repeat(7)} incoming
\\end{document}
`;

const RAW_MULTI_CONFLICT_MAIN_TEX = `% Conflict harness
\\documentclass{article}
\\begin{document}
\\section{Introduction}
${"<".repeat(7)} HEAD
First choice from current
${"=".repeat(7)}
First choice from incoming
${">".repeat(7)} incoming
Text between conflicts
${"<".repeat(7)} HEAD
Second choice from current
${"=".repeat(7)}
Second choice from incoming
${">".repeat(7)} incoming
\\end{document}
`;

const LONG_PREFIX = Array.from(
  { length: 80 },
  (_, index) => `Unchanged setup line ${index + 1}.`,
).join("\n");

const OLD_LONG_PREFIX_MAIN_TEX = `% Diff harness
\\documentclass{article}
\\begin{document}
${LONG_PREFIX}
This late paragraph is the original text.
\\end{document}
`;

const NEW_LONG_PREFIX_MAIN_TEX = `% Diff harness
\\documentclass{article}
\\begin{document}
${LONG_PREFIX}
This late paragraph has a proposed change from the assistant.
\\end{document}
`;

const DIFF_HARNESS_CHANGE = {
  id: "diff-harness-change",
  filePath: "main.tex",
  absolutePath: "/tmp/harness/main.tex",
  oldContent: OLD_MAIN_TEX,
  newContent: NEW_MAIN_TEX,
  toolName: "Edit",
  timestamp: Date.now(),
};

const LONG_PREFIX_DIFF_HARNESS_CHANGE = {
  ...DIFF_HARNESS_CHANGE,
  id: "diff-harness-long-prefix-change",
  oldContent: OLD_LONG_PREFIX_MAIN_TEX,
  newContent: NEW_LONG_PREFIX_MAIN_TEX,
};

function createLongPrefixInlineComments(): InlineCommentsByFile {
  const firstNeedle = "Unchanged setup line 40.";
  const secondNeedle = "Unchanged setup line 60.";
  const createdAt = new Date("2026-01-01T00:00:00.000Z").toISOString();

  return {
    "main.tex": [firstNeedle, secondNeedle].map((needle, index) => {
      const from = NEW_LONG_PREFIX_MAIN_TEX.indexOf(needle);
      const to = from + needle.length;
      const line =
        NEW_LONG_PREFIX_MAIN_TEX.slice(0, from).split("\n").length || 1;
      return {
        id: `diff-harness-comment-${index + 1}`,
        from,
        to,
        line,
        text: "A comment card that changes the pre-diff vertical layout before diff mode.",
        createdAt,
      };
    }),
  };
}

declare global {
  interface Window {
    __editorDiffHarness?: {
      ready?: boolean;
      prepareLongPrefixDocument?: () => boolean;
      selectText?: (needle: string) => boolean;
      setScrollTop?: (scrollTop: number) => boolean;
      activateDiffWithStaleWholeDocumentSelection?: () => boolean;
      activateDiffWithLongUnchangedPrefix?: () => boolean;
      leavePersistentReviewProject?: () => number;
      reopenPersistentReviewProject?: () => number;
      getState?: () => {
        storeSelection: { start: number; end: number } | null;
        cmSelection: { from: number; to: number; empty: boolean } | null;
        proposedPanelVisible: boolean;
        inlineCommentMarkCount: number;
        mergePreviewRefreshCount: number;
        compileRequestContents: string[];
      };
      getFirstDiffViewportMetrics?: () => {
        editorCenterY: number;
        firstDiffCenterY: number;
        deltaFromCenter: number;
      } | null;
    };
    __editorDiffHarnessCompileContents?: string[];
  }
}

export function EditorDiffHarness() {
  ensureDesktopBrowserMocks();
  const searchParams = new URLSearchParams(window.location.search);
  const persistentReviewMode = searchParams.get("persistentReview");
  const agentDraftMode = searchParams.get("agentDraft");
  const recoverDraftMode = searchParams.has("recoverDraft");
  const activeProposalProjectRoot = useProposedChangesStore(
    (state) => state.activeProjectRoot,
  );
  const persistentReviewReady =
    !persistentReviewMode || activeProposalProjectRoot === "/tmp/harness";
  const [debugInlineCommentsByFile, setDebugInlineCommentsByFile] = useState<
    InlineCommentsByFile | undefined
  >();
  const mergePreviewRefreshCountRef = useRef(0);

  useEffect(() => {
    const countMergePreviewRefresh = () => {
      mergePreviewRefreshCountRef.current += 1;
    };
    window.addEventListener(
      MERGE_PREVIEW_REFRESH_EVENT,
      countMergePreviewRefresh,
    );
    return () => {
      window.removeEventListener(
        MERGE_PREVIEW_REFRESH_EVENT,
        countMergePreviewRefresh,
      );
    };
  }, []);

  useEffect(() => {
    const deferDiff = new URLSearchParams(window.location.search).has(
      "deferDiff",
    );
    const gitConflictMode = new URLSearchParams(window.location.search).get(
      "gitConflict",
    );
    const gitConflict = gitConflictMode !== null;
    const showingAgentDraft = agentDraftMode === "review";
    window.__editorDiffHarnessCompileContents = [];

    useDocumentStore.setState((state) => ({
      ...state,
      projectRoot: "/tmp/harness",
      agentWorkspaceSessionId: showingAgentDraft ? "workspace-harness" : null,
      agentWorkspaceRoot: showingAgentDraft
        ? "/tmp/workspace-harness/candidate"
        : null,
      isAgentWorkspaceReadOnly: false,
      files: [
        {
          id: "main.tex",
          name: "main.tex",
          relativePath: "main.tex",
          absolutePath: showingAgentDraft
            ? "/tmp/workspace-harness/candidate/main.tex"
            : "/tmp/harness/main.tex",
          type: "tex",
          content: gitConflict
            ? gitConflictMode === "multi"
              ? RAW_MULTI_CONFLICT_MAIN_TEX
              : RAW_CONFLICT_MAIN_TEX
            : agentDraftMode === "working"
              ? OLD_MAIN_TEX
              : NEW_MAIN_TEX,
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

    if (agentDraftMode === "review") {
      useProposedChangesStore.getState().startWorkspaceReview(
        {
          version: 2,
          sessionId: "workspace-harness",
          projectRoot: "/tmp/harness",
          tabId: useAgentChatStore.getState().activeTabId,
          mode: "ask",
          status: "review",
          createdAt: Date.now(),
          updatedAt: Date.now(),
          sourceCommit: "fixture-source",
          baselineCommit: "fixture-baseline",
          candidateRoot: "/tmp/workspace-harness/candidate",
          warnings: [],
        },
        [
          {
            id: DIFF_HARNESS_CHANGE.id,
            kind: "modified",
            filePath: "main.tex",
            oldFilePath: "main.tex",
            newFilePath: "main.tex",
            sourceAbsolutePath: "/tmp/harness/main.tex",
            candidateAbsolutePath: "/tmp/workspace-harness/candidate/main.tex",
            oldContent: OLD_MAIN_TEX,
            newContent: NEW_MAIN_TEX,
            binary: false,
            sourceChanged: false,
          },
        ],
      );
      if (recoverDraftMode) {
        const recoveredMessages: AgentStreamMessage[] = [
          {
            type: "user",
            message: {
              content: [{ type: "text", text: "Polish this paragraph" }],
            },
          },
          {
            type: "result",
            result: "Polished the paragraph and verified the document.",
          },
        ];
        useAgentChatStore.setState((state) => ({
          tabs: state.tabs.map((tab) =>
            tab.id === state.activeTabId
              ? {
                  ...tab,
                  title: "Polish this paragraph",
                  messages: recoveredMessages,
                  error: null,
                }
              : tab,
          ),
          messages: recoveredMessages,
          error: null,
        }));
        useAgentChatStore.getState().requestDrawerOpen();
      }
    } else if (agentDraftMode === "working") {
      useProposedChangesStore.setState({
        changes: [],
        workspaceReview: null,
      });
    } else if (persistentReviewMode) {
      const proposedChangesStore = useProposedChangesStore.getState();
      proposedChangesStore.activateProject("/tmp/harness");
      if (
        persistentReviewMode === "seed" &&
        useProposedChangesStore.getState().changes.length === 0
      ) {
        proposedChangesStore.addChange({
          id: DIFF_HARNESS_CHANGE.id,
          filePath: DIFF_HARNESS_CHANGE.filePath,
          absolutePath: DIFF_HARNESS_CHANGE.absolutePath,
          oldContent: DIFF_HARNESS_CHANGE.oldContent,
          newContent: DIFF_HARNESS_CHANGE.newContent,
          toolName: DIFF_HARNESS_CHANGE.toolName,
        });
      }
    } else {
      useProposedChangesStore.setState({
        changes: deferDiff || gitConflict ? [] : [DIFF_HARNESS_CHANGE],
      });
    }

    return () => {
      useDocumentStore.setState({
        agentWorkspaceSessionId: null,
        agentWorkspaceRoot: null,
        isAgentWorkspaceReadOnly: false,
        sourceViewSnapshot: null,
      });
      if (agentDraftMode) {
        useProposedChangesStore.setState({
          changes: [],
          activeProjectRoot: null,
          changesByProject: {},
          workspaceReview: null,
          workspaceReviewsByProject: {},
        });
      } else if (persistentReviewMode) {
        useProposedChangesStore.getState().activateProject(null);
      } else {
        useProposedChangesStore.setState({ changes: [] });
      }
    };
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

      window.__editorDiffHarness = {
        ready: true,
        prepareLongPrefixDocument: () => {
          const view = getView();
          if (!view) return false;
          setDebugInlineCommentsByFile(createLongPrefixInlineComments());
          useDocumentStore
            .getState()
            .updateFileContent("main.tex", NEW_LONG_PREFIX_MAIN_TEX);
          view.dispatch({
            changes: {
              from: 0,
              to: view.state.doc.length,
              insert: NEW_LONG_PREFIX_MAIN_TEX,
            },
            selection: { anchor: 0 },
          });
          useProposedChangesStore.setState({ changes: [] });
          return true;
        },
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
        setScrollTop: (scrollTop: number) => {
          const view = getView();
          if (!view) return false;
          view.scrollDOM.scrollTop = scrollTop;
          return true;
        },
        activateDiffWithStaleWholeDocumentSelection: () => {
          const view = getView();
          if (!view) return false;
          view.dispatch({
            selection: { anchor: 0, head: view.state.doc.length },
          });
          useDocumentStore
            .getState()
            .setSelectionRange({ start: 0, end: view.state.doc.length });
          useProposedChangesStore.setState({
            changes: [{ ...DIFF_HARNESS_CHANGE, timestamp: Date.now() }],
          });
          return true;
        },
        activateDiffWithLongUnchangedPrefix: () => {
          const view = getView();
          if (!view) return false;
          useDocumentStore
            .getState()
            .updateFileContent("main.tex", NEW_LONG_PREFIX_MAIN_TEX);
          view.dispatch({
            changes: {
              from: 0,
              to: view.state.doc.length,
              insert: NEW_LONG_PREFIX_MAIN_TEX,
            },
          });
          view.scrollDOM.scrollTop = 0;
          useProposedChangesStore.setState({
            changes: [
              { ...LONG_PREFIX_DIFF_HARNESS_CHANGE, timestamp: Date.now() },
            ],
          });
          return true;
        },
        leavePersistentReviewProject: () => {
          useProposedChangesStore.getState().activateProject(null);
          return useProposedChangesStore.getState().changes.length;
        },
        reopenPersistentReviewProject: () => {
          useProposedChangesStore.getState().activateProject("/tmp/harness");
          return useProposedChangesStore.getState().changes.length;
        },
        getState: () => {
          const view = getView();
          return {
            storeSelection: useDocumentStore.getState().selectionRange,
            cmSelection: view
              ? {
                  from: view.state.selection.main.from,
                  to: view.state.selection.main.to,
                  empty: view.state.selection.main.empty,
                }
              : null,
            proposedPanelVisible: !!document.querySelector(
              '[data-proposed-changes-panel="true"]',
            ),
            inlineCommentMarkCount: document.querySelectorAll(
              ".cm-inlineCommentMark",
            ).length,
            mergePreviewRefreshCount: mergePreviewRefreshCountRef.current,
            compileRequestContents: [
              ...(window.__editorDiffHarnessCompileContents ?? []),
            ],
          };
        },
        getFirstDiffViewportMetrics: () => {
          const editorRoot = document.querySelector(".cm-editor");
          const firstDiffLine = document.querySelector(
            ".cm-changedLine, .cm-insertedLine, .cm-deletedLine",
          );
          if (!(editorRoot instanceof HTMLElement)) return null;
          if (!(firstDiffLine instanceof HTMLElement)) return null;
          const editorRect = editorRoot.getBoundingClientRect();
          const diffRect = firstDiffLine.getBoundingClientRect();
          const editorCenterY = editorRect.top + editorRect.height / 2;
          const firstDiffCenterY = diffRect.top + diffRect.height / 2;
          return {
            editorCenterY,
            firstDiffCenterY,
            deltaFromCenter: Math.abs(firstDiffCenterY - editorCenterY),
          };
        },
      };
    };

    attach();
    return () => {
      cancelled = true;
      delete window.__editorDiffHarness;
      delete window.__editorDiffHarnessCompileContents;
      setDebugInlineCommentsByFile(undefined);
    };
  }, []);

  const showPdfPreview = new URLSearchParams(window.location.search).has(
    "withPdf",
  );
  const showChatDrawer = new URLSearchParams(window.location.search).has(
    "withChat",
  );

  return (
    <div className="flex min-h-screen items-start justify-center bg-background p-8 text-foreground">
      <div className={showPdfPreview ? "w-[1500px]" : "w-[980px]"}>
        <h1 className="mb-3 font-semibold text-sm">Editor Diff Harness</h1>
        <div className={showPdfPreview ? "grid grid-cols-2 gap-3" : undefined}>
          <div
            data-testid="editor-diff-harness-shell"
            className="relative h-[720px] overflow-hidden rounded-2xl border border-border/70 bg-card"
          >
            {persistentReviewReady && (
              <LatexEditor
                assistantMode="artisan"
                suppressToolbar
                debugInlineCommentsByFile={debugInlineCommentsByFile}
              />
            )}
            {showChatDrawer ? <AgentChatDrawer /> : null}
          </div>
          {showPdfPreview && (
            <div
              data-testid="editor-diff-pdf-shell"
              className="h-[720px] overflow-hidden rounded-2xl border border-border/70 bg-card"
            >
              <PdfPreview />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
