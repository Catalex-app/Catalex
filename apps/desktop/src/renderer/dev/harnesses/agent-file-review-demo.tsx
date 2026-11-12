import acceptanceMarkdownSource from "../fixtures/acceptance-review/source.md?raw";
import acceptanceMarkdownDraft from "../fixtures/acceptance-review/draft.md?raw";
import acceptanceLatexSource from "../fixtures/acceptance-review/source.tex?raw";
import acceptanceLatexDraft from "../fixtures/acceptance-review/draft.tex?raw";
import { ComposerErrorPreviewContext } from "@/components/agent-chat/composer-error-preview-context";
import { ChatErrorInputPreview } from "./chat-error-input-preview";
import compileSource from "../fixtures/compile-review/source/main.tex?raw";
import compileDraft from "../fixtures/compile-review/draft/main.tex?raw";
import { compileLatex, formatCompileError } from "@/lib/latex-compiler";
import { ChatErrorOptions, type ErrorOption } from "./chat-error-options";
import { useAgentEvents } from "@/hooks/use-agent-events";
import { emit } from "@/lib/desktop/event";
import { useEffect, useState } from "react";
import { ThemeProvider } from "next-themes";
import { WorkspaceLayout } from "@/components/workspace/workspace-layout";
import { Toaster } from "@/components/ui/sonner";
import { browserHarness } from "@/lib/desktop/bridge";
import {
  type AgentWorkspaceChange,
  type AgentWorkspaceDecision,
  type AgentWorkspaceSession,
} from "@/lib/agent-workspace";
import { useDocumentStore } from "@/stores/document-store";
import { useAgentChatStore } from "@/stores/agent-chat-store";
import { useAgentReviewQueueStore } from "@/stores/agent-review-queue-store";
import { useProposedChangesStore } from "@/stores/proposed-changes-store";
import { useCodexSetupStore } from "@/stores/codex-setup-store";
import { useClaudeSetupStore } from "@/stores/claude-setup-store";
import { useHistoryStore } from "@/stores/history-store";
import { ensureDesktopBrowserMocks } from "../desktop-browser-mocks";

const acceptanceDemo = new URLSearchParams(location.search).has(
  "acceptanceDemo",
);
const root = acceptanceDemo
  ? "/browser-demo/Riverside Study"
  : "/browser-demo/Figure Review";
const candidate = "/browser-demo/draft";
const queueDemo = new URLSearchParams(location.search).has("queueDemo");
const session: AgentWorkspaceSession = {
  version: 2,
  sessionId: "figure-review",
  tabId: "figure-chat",
  projectRoot: root,
  mode: "ask",
  status: "review",
  createdAt: 1,
  updatedAt: 1,
  sourceCommit: "fixture-source",
  baselineCommit: "fixture-baseline",
  candidateRoot: candidate,
  warnings: [],
};
function figure(title: string, color: string, bars: number[]) {
  const canvas = document.createElement("canvas");
  canvas.width = 760;
  canvas.height = 480;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#f8fafc";
  ctx.fillRect(0, 0, 760, 480);
  ctx.fillStyle = "#0f172a";
  ctx.font = "bold 28px sans-serif";
  ctx.fillText(title, 42, 56);
  ctx.font = "16px sans-serif";
  ctx.fillStyle = "#64748b";
  ctx.fillText("Accuracy by evaluation group", 42, 88);
  bars.forEach((height, index) => {
    ctx.fillStyle = color;
    ctx.fillRect(100 + index * 180, 380 - height, 105, height);
    ctx.fillStyle = "#334155";
    ctx.font = "18px sans-serif";
    ctx.fillText(`${Math.round(height / 3)}%`, 128 + index * 180, 365 - height);
    ctx.fillText(
      ["Baseline", "Structured", "Combined"][index],
      100 + index * 180,
      412,
    );
  });
  ctx.strokeStyle = "#94a3b8";
  ctx.beginPath();
  ctx.moveTo(60, 380);
  ctx.lineTo(700, 380);
  ctx.stroke();
  return Uint8Array.from(
    atob(canvas.toDataURL("image/png").split(",")[1]),
    (c) => c.charCodeAt(0),
  );
}

