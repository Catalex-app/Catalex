import { CommentCloseDialog } from "@/components/comment-close-dialog";
import { toast } from "sonner";
import {
  minimapDemoName,
  minimapDemoSource,
  minimapDemoDiagnostics,
} from "./minimap-demo-fixture";
import { compileLatex } from "@/lib/latex-compiler";
import { useEffect, useRef, useState } from "react";
import { ThemeProvider, useTheme } from "next-themes";
import { WorkspaceLayout } from "@/components/workspace/workspace-layout";
import { Toaster } from "@/components/ui/sonner";
import { useDocumentStore } from "@/stores/document-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useProposedChangesStore } from "@/stores/proposed-changes-store";
import {
  useAgentChatStore,
  type AgentStreamMessage,
} from "@/stores/agent-chat-store";
import { ensureDesktopBrowserMocks } from "../desktop-browser-mocks";
import type { InlineCommentsByFile } from "@/components/workspace/editor/inline-comment-storage";
import { trackCommentSaving } from "@/components/workspace/editor/comment-save-state";
import { setCommentDraft } from "@/components/workspace/editor/comment-draft-history";
import { resetCommentPosition } from "@/components/workspace/editor/comment-document-model";
import { browserHarness } from "@/lib/desktop/bridge";
import { SolarModeEffect } from "@/components/settings/solar-mode-effect";
import { useCodexSetupStore } from "@/stores/codex-setup-store";

const chatStatusOptions = {
  ready: "Ready",
  checking: "Checking agent…",
  "not-installed": "Setup required",
  "not-authenticated": "Sign-in required",
  error: "Agent unavailable",
} as const;
type DemoChatStatus = keyof typeof chatStatusOptions;