function showDemoError(
  kind:
    | "connection"
    | "compile"
    | "repair"
    | "logged-out"
    | "busy" = "connection",
) {
  const chat = useAgentChatStore.getState();
  chat._setError(
    session.tabId,
    kind === "busy"
      ? "Cannot resume this session: another process is writing to it."
      : kind === "logged-out"
        ? "Authentication required. You are not signed in to the agent provider. Sign in, then refresh to continue."
        : kind === "repair"
          ? "The revision could not be completed because a referenced file is missing. The agent is available to investigate."
          : kind === "compile"
            ? "The agent draft did not compile. The source project was not changed; the draft is available for review. LaTeX error: Undefined control sequence (\\figref)."
            : "Could not start refinement. Your draft and message are preserved. The agent connection was interrupted. Please try again.",
  );
  chat.requestDrawerOpen();
}

async function initialize() {
  ensureDesktopBrowserMocks();
  const bridge = browserHarness()!;
  const original = bridge.invoke;
  const oldText = acceptanceDemo
    ? acceptanceMarkdownSource
    : `# Figure review

Our initial experiment compares two methods.

## Research question

We study whether a compact retrieval model can improve document search.
The evaluation uses the same query collection for every method.
All runs share a fixed training budget and identical preprocessing.
We report both retrieval quality and runtime.
The sections below describe the protocol and its limitations.

## Experimental setup

We evaluate a single random seed on a held-out collection of 200 queries.

### Reproducibility checklist

- Keep the training and evaluation collections separate.
- Record the configuration alongside each run.
- Store raw predictions before computing aggregate metrics.
- Use the same machine for timing measurements.
- Document any excluded queries in the appendix.

## Main results

The original figure reports preliminary results.

### Reading the figure

The horizontal axis identifies the method being evaluated.
The vertical axis reports retrieval quality on the held-out queries.
Each method uses the same candidate document collection.
The figure is intended to complement the numerical results.
Exact metric definitions are listed in the evaluation appendix.

## Ablation study

We have not yet tested the contribution of the reranking stage.

### Controlled comparisons

Each ablation changes only one component of the pipeline.
The training split remains fixed across all comparisons.
The tokenizer and candidate pool are shared by every variant.
We retain the original configuration as a reference run.
This helps separate architectural changes from evaluation differences.

## Limitations

The method should generalize to all document collections.

### Scope of the evidence

The current collection contains short English research abstracts.
Long documents may require a different chunking strategy.
Multilingual retrieval is outside the current evaluation scope.
Runtime measurements depend on hardware and batch size.
Follow-up experiments should test these assumptions explicitly.

## Next steps

Publish the current figure and close the experiment.

### Release checklist

- Archive the configurations and raw outputs.
- Verify that figure labels match the manuscript terminology.
- Include the evaluation script with the supplementary material.
- Check that every reported value has a corresponding run log.
- Ask a second reviewer to reproduce the summary metrics.
`;
  const newText = acceptanceDemo
    ? acceptanceMarkdownDraft
    : new URLSearchParams(location.search).has("singleBlock")
      ? oldText.replace(
          "We evaluate a single random seed on a held-out collection of 200 queries.",
          "We evaluate five random seeds on a held-out collection of 1,000 queries.",
        )
      : oldText
          .replace(
            "Our initial experiment compares two methods.",
            "Our revised experiment compares three methods across five random seeds.",
          )
          .replace(
            "We evaluate a single random seed on a held-out collection of 200 queries.",
            "We evaluate five random seeds on a held-out collection of 1,000 queries and report the mean with a 95% confidence interval.",
          )
          .replace(
            "The original figure reports preliminary results.",
            "The updated figure reports final results. The proposed model improves retrieval quality by 8% relative to the baseline while keeping median latency below 50 ms.",
          )
          .replace(
            "We have not yet tested the contribution of the reranking stage.",
            "Removing the reranking stage reduces retrieval quality by 3 percentage points. The new ablation figure compares the full model with this reduced variant.",
          )
          .replace(
            "The method should generalize to all document collections.",
            "These results support the method only on the evaluated collection. Generalization to longer documents and other languages remains untested.",
          )
          .replace(
            "Publish the current figure and close the experiment.",
            "Validate the confidence intervals, reproduce the ablation, and review both figures before publishing the manuscript.",
          );
  const disk = new Map<string, Uint8Array>([
    [
      `${root}/results.png`,
      figure("Original · Preliminary results", "#94a3b8", [150, 180, 195]),
    ],
    [
      `${candidate}/results.png`,
      figure("Proposed · Final results", "#8b5cf6", [174, 228, 270]),
    ],
    [
      `${candidate}/new-figure.png`,
      figure("New figure · Ablation study", "#0d9488", [138, 201, 258]),
    ],
    [`${root}/manuscript.md`, new TextEncoder().encode(oldText)],
    [`${candidate}/manuscript.md`, new TextEncoder().encode(newText)],
  ]);
  const compileCase = new URLSearchParams(location.search).has("compileCase");
  const changes: AgentWorkspaceChange[] = [
    "new-figure.png",
    "results.png",
    "manuscript.md",
  ].map((path, i) => ({
    id: `figure-change-${i}`,
    kind: i === 0 ? "added" : "modified",
    filePath: path,
    oldFilePath: i === 0 ? null : path,
    newFilePath: path,
    sourceAbsolutePath: `${root}/${path}`,
    candidateAbsolutePath: `${candidate}/${path}`,
    oldContent: i === 2 ? oldText : null,
    newContent: i === 2 ? newText : null,
    binary: i !== 2,
    sourceChanged: false,
  }));
  const latexSource = acceptanceDemo ? acceptanceLatexSource : compileSource;
  const latexDraft = acceptanceDemo ? acceptanceLatexDraft : compileDraft;
  if (compileCase || acceptanceDemo) {
    disk.set(`${root}/main.tex`, new TextEncoder().encode(latexSource));
    disk.set(`${candidate}/main.tex`, new TextEncoder().encode(latexDraft));
    changes.push({
      id: "compile-change",
      kind: "modified",
      filePath: "main.tex",
      oldFilePath: "main.tex",
      newFilePath: "main.tex",
      sourceAbsolutePath: `${root}/main.tex`,
      candidateAbsolutePath: `${candidate}/main.tex`,
      oldContent: latexSource,
      newContent: latexDraft,
      binary: false,
      sourceChanged: false,
    });
  }
  if (new URLSearchParams(location.search).has("extras")) {
    disk.set(
      `${root}/removed.png`,
      figure("Retired figure", "#f59e0b", [120, 135, 150]),
    );
    disk.set(
      `${candidate}/archive.zip`,
      new Uint8Array([80, 75, 3, 4, 0, 255]),
    );
    changes.push(
      {
        id: "deleted",
        kind: "deleted",
        filePath: "removed.png",
        oldFilePath: "removed.png",
        newFilePath: null,
        sourceAbsolutePath: `${root}/removed.png`,
        candidateAbsolutePath: null,
        oldContent: null,
        newContent: null,
        binary: true,
        sourceChanged: false,
      },
      {
        id: "archive",
        kind: "added",
        filePath: "archive.zip",
        oldFilePath: null,
        newFilePath: "archive.zip",
        sourceAbsolutePath: `${root}/archive.zip`,
        candidateAbsolutePath: `${candidate}/archive.zip`,
        oldContent: null,
        newContent: null,
        binary: true,
        sourceChanged: false,
      },
    );
  }
  let round = 0;
  const submittedPrompts: string[] = [];
  let revision = 1;
  const currentChanges = () =>
    changes.map((change) => {
      const bytes = change.candidateAbsolutePath
        ? disk.get(change.candidateAbsolutePath)
        : undefined;
      return {
        ...change,
        newContent:
          !change.binary && bytes ? new TextDecoder().decode(bytes) : null,
        proposalRevision: bytes ? Array.from(bytes).join(",") : "deleted",
      };
    });
  const urls = new Map<string, string>();
  bridge.convertFileSrc = (path) => {
    const bytes = disk.get(path);
    if (!bytes) return "";
    if (!urls.has(path))
      urls.set(
        path,
        URL.createObjectURL(
          new Blob([new Uint8Array(bytes)], { type: "image/png" }),
        ),
      );
    return urls.get(path)!;
  };
  let acceptanceSourceMap: unknown = null;
  bridge.invoke = async (command, raw, options) => {
    if (
      new URLSearchParams(location.search).get("error") === "claude-auth" &&
      (command === "dispose_claude_session" ||
        command === "verify_claude_model")
    ) {
      await new Promise((resolve) => setTimeout(resolve, 600));
      return null;
    }
    if (command === "check_codex_status" || command === "check_claude_status")
      return {
        installed: true,
        authenticated: true,
        missing_git: false,
        binary_path: "/demo/agent",
        version: "demo",
        account_label: "Demo",
        account_email: "demo@example.test",
      };
    const args = (raw ?? {}) as Record<string, unknown>;
    const path = String(args.path ?? "");
    if (command === "demo_queue_finish") {
      await emit("codex-complete", { tab_id: session.tabId, success: true });
      return;
    }
    // Model the initial manuscript as the last committed version. Keep this
    // baseline fixed while proposal decisions and refinement change the draft.
    if (
      command === "git_head_file_content" &&
      args.filePath === "manuscript.md"
    )
      return { repo_found: true, head_content: oldText, ignored: false };
    if (acceptanceDemo && command === "get_synctex_source_map")
      return acceptanceSourceMap;
    if (acceptanceDemo && command === "compile_latex") {
      const source = new TextDecoder().decode(
        disk.get(`${args.projectDir}/main.tex`),
      );
      const response = await fetch("/__demo/compile", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Catalex-Demo": "comment-workspace",
        },
        body: JSON.stringify({ source, engine: "pdflatex", file: "main.tex" }),
      });
      if (!response.ok) throw new Error(await response.text());
      const result = await response.json();
      acceptanceSourceMap = result.sourceMap;
      (
        args.diagnostics as { onmessage?: (data: unknown[]) => void }
      )?.onmessage?.([]);
      return Uint8Array.from(atob(result.pdf), (char) => char.charCodeAt(0))
        .buffer;
    }
    if (compileCase && command === "compile_latex") {
      const content = new TextDecoder().decode(
        disk.get(`${candidate}/main.tex`),
      );
      const response = await fetch("http://127.0.0.1:4175/compile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
      const result = await response.json();
      (
        args.diagnostics as { onmessage?: (data: unknown[]) => void }
      )?.onmessage?.(result.error?.diagnostics ?? []);
      if (result.error) throw result.error;
      return result.result;
    }
    if (
      compileCase &&
      (command === "demo_compile_tool" || command === "demo_compile_finish")
    ) {
      const chat = useAgentChatStore.getState();
      if (!chat.isStreaming) {
        const resumed = await useAgentReviewQueueStore
          .getState()
          .beginRefinement(session.sessionId);
        chat._setAgentWorkspace(session.tabId, resumed.session);
        chat._setStreaming(session.tabId, true);
        useAgentChatStore.setState((state) => ({
          tabs: state.tabs.map((tab) =>
            tab.id === session.tabId
              ? {
                  ...tab,
                  provider: "codex",
                  agentVerificationContext: {
                    rootId: "main.tex",
                    targetPath: "main.tex",
                    backend: "latexmk",
                    engine: "pdflatex",
                  },
                }
              : tab,
          ),
        }));
      }
      if (command === "demo_compile_finish") {
        chat._appendMessage(session.tabId, {
          type: "assistant",
          message: {
            content: [
              {
                type: "text",
                text: "The wording is updated. Compilation failed because results-summary.tex is missing.",
              },
            ],
          },
        });
        await emit("codex-complete", { tab_id: session.tabId, success: true });
        return;
      }
      const toolId = `compile-demo-${Date.now()}`;
      chat._appendMessage(session.tabId, {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: toolId,
              name: "compile_latex",
              input: { file: "main.tex" },
            },
          ],
        },
      });
      await emit("catalex-verification-compile", {
        tab_id: session.tabId,
        project_path: candidate,
        root_id: "main.tex",
        status: "started",
      });
      try {
        await compileLatex(candidate, "main.tex", "latexmk", "pdflatex");
        chat._appendMessage(session.tabId, {
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: toolId,
                content: "Compilation succeeded.",
              },
            ],
          },
        });
      } catch (error) {
        const message = formatCompileError(error);
        chat._appendMessage(session.tabId, {
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: toolId,
                content: message,
                is_error: true,
              },
            ],
          },
        });
        await emit("catalex-verification-compile", {
          tab_id: session.tabId,
          project_path: candidate,
          root_id: "main.tex",
          status: "failed",
          error: message,
          diagnostics:
            (error as { diagnostics?: unknown[] })?.diagnostics ?? [],
        });
      }
      chat.requestDrawerOpen();
      return;
    }
    if (command === "plugin:path|join")
      return (args.paths as string[]).join("/").replace(/\/+/g, "/");
    if (command === "demo_edit") {
      const doc = useDocumentStore.getState();
      const file = doc.files.find(
        (file) => file.relativePath === "manuscript.md",
      )!;
      doc.updateFileContent(
        file.id,
        `${file.content}\nUser-authored sentence to preserve.\n`,
      );
      return;
    }
    if (command === "demo_state") {
      const queue = useAgentReviewQueueStore.getState();
      const doc = useDocumentStore.getState();
      return {
        submittedPrompts,
        phase: queue.entries[0]?.phase,
        count: queue.entries.length,
        id: queue.entries[0]?.session.sessionId,
        decisions:
          useProposedChangesStore.getState().workspaceReview?.decisions,
        readonly: doc.isAgentWorkspaceReadOnly,
        text: doc.files.find((file) => file.relativePath === "manuscript.md")
          ?.content,
      };
    }
    if (command === "plugin:fs|write_text_file") {
      const headers = (options as { headers?: Record<string, string> })
        ?.headers;
      const target = decodeURIComponent(headers?.path ?? path);
      disk.set(target, new Uint8Array(raw as Uint8Array));
      return;
    }
    if (command === "agent_workspace_source_changed") return false;
    if (command === "resume_agent_workspace")
      return { ...session, status: "active" };
    if (command === "reconcile_agent_workspace")
      return {
        session: {
          ...session,
          status: args.outcome === "success" ? "review" : args.outcome,
        },
        changes: currentChanges(),
      };
    if (
      [
        "execute_codex_code",
        "resume_codex_code",
        "execute_claude_code",
        "resume_claude_code",
      ].includes(command)
    ) {
      const provider = command.includes("codex") ? "codex" : "claude";
      submittedPrompts.push(args.prompt as string);
      window.setTimeout(
        async () => {
          round += 1;
          const manuscript = new TextDecoder().decode(
            disk.get(`${candidate}/manuscript.md`),
          );
          disk.set(
            `${candidate}/manuscript.md`,
            new TextEncoder().encode(
              `${manuscript}\nRefinement ${round}: clarified the evaluation while preserving your manual edits.\n`,
            ),
          );
          await emit(`${provider}-complete`, {
            tab_id: session.tabId,
            success: true,
          });
        },
        queueDemo ? 5000 : 1200,
      );
      return;
    }
    if (command === "list_codex_models")
      return [
        {
          model: "demo",
          display_name: "Demo model",
          description: "Browser demo",
          supported_reasoning_efforts: [
            { value: "medium", description: "Medium" },
          ],
          default_reasoning_effort: "medium",
          is_default: true,
        },
      ];
    if (command === "list_claude_models")
      return [
        {
          value: "default",
          displayName: "Demo model",
          description: "Browser demo",
          supportsEffort: false,
          supportedEffortLevels: [],
        },
      ];
    if (command === "plugin:fs|read_dir")
      return [...disk.keys()]
        .filter(
          (key) =>
            key.startsWith(`${path}/`) &&
            !key.slice(path.length + 1).includes("/"),
        )
        .map((key) => ({
          name: key.slice(path.length + 1),
          isFile: true,
          isDirectory: false,
          isSymlink: false,
        }));
    if (command === "plugin:fs|exists") return disk.has(path);
    if (command === "plugin:fs|stat")
      return {
        size: disk.get(path)?.length ?? 0,
        isFile: true,
        isDirectory: false,
        mtime: 1,
      };
    if (command === "plugin:fs|read_file") return disk.get(path) ?? [];
    if (command === "plugin:fs|read_text_file")
      return new TextDecoder().decode(disk.get(path));
    if (command === "preview_agent_workspace")
      return {
        session,
        changes: currentChanges(),
        conflicts: [],
        sourceRevision: `demo-${revision}`,
        currentContents: Object.fromEntries(
          changes.map((change) => [
            change.id,
            change.binary
              ? null
              : new TextDecoder().decode(
                  disk.get(`${root}/${change.filePath}`),
                ),
          ]),
        ),
        mergedContents: {
          ...(compileCase || acceptanceDemo
            ? {
                "compile-change": new TextDecoder().decode(
                  disk.get(`${candidate}/main.tex`),
                ),
              }
            : {}),
          "figure-change-2": new TextDecoder().decode(
            disk.get(`${candidate}/manuscript.md`),
          ),
        },
      };
    if (command === "apply_agent_workspace") {
      const decisions = args.decisions as AgentWorkspaceDecision[];
      const changedPaths: string[] = [];
      for (const decision of decisions) {
        const change = changes.find((item) => item.id === decision.changeId)!;
        if (!decision.accept) continue;
        if (change.kind === "deleted") {
          disk.delete(`${root}/${change.filePath}`);
          changedPaths.push(change.filePath);
          continue;
        }
        disk.set(
          `${root}/${change.filePath}`,
          decision.content === undefined
            ? disk.get(`${candidate}/${change.filePath}`)!
            : new TextEncoder().encode(decision.content),
        );
        // Match native settlement: a completed decision updates the draft too;
        // partial decisions retain the pending proposal for further review.
        if (!decision.partial)
          disk.set(
            `${candidate}/${change.filePath}`,
            disk.get(`${root}/${change.filePath}`)!,
          );
        const cached = urls.get(`${root}/${change.filePath}`);
        if (cached) URL.revokeObjectURL(cached);
        urls.delete(`${root}/${change.filePath}`);
        changedPaths.push(change.filePath);
      }
      for (const decision of decisions) {
        const index = changes.findIndex(
          (change) => change.id === decision.changeId,
        );
        if (index >= 0) {
          if (decision.partial)
            changes[index] = {
              ...changes[index],
              oldContent: decision.content ?? changes[index].oldContent,
            };
          else changes.splice(index, 1);
        }
      }
      revision += 1;
      return {
        applied: true,
        changedPaths,
        conflicts: [],
        remainingPreview: changes.length
          ? await bridge.invoke("preview_agent_workspace")
          : null,
      };
    }
    if (command === "discard_agent_workspace") return;
    if (command === "git_panel_conflicts") return { files: [] };
    return original(command, raw, options);
  };
  useCodexSetupStore.setState({ status: "ready", error: null });
  useClaudeSetupStore.setState({ status: "ready", error: null });
  await Promise.all([
    useCodexSetupStore.getState().refreshModels(),
    useClaudeSetupStore.getState().refreshModels(),
  ]);
  useHistoryStore.setState({
    init: async () => {},
    createSnapshot: async () => null,
  });
  useProposedChangesStore.setState({
    changes: [],
    changesByProject: {},
    workspaceReview: null,
    workspaceReviewsByProject: {},
    activeProjectRoot: root,
  });
  useAgentReviewQueueStore.setState({ entries: [] });
  useDocumentStore.setState({
    projectRoot: root,
    files: [],
    folders: [],
    initialized: true,
    agentWorkspaceRoot: null,
    agentWorkspaceSessionId: null,
    sourceViewSnapshot: null,
    activeFileId: acceptanceDemo
      ? "main.tex"
      : new URLSearchParams(location.search).has("textReview")
        ? "manuscript.md"
        : "new-figure.png",
    openFileIds: [],
    selectionRange: null,
  });
  await useDocumentStore.getState().refreshFiles();
  useAgentChatStore.setState((state) => {
    const messages = [
      {
        type: "assistant" as const,
        provider: "codex" as const,
        message: {
          content: [
            {
              type: "text" as const,
              text: acceptanceDemo
                ? "I revised the long LaTeX report and Markdown manuscript, with three wording changes in each. Both drafts are ready for review. You can accept or reject individual blocks, use the bulk actions, and switch between the editor and preview. The PDF is compiled from the LaTeX draft. All project data is fictional."
                : compileCase
                  ? "I updated the results paragraph in main.tex and added a separate results-summary include."
                  : new URLSearchParams(location.search).has("mathChat")
                    ? String.raw`For one adapted weight matrix, we keep four columns of \(U\) and \(V\), and singular values \(\sigma_1,\ldots,\sigma_4\).

The bilinear encoder combines the paired projections:

\[h = \sum_{k=1}^{4} \tilde{\sigma}_k (W_u u_k) \odot (W_v v_k)\]

Dollar notation also works: $x^2 + y^2 = z^2$.

Code stays literal: ` + "`\\(u_k\\)`"
                    : "I created an ablation figure, replaced the results figure, and revised manuscript.md. Please review all three changes. Each file decision updates your project.",
            },
          ],
        },
      },
    ];
    const tab = {
      ...state.tabs[0],
      id: session.tabId,
      title: acceptanceDemo
        ? "Review the Riverside study"
        : "Review figures and manuscript",
      agentWorkspace: session,
      messages,
      isStreaming: false,
      isSettling: false,
      turnPhase: null,
      pauseState: null,
      error: null,
    };
    return {
      selectedProvider: "codex",
      selectedCodexModel: "demo",
      chatProjectRoot: root,
      tabs: [tab],
      activeTabId: tab.id,
      messages,
      isStreaming: false,
      error: null,
    };
  });
  await useAgentReviewQueueStore.getState().enqueue(session);
  useDocumentStore
    .getState()
    .setActiveFile(
      compileCase || acceptanceDemo
        ? "main.tex"
        : new URLSearchParams(location.search).has("textReview")
          ? "manuscript.md"
          : "new-figure.png",
    );
  if (queueDemo) {
    const chat = useAgentChatStore.getState();
    const refinement = await useAgentReviewQueueStore
      .getState()
      .beginRefinement(session.sessionId);
    chat._setAgentWorkspace(session.tabId, refinement.session);
    chat._setStreaming(session.tabId, true);
    useAgentChatStore.setState((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.id === session.tabId
          ? {
              ...tab,
              turnPhase: "running",
              queuedPrompts: [],
              promptQueuePaused: false,
            }
          : tab,
      ),
    }));
    chat.enqueuePrompt(session.tabId, "Summarize the main findings.", []);
    chat.enqueuePrompt(session.tabId, "Check the limitations section.", []);
    chat.requestDrawerOpen();
  }
  if (acceptanceDemo) {
    const compiled = await compileLatex(
      candidate,
      "main.tex",
      "latexmk",
      "pdflatex",
    );
    useDocumentStore.getState().setPdfData(compiled.pdfData, "main.tex");
  }
  if (
    acceptanceDemo ||
    compileCase ||
    new URLSearchParams(location.search).has("mathChat")
  )
    useAgentChatStore.getState().requestDrawerOpen();
  if (new URLSearchParams(location.search).get("error") === "claude-auth") {
    useAgentChatStore.setState({
      selectedProvider: "claude",
      selectedClaudeModel: "default",
    });
    useAgentChatStore
      .getState()
      ._setError(
        session.tabId,
        "Failed to authenticate. API Error: 401 OAuth access token has been revoked.",
      );
    useAgentChatStore.getState().requestDrawerOpen();
  } else if (
    new URLSearchParams(location.search).has("error") ||
    new URLSearchParams(location.search).has("errorOptions") ||
    new URLSearchParams(location.search).has("errorInput")
  )
    showDemoError(
      new URLSearchParams(location.search).get("error") === "compile"
        ? "compile"
        : "connection",
    );
}

function DemoWorkspace() {
  useAgentEvents();
  return <WorkspaceLayout />;
}

export function AgentFileReviewDemo() {
  const errorInput = new URLSearchParams(location.search).has("errorInput");
  const [blocked, setBlocked] = useState(true);
  const [busySession, setBusySession] = useState(false);
  const [loggedOut, setLoggedOut] = useState(false);
  const [errorStyle, setErrorStyle] = useState<"solid" | "inner">("solid");
  const [resolved, setResolved] = useState(false);
  const optionsEnabled = new URLSearchParams(location.search).has(
    "errorOptions",
  );
  const [option, setOption] = useState<ErrorOption>(() => {
    const value = new URLSearchParams(location.search).get("errorOptions");
    return value === "a" || value === "c" ? value : "b";
  });
  const compileCase = new URLSearchParams(location.search).has("compileCase");
  const [demoBusy, setDemoBusy] = useState(false);
  const [firstQueueTurnFinished, setFirstQueueTurnFinished] = useState(false);
  const runCompileStep = async (command: string) => {
    setDemoBusy(true);
    try {
      await browserHarness()!.invoke(command);
    } catch (error) {
      setError(String(error));
    } finally {
      setDemoBusy(false);
    }
  };
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (!window.catalex)
      void initialize()
        .then(() => setReady(true))
        .catch((e) => setError(String(e)));
  }, []);
  if (window.catalex) return <p>Open this demo in a browser.</p>;
  return (
    <ThemeProvider attribute="class" defaultTheme="light">
      <ComposerErrorPreviewContext.Provider
        value={
          errorInput
            ? (info) => (
                <ChatErrorInputPreview
                  {...info}
                  busySession={busySession}
                  blocked={blocked}
                  resolved={resolved}
                  style={errorStyle}
                />
              )
            : null
        }
      >
        <div
          data-demo-error-input={errorInput || undefined}
          data-demo-error-options={optionsEnabled || undefined}
          className="flex h-screen flex-col bg-background text-foreground"
        >
          {optionsEnabled && ready && <ChatErrorOptions option={option} />}
          <div className="flex shrink-0 items-center gap-3 border-b px-3 py-2 text-xs">
            <strong>
              {acceptanceDemo
                ? "Riverside Study · Acceptance demo"
                : errorInput
                  ? "Chat input · Error state"
                  : compileCase
                    ? "Compile failure · Real file"
                    : optionsEnabled
                      ? "Chat error · Design options"
                      : "Browser demo · Figure Review"}
            </strong>
            <span className="flex-1 text-muted-foreground">
              {queueDemo
                ? "Prompt queue · Add, drag, edit, or remove queued prompts while the agent works"
                : acceptanceDemo
                  ? "Long LaTeX + Markdown · Real PDF preview · Fictional project"
                  : errorInput
                    ? "UI preview · Refresh checks simulated resolution"
                    : compileCase
                      ? "Real LaTeX compiler · Simulated agent lifecycle"
                      : optionsEnabled
                        ? "Visual preview · Retry simulates recovery"
                        : "Dummy project · Simulated agent · Send feedback to refine the manuscript"}
            </span>
            {queueDemo && (
              <button
                type="button"
                disabled={!ready || firstQueueTurnFinished}
                className="rounded border px-2 py-1 disabled:opacity-50"
                onClick={() => {
                  setFirstQueueTurnFinished(true);
                  void browserHarness()!.invoke("demo_queue_finish");
                }}
              >
                Finish first turn
              </button>
            )}
            {compileCase && (
              <>
                <button
                  type="button"
                  disabled={!ready || demoBusy}
                  onClick={() => void runCompileStep("demo_compile_tool")}
                  className="rounded border px-2 py-1 disabled:opacity-50"
                >
                  1. Compile during work
                </button>
                <button
                  type="button"
                  disabled={!ready || demoBusy}
                  onClick={() => void runCompileStep("demo_compile_finish")}
                  className="rounded border px-2 py-1 disabled:opacity-50"
                >
                  2. Finish without fixing
                </button>
              </>
            )}
            {optionsEnabled && (
              <div
                className="flex gap-1 rounded-lg border bg-muted/40 p-1"
                role="group"
                aria-label="Error design options"
              >
                {(
                  [
                    ["a", "A · Compact notice"],
                    ["b", "B · Inside input"],
                    ["c", "C · Conversation"],
                  ] as const
                ).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={option === value}
                    onClick={() => {
                      setOption(value);
                      showDemoError();
                    }}
                    className={`rounded-md px-3 py-1.5 text-xs transition-colors ${option === value ? "bg-background font-medium shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
            {errorInput && (
              <>
                <select
                  aria-label="Error styling"
                  value={errorStyle}
                  onChange={(event) =>
                    setErrorStyle(event.target.value as "solid" | "inner")
                  }
                  className="rounded-md border bg-background px-2 py-1"
                >
                  <option value="solid">Solid red · Previous</option>
                  <option value="inner">Inner red card · New</option>
                </select>
                <div
                  role="group"
                  aria-label="Error scenario"
                  className="flex rounded-lg border bg-muted/40 p-1"
                >
                  {[true, false].map((value) => (
                    <button
                      key={String(value)}
                      type="button"
                      aria-pressed={
                        !busySession && !loggedOut && blocked === value
                      }
                      onClick={() => {
                        setBusySession(false);
                        setLoggedOut(false);
                        setBlocked(value);
                        setResolved(false);
                        showDemoError(value ? "connection" : "repair");
                      }}
                      className={`rounded-md px-2 py-1 ${!busySession && !loggedOut && blocked === value ? "bg-background shadow-sm" : "text-muted-foreground"}`}
                    >
                      {value ? "Agent blocked" : "Agent can help"}
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  aria-pressed={loggedOut}
                  className={`rounded-md border px-2 py-1 ${loggedOut ? "bg-muted font-medium" : ""}`}
                  onClick={() => {
                    setBusySession(false);
                    setLoggedOut(true);
                    setBlocked(true);
                    setResolved(false);
                    showDemoError("logged-out");
                  }}
                >
                  Agent logged out
                </button>
                <button
                  type="button"
                  aria-pressed={busySession}
                  className={`rounded-md border px-2 py-1 ${busySession ? "bg-muted font-medium" : ""}`}
                  onClick={() => {
                    setBusySession(true);
                    setLoggedOut(false);
                    setBlocked(true);
                    setResolved(false);
                    showDemoError("busy");
                  }}
                >
                  Session busy
                </button>
                <label className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={resolved}
                    onChange={(event) => setResolved(event.target.checked)}
                  />
                  Problem resolved
                </label>
              </>
            )}
            {!acceptanceDemo && !compileCase && !errorInput && (
              <>
                <button
                  type="button"
                  disabled={!ready}
                  onClick={() => showDemoError("compile")}
                >
                  Show compile error
                </button>
                <button
                  type="button"
                  disabled={!ready}
                  onClick={() => showDemoError()}
                >
                  Show chat error
                </button>
              </>
            )}
            {errorInput && (
              <button
                type="button"
                onClick={() => {
                  setResolved(false);
                  showDemoError(
                    busySession
                      ? "busy"
                      : loggedOut
                        ? "logged-out"
                        : blocked
                          ? "connection"
                          : "repair",
                  );
                }}
              >
                Show error again
              </button>
            )}
            <button type="button" onClick={() => location.reload()}>
              Reset demo
            </button>
          </div>
          {error && <p role="alert">{error}</p>}
          <div className="min-h-0 flex-1">{ready && <DemoWorkspace />}</div>
          <Toaster />
        </div>
      </ComposerErrorPreviewContext.Provider>
    </ThemeProvider>
  );
}