const projectRoot = "/browser-demo/Comment Review";
const documents = {
  [minimapDemoName]: minimapDemoSource,
  "sample.tex": String.raw`\documentclass[12pt]{article}
\usepackage[margin=1in]{geometry}
\usepackage{amsmath,amssymb}
\usepackage{hyperref}

\title{Learning with Limited Data\\A Four-Page Demo Paper}
\author{Catalex Demo Project}
\date{September 2026}

\begin{document}
\maketitle

\begin{abstract}
Your abstract here. This demonstration paper explores how a small research team
can compare learning methods when labelled examples are scarce. It includes
prose, equations, a results table, and an evaluation checklist across four pages.
All experimental values are illustrative, provided for testing the writing
workspace rather than reporting scientific findings.
\end{abstract}

\section{Introduction}
Reliable evaluation is difficult when collecting labels is expensive. A model
may perform well on a small test set while failing on examples from another
source. The central question is therefore not simply which method produces the
highest score, but how confidently we can compare several plausible approaches.

This paper follows a deliberately simple workflow: define a baseline, hold the
evaluation protocol fixed, and repeat each experiment with multiple random
seeds. The document also provides a practical reading exercise. Try zooming
around a sentence, scrolling to another page, and then reducing the magnification.
The text beneath the pointer should remain a useful visual reference.

\subsection{Research questions}
We ask whether additional unlabelled examples improve accuracy, whether the
improvement persists across seeds, and how much computation the improvement
requires. These questions guide the methodology on page~\pageref{sec:method}
and the illustrative results on page~\pageref{sec:results}.

\newpage
\section{Related Work}
Small-data learning often combines supervised examples with prior structure.
Regularization discourages overly complex solutions, augmentation creates
plausible variations of existing examples, and semi-supervised learning uses
unlabelled observations to constrain predictions. Each approach introduces
assumptions that should be stated alongside the reported results.

Comparisons are most informative when methods share the same data split and
training budget. Changing the split, stopping criterion, or preprocessing can
make a small apparent improvement difficult to interpret. We therefore use a
common protocol throughout this example.

\section{Method}\label{sec:method}
Let the labelled dataset be $\mathcal{D}_L=\{(x_i,y_i)\}_{i=1}^{n}$ and the
unlabelled dataset be $\mathcal{D}_U=\{u_j\}_{j=1}^{m}$. Our illustrative
objective combines a supervised loss with a consistency term:
\begin{equation}
\mathcal{L}(\theta)=\frac{1}{n}\sum_{i=1}^{n}
\ell(f_\theta(x_i),y_i)+\lambda\frac{1}{m}\sum_{j=1}^{m}
\left\|f_\theta(u_j)-f_\theta(a(u_j))\right\|_2^2.
\end{equation}
Here $a(\cdot)$ is a label-preserving transformation and $\lambda$ controls the
strength of the consistency constraint. Setting $\lambda=0$ recovers the
supervised baseline.

\subsection{Training procedure}
\begin{enumerate}
\item Fix the training, validation, and test partitions before fitting models.
\item Select hyperparameters using only the validation partition.
\item Train each configuration with five independent random seeds.
\item Report all runs, including unsuccessful or unstable configurations.
\end{enumerate}

\subsection{Reproducibility}
Record the preprocessing rules, software versions, and random seeds together
with each run. A compact experiment log helps distinguish genuine method
changes from accidental differences in the evaluation setup.

\newpage
\section{Results}\label{sec:results}
Table~\ref{tab:results} presents invented measurements for three configurations.
The table is intentionally small enough to inspect at several zoom levels.
Accuracy is averaged over five runs; the spread indicates variation between
runs rather than a guarantee about future performance.

\begin{table}[ht]
\centering
\caption{Illustrative results only; these are not real experimental findings.}
\label{tab:results}
\begin{tabular}{lrrr}
\hline
Configuration & Accuracy (\%) & Std. dev. & Time (min) \\
\hline
Supervised baseline & 76.8 & 1.4 & 12 \\
With augmentation & 79.1 & 1.1 & 15 \\
With consistency & 81.0 & 1.0 & 21 \\
\hline
\end{tabular}
\end{table}

\subsection{Reading the comparison}
The consistency configuration has the highest mean score in this example,
but it also takes longer to train. A deployment decision would need to weigh
that cost against the value of the improvement. The augmentation configuration
may be attractive when compute resources are limited.

A useful summary is the mean score across $K$ runs and its sample standard
deviation:
\begin{align}
\bar{s} &= \frac{1}{K}\sum_{k=1}^{K}s_k, \\
s_{\mathrm{std}} &= \sqrt{\frac{1}{K-1}\sum_{k=1}^{K}(s_k-\bar{s})^2}.
\end{align}
These summaries should be accompanied by individual measurements whenever
possible. Two methods can have similar means and very different failure modes.

\subsection{Error analysis}
Inspect examples on which the methods disagree. Group errors by their source,
input length, or annotation ambiguity, and look for patterns that are hidden
by a single aggregate score. An improvement concentrated in one narrow group
may not transfer to the intended application.

\newpage
\section{Discussion}
This example emphasizes the connection between a clear research question and a
repeatable evaluation protocol. More elaborate methods are not automatically
more useful: their additional assumptions and computational costs should be
justified by evidence collected under comparable conditions.

\subsection{Limitations}
The document uses invented data and does not establish the effectiveness of any
learning method. A real study would need a larger evaluation set, a documented
sampling strategy, and checks for distribution shift. It would also distinguish
variation across training runs from uncertainty due to the choice of test data.

\subsection{Evaluation checklist}
\begin{itemize}
\item Keep the test partition separate from model selection.
\item Report training cost alongside predictive performance.
\item Preserve unsuccessful runs in the experiment record.
\item Review representative errors rather than only aggregate metrics.
\item State where the conclusions are expected to apply.
\end{itemize}

\section{Conclusion}
A small, well-documented experiment can provide a useful starting point for
further research. The essential ingredients are a meaningful baseline, a fixed
comparison protocol, and an honest account of uncertainty and limitations.

For this demo, the four-page layout is also a workspace exercise. Use the
outline to navigate between sections, compare the source with the PDF, and try
pinching near the top, middle, and bottom of different pages. Equations and
small table entries provide convenient targets for checking zoom clarity.

\subsection*{Next steps}
Replace the illustrative measurements with real results, expand the related
work, and attach an experiment log. The same project can then grow without
changing the basic structure of the writing workflow.

\end{document}
`,
  "manuscript.md": `# Learning with limited data

## Introduction

Small datasets make reliable evaluation difficult. We compare three training strategies under a shared evaluation protocol.

The baseline uses the standard configuration. Each experiment is repeated five times with different random seeds.

## Results

The proposed method improves accuracy by 4.2 percentage points. Confidence intervals are reported in Table 1.

All results are statistically significant.

## Discussion

Our approach generalizes to every application domain.

Further experiments will examine performance under distribution shift.
`,
  "review-notes.md": `# Review notes

The acronym SSL stands for semi-supervised learning.

The evaluation uses five random seeds and reports the mean and standard deviation.

This paragraph repeats the experimental setup described in the manuscript.
`,
};

function initializeDemo() {
  const comments: InlineCommentsByFile = {};
  const add = (
    filePath: keyof typeof documents,
    passage: string,
    text: string,
    agentAuthored = false,
  ) => {
    const source = documents[filePath];
    const from = source.indexOf(passage);
    const number = Object.values(comments).flat().length + 1;
    (comments[filePath] ??= []).push({
      id: `${agentAuthored ? "A" : "H"}-${number}`,
      ...(agentAuthored
        ? {
            origin: {
              provider: "codex",
              sessionId: "demo-review-chat",
              model: "Demo agent",
            },
          }
        : {}),
      number,
      from,
      to: from + passage.length,
      line: source.slice(0, from).split("\n").length,
      text,

      resolved: false,
    });
  };
  add(
    "manuscript.md",
    "The baseline uses the standard configuration.",
    "Please clarify the baseline.",
  );
  add(
    "manuscript.md",
    "Confidence intervals are reported in Table 1.",
    "Please report confidence intervals.",
  );
  add(
    "manuscript.md",
    "Each experiment is repeated five times",
    "Please state the number of random seeds.",
  );
  add(
    "manuscript.md",
    "Our approach generalizes to every application domain.",
    "This claim seems too broad.",
  );
  add(
    "review-notes.md",
    "The acronym SSL stands for semi-supervised learning.",
    "Define SSL on first use.",
  );
  add(
    "review-notes.md",
    "This paragraph repeats the experimental setup",
    "Duplicate review note.",
  );
  add(
    "manuscript.md",
    "Small datasets make reliable evaluation difficult.",
    "Explain the evaluation challenge.",
    true,
  );
  if (new URLSearchParams(window.location.search).has("unplaced")) {
    for (const comment of comments["manuscript.md"].filter(
      (c) => c.id === "A-7" || c.id === "H-3",
    ))
      Object.assign(
        comment,
        resetCommentPosition(comment, documents["manuscript.md"]),
      );
  }
  add(
    "sample.tex",
    "Your abstract here.",
    "Describe the problem and main finding.",
  );
  add(
    "sample.tex",
    "Introduction",
    "Add the motivation and contributions.",
    true,
  );
  // Extra review states for interactive UI work; existing test fixtures stay stable.
  if (new URLSearchParams(window.location.search).has("ui-demo")) {
    add(
      "sample.tex",
      "five independent random seeds",
      "Include the individual runs alongside the averages.",
      true,
    );
    add(
      "sample.tex",
      "Illustrative results only",
      "The caption clearly distinguishes demonstration data from findings.",
      true,
    );
    const paperComments = comments["sample.tex"];
    paperComments[paperComments.length - 1].resolved = true;
    add(
      "sample.tex",
      "Reliable evaluation",
      "Point comment: drag the marker in either direction to select text.",
    );
    const point = paperComments[paperComments.length - 1];
    point.to = point.from;
  }
  add(minimapDemoName, "Separated human comment", "A separated human comment.");
  add(
    minimapDemoName,
    "Separated agent comment",
    "A separated agent comment.",
    true,
  );
  add(
    minimapDemoName,
    "Mixed group:",
    "This line also has a Git change and a LaTeX error.",
  );
  add(
    minimapDemoName,
    "Nearby agent comment",
    "This nearby comment should join the mixed marker.",
    true,
  );
  const disconnected: InlineCommentsByFile = {};
  if (new URLSearchParams(window.location.search).has("disconnected")) {
    disconnected["old-manuscript.md"] = comments["manuscript.md"];
    delete comments["manuscript.md"];
  }
  localStorage.setItem(
    `catalex-harness-disconnected:${projectRoot}`,
    JSON.stringify(disconnected),
  );
  localStorage.setItem(
    `catalex-harness-comments:${projectRoot}`,
    JSON.stringify(comments),
  );
  if (new URLSearchParams(window.location.search).get("saving") === "edit") {
    const comment = comments["manuscript.md"][0];
    setCommentDraft(
      { root: projectRoot, filePath: "manuscript.md" },
      comment.id,
      {
        comment,
        text: "Please clarify the baseline and its settings.",
      },
    );
  }
  useSettingsStore.setState({
    editorCommentsPanelOpenByProject: { [JSON.stringify(projectRoot)]: true },
    editorCommentFilterByProject: { [JSON.stringify(projectRoot)]: "all" },
  });
  useDocumentStore.setState({
    projectRoot,
    files: Object.entries(documents).map(([name, content]) => ({
      id: name,
      name,
      relativePath: name,
      absolutePath: `${projectRoot}/${name}`,
      type: name.endsWith(".tex") ? ("tex" as const) : ("other" as const),
      content,
      isDirty: false,
    })),
    folders: [],
    activeFileId: new URLSearchParams(window.location.search).has("pdf")
      ? "sample.tex"
      : "manuscript.md",
    openFileIds: [
      new URLSearchParams(window.location.search).has("pdf")
        ? "sample.tex"
        : "manuscript.md",
    ],
    initialized: true,
    selectionRange: null,
    cursorPosition: 0,
    jumpToPosition: null,
  });
  useDocumentStore
    .getState()
    .setCompileError(
      "Intentional minimap demo diagnostics",
      minimapDemoName,
      minimapDemoDiagnostics,
    );
  if (new URLSearchParams(window.location.search).has("markers")) {
    useDocumentStore.getState().setActiveFile(minimapDemoName);
  }
  if (new URLSearchParams(window.location.search).has("proposal")) {
    const oldContent = documents["sample.tex"];
    useProposedChangesStore.setState({
      changes: [
        {
          id: "demo-agent-proposal",
          filePath: "sample.tex",
          absolutePath: `${projectRoot}/sample.tex`,
          oldContent,
          newContent: oldContent
            .replace(
              "Your abstract here. This demonstration paper explores",
              "This paper studies reliable evaluation with limited labels and explores",
            )
            .replace(
              "\\subsection{Research questions}",
              "\\subsection{Research questions}\nWe report uncertainty across repeated runs rather than relying on a single score.\n",
            )
            .replace(
              "The text beneath the pointer should remain a useful visual reference.\n",
              "",
            ),
          toolName: "Edit",
          timestamp: Date.now(),
        },
      ],
    });
  }
  if (!new URLSearchParams(window.location.search).has("proposal")) {
    useProposedChangesStore.setState({ changes: [] });
  }
  if (new URLSearchParams(window.location.search).has("merge")) {
    useDocumentStore.getState().setActiveFile("sample.tex");
  }
  const messages: AgentStreamMessage[] = [
    {
      type: "user",
      provider: "codex",
      model: "gpt-6.1-sol",
      reasoningEffort: "high",
      message: {
        content: [
          {
            type: "text",
            text: "Review the existing comments and update them where appropriate. Tell me what you plan to change first.",
          },
        ],
      },
    },
    {
      type: "assistant",
      provider: "codex",
      message: {
        content: [
          {
            type: "text",
            text: "Comments apply directly. Edit or resolve a comment, then use Undo in the source editor to restore it. This project is only a browser demo.",
          },
        ],
      },
    },
  ];
  useAgentChatStore.setState((state) => {
    const tab = {
      ...state.tabs[0],
      id: "demo-review",
      runtimeSessionKey: "demo-review-chat",
      title: "Review manuscript comments",
      provider: "codex" as const,
      messages,
      isStreaming: false,
      error: null,
      selectedCodexExecutionMode: "default" as const,
    };
    return {
      chatProjectRoot: projectRoot,
      tabs: [tab],
      activeTabId: tab.id,
      messages,
      selectedProvider: "codex",
      selectedCodexExecutionMode: "default",
      isStreaming: false,
      error: null,
    };
  });
}

function DemoWorkspace() {
  const [ready, setReady] = useState(false);
  const [chatStatus, setChatStatus] = useState<DemoChatStatus | "">(() => {
    const value = new URLSearchParams(window.location.search).get(
      "chat-status",
    );
    return value && Object.keys(chatStatusOptions).includes(value)
      ? (value as DemoChatStatus)
      : "";
  });
  useEffect(() => {
    if (!ready || !chatStatus) return;
    // Hold a simulated status in this browser-only demo, without probing an agent.
    const checkStatus = useCodexSetupStore.getState().checkStatus;
    useCodexSetupStore.setState({
      status: chatStatus,
      checkStatus: async () => {},
    });
    useAgentChatStore.setState((state) => ({
      selectedProvider: "codex",
      messages: [],
      tabs: state.tabs.map((tab) =>
        tab.id === state.activeTabId
          ? {
              ...tab,
              title: "New Chat",
              messages: [],
              history: undefined,
              lastCommunication: undefined,
              lastCommunicationProvider: undefined,
            }
          : tab,
      ),
    }));
    return () => useCodexSetupStore.setState({ checkStatus });
  }, [ready, chatStatus]);
  const editSaveDemo =
    new URLSearchParams(window.location.search).get("saving") === "edit";
  const releaseCommentSave = useRef<(() => void) | null>(null);
  const [holdingCommentSave, setHoldingCommentSave] = useState(false);
  useEffect(() => {
    if (!ready || !editSaveDemo) return;
    const harness = browserHarness();
    if (!harness) return;
    const original = harness.invoke;
    const invoke: typeof original = async (command, args, options) => {
      const patch = (
        args as
          | {
              patch?: {
                id: string;
                before?: { text: string };
                after?: { text: string };
              };
            }
          | undefined
      )?.patch;
      if (
        command.startsWith("update_project_comment") &&
        patch?.id === "H-1" &&
        patch.after &&
        patch.before?.text !== patch.after.text
      ) {
        setHoldingCommentSave(true);
        await new Promise<void>((resolve) => {
          releaseCommentSave.current = resolve;
        });
        releaseCommentSave.current = null;
        setHoldingCommentSave(false);
      }
      return original(command, args, options);
    };
    harness.invoke = invoke;
    return () => {
      if (harness.invoke === invoke) harness.invoke = original;
      releaseCommentSave.current?.();
    };
  }, [ready, editSaveDemo]);
  const [savingCommentPreview, setSavingCommentPreview] = useState(
    () => new URLSearchParams(window.location.search).get("saving") === "card",
  );
  useEffect(() => {
    if (!ready) return;
    // Hold the real card's transient UI state for visual inspection only.
    // This dummy project does not perform a native database write.
    const setSaving = trackCommentSaving(projectRoot, "H-1");
    setSaving(savingCommentPreview);
    return () => setSaving(false);
  }, [ready, savingCommentPreview]);
  const [savePreview, setSavePreview] = useState<"slow" | "failed" | null>(
    () => {
      const value = new URLSearchParams(window.location.search).get("saving");
      return value === "slow" || value === "failed" ? value : null;
    },
  );
  const { resolvedTheme, setTheme } = useTheme();
  useEffect(() => {
    ensureDesktopBrowserMocks();
    initializeDemo();
    if (new URLSearchParams(window.location.search).has("chat-status"))
      useSettingsStore.getState().setWorkspacePreferences(projectRoot, {
        mode: "duet",
        chatLayout: "workspace",
      });
    if (new URLSearchParams(window.location.search).has("markers")) {
      setReady(true);
      return;
    }
    let cancelled = false;
    void compileLatex(projectRoot, "sample.tex")
      .then(({ pdfData }) => {
        if (!cancelled)
          useDocumentStore.getState().setPdfData(pdfData, "sample.tex");
      })
      .catch((error) => {
        if (!cancelled)
          useDocumentStore.setState({ compileError: String(error) });
      });
    setReady(true);
    return () => {
      cancelled = true;
    };
  }, []);
  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <div className="flex shrink-0 flex-wrap items-center gap-3 border-border border-b bg-muted/40 px-3 py-1 text-xs">
        <span className="font-medium">Browser demo · Comment Review</span>
        <span className="flex-1 text-muted-foreground">
          Dummy project · Temporary local LaTeX compilation · No live agent ·
          Reload to reset
        </span>
        <select
          aria-label="Preview chat status"
          className="rounded border border-border bg-background px-2 py-1"
          value={chatStatus}
          onChange={(event) => {
            useSettingsStore.getState().setWorkspacePreferences(projectRoot, {
              mode: "duet",
              chatLayout: "workspace",
            });
            setChatStatus(event.target.value as DemoChatStatus);
          }}
        >
          <option value="" disabled>
            Preview chat status
          </option>
          {Object.entries(chatStatusOptions).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="rounded border border-border px-2 py-1 hover:bg-muted"
          disabled={editSaveDemo && !holdingCommentSave}
          onClick={() => {
            if (editSaveDemo) releaseCommentSave.current?.();
            else setSavingCommentPreview((value) => !value);
          }}
        >
          {savingCommentPreview || editSaveDemo
            ? "Finish comment save"
            : "Preview saving comment"}
        </button>
        <button
          type="button"
          className="rounded border border-border px-2 py-1 hover:bg-muted"
          onClick={() => setSavePreview("slow")}
        >
          Slow save pop-up
        </button>
        <button
          type="button"
          className="rounded border border-border px-2 py-1 hover:bg-muted"
          onClick={() => setSavePreview("failed")}
        >
          Failed save pop-up
        </button>
        <button
          type="button"
          className="rounded px-2 py-1 hover:bg-muted"
          onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
        >
          Toggle theme
        </button>
        <button
          type="button"
          className="rounded border border-border px-2 py-1 hover:bg-muted"
          onClick={() => window.location.reload()}
        >
          Reset demo
        </button>
      </div>
      <div className="min-h-0 flex-1">
        {ready && (
          <WorkspaceLayout key={chatStatus ? "chat-status" : "default"} />
        )}
      </div>
      <CommentCloseDialog
        files={["manuscript.md", "review-notes.md"]}
        open={savePreview !== null}
        waiting={savePreview === "slow"}
        busy={false}
        onCancel={() => setSavePreview(null)}
        onDiscard={() => {
          setSavePreview(null);
          toast("Demo: the app would close without waiting for comments.");
        }}
        onRetry={() => {
          const waiting = savePreview === "slow";
          setSavePreview(null);
          toast(
            waiting
              ? "Demo: continue waiting for the existing save."
              : "Demo: retry saving, then close on success.",
          );
        }}
      />
      <Toaster />
    </div>
  );
}

export function CommentWorkspaceDemo() {
  // This fixture must never attach to the real desktop bridge.
  if (window.catalex)
    return <p>Open this demo in a browser, outside the desktop app.</p>;
  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="light"
      enableSystem
      storageKey="catalex-comment-demo-theme"
    >
      <SolarModeEffect />
      <DemoWorkspace />
    </ThemeProvider>
  );
}
