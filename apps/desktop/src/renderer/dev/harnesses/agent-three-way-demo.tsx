import { useEffect, useState } from "react";
import { toast } from "sonner";
import { ThemeProvider } from "next-themes";
import { WorkspaceLayout } from "@/components/workspace/workspace-layout";
import { Toaster } from "@/components/ui/sonner";
import {
  loadProjectInlineComments,
  withCommentPathMutation,
} from "@/components/workspace/editor/inline-comment-storage";
import { useAgentEvents } from "@/hooks/use-agent-events";
import { useProjectFileWatch } from "@/hooks/use-project-file-watch";
import { ProjectChangedDialog } from "@/components/agent-chat/agent-question-prompt";
import type {
  AgentMergeSegment,
  AgentWorkspaceDecision,
  AgentWorkspaceSession,
} from "@/lib/agent-workspace";
import { browserHarness } from "@/lib/desktop/bridge";
import { emit } from "@/lib/desktop/event";
import { useSettingsStore } from "@/stores/settings-store";
import { useDocumentStore } from "@/stores/document-store";
import { useAgentChatStore } from "@/stores/agent-chat-store";
import { useAgentReviewQueueStore } from "@/stores/agent-review-queue-store";
import { useProposedChangesStore } from "@/stores/proposed-changes-store";
import { useCodexSetupStore } from "@/stores/codex-setup-store";
import { useClaudeSetupStore } from "@/stores/claude-setup-store";
import { useHistoryStore, type SnapshotInfo } from "@/stores/history-store";
import { ensureDesktopBrowserMocks } from "../desktop-browser-mocks";

import complexFixtures from "./agent-three-way-fixtures.json";

const root = "/browser-demo/Riverside Study";
const candidate = "/browser-demo/private-worktree";
type CommentNotice = "disconnected" | "storage";
async function showCommentNotice(kind: CommentNotice) {
  toast.dismiss(
    kind === "disconnected"
      ? "comment-path-recovery"
      : "orphaned-project-comments",
  );
  localStorage.setItem(
    `catalex-harness-disconnected:${root}`,
    JSON.stringify(
      kind === "disconnected"
        ? {
            "old-manuscript.md": [
              {
                id: "H-demo-disconnected",
                number: 1,
                from: 0,
                to: 10,
                line: 1,
                text: "Please clarify how the samples were selected.",
                resolved: false,
              },
            ],
          }
        : {},
    ),
  );
  await loadProjectInlineComments(root);
  if (kind === "storage")
    await withCommentPathMutation(root, async () => ({
      commentWarning:
        "Comment storage is read-only. Your comments are preserved.",
    }));
}
const session: AgentWorkspaceSession = {
  version: 2,
  sessionId: "three-way-demo",
  tabId: "three-way-chat",
  projectRoot: root,
  mode: "ask",
  status: "review",
  createdAt: 1,
  updatedAt: 1,
  sourceCommit: "demo-source-checkpoint",
  baselineCommit: "demo-source-checkpoint",
  candidateRoot: candidate,
  warnings: [],
};

const prefix = "# Riverside study\n\n## Participants\n\n";
const divider = "\n## Interpretation\n\n";
const suffix =
  "\n## Next steps\n\nRepeat the study on an independent collection.\n";
const baseSample = "We evaluated 10 samples using manual inspection.\n";
const currentSample = "We evaluated 20 samples using manual inspection.\n";
const agentSample = "We evaluated 15 samples using automated inspection.\n";
const baseConclusion = "These preliminary observations require follow-up.\n";
const currentConclusion =
  "The expanded cohort supports a larger follow-up study.\n";
const agentConclusion =
  "The automated protocol should be independently validated.\n";
const opening = "The study compares a repeatable inspection protocol.\n\n";
const currentOpening =
  "The expanded study compares a repeatable inspection protocol.\n\n";
const base = prefix + opening + baseSample + divider + baseConclusion + suffix;
const current =
  prefix +
  currentOpening +
  currentSample +
  divider +
  currentConclusion +
  suffix;
const agent =
  prefix + opening + agentSample + divider + agentConclusion + suffix;
const notesBase =
  "# Replication checklist\n\n- Record each sample identifier.\n";
const notesAgent = `${notesBase}- Archive the evaluation script and configuration.\n`;

interface DemoScenario {
  id: string;
  label: string;
  description: string;
  base: string;
  current: string;
  agent: string;
  segments: AgentMergeSegment[];
}
const scenarios: DemoScenario[] = [
  {
    id: "simple",
    label: "Simple passages",
    description:
      "The starting count was 10, your project says 20, and the proposal says 15. Review both overlapping passages. Your expanded-study wording is preserved. The checklist can be applied independently while the manuscript remains open.",
    base,
    current,
    agent,
    segments: [
      { kind: "resolved", content: prefix + currentOpening },
      {
        kind: "conflict",
        ancestor: baseSample,
        current: currentSample,
        agent: agentSample,
      },
      { kind: "resolved", content: divider },
      {
        kind: "conflict",
        ancestor: baseConclusion,
        current: currentConclusion,
        agent: agentConclusion,
      },
      { kind: "resolved", content: suffix },
    ],
  },
  // These fixtures are checked against the native Git merger in text_merge.rs.
  ...(complexFixtures as DemoScenario[]),
];
const scenario =
  scenarios.find(
    (item) => item.id === new URLSearchParams(location.search).get("scenario"),
  ) ?? scenarios[0];

async function initialize() {
  ensureDesktopBrowserMocks();
  useSettingsStore
    .getState()
    .setWorkspacePreferences(root, { mode: "duet", chatLayout: "workspace" });
  const bridge = browserHarness()!;
  const original = bridge.invoke;
  localStorage.removeItem(`catalex-harness-disconnected:${root}`);
  const disk = new Map([
    [`${root}/manuscript.md`, scenario.current],
    [`${candidate}/manuscript.md`, scenario.agent],
    [`${root}/checklist.md`, notesBase],
    [`${candidate}/checklist.md`, notesAgent],
  ]);
  const baselines = new Map([
    ["manuscript.md", scenario.base],
    ["checklist.md", notesBase],
  ]);
  const pending = new Set(baselines.keys());
  const rebased = new Set<string>();
  let revision = 1;
  let discarded = false;
  let refinement = 0;
  const checkpoints: SnapshotInfo[] = [
    {
      id: "before-agent",
      message: "Before agent work",
      timestamp: Math.floor(Date.now() / 1000) - 120,
      labels: [],
      changed_files: ["manuscript.md", "checklist.md"],
    },
  ];
  let watchId = "";
  const preview = () => {
    const changes = [...pending].map((filePath) => ({
      id: filePath,
      kind: "modified" as const,
      filePath,
      oldFilePath: filePath,
      newFilePath: filePath,
      sourceAbsolutePath: `${root}/${filePath}`,
      candidateAbsolutePath: `${candidate}/${filePath}`,
      oldContent: baselines.get(filePath)!,
      newContent: disk.get(`${candidate}/${filePath}`)!,
      binary: false,
      sourceChanged:
        baselines.get(filePath) !== disk.get(`${root}/${filePath}`),
      proposalRevision: disk.get(`${candidate}/${filePath}`)!,
    }));
    const conflict =
      pending.has("manuscript.md") && !rebased.has("manuscript.md");
    return {
      session,
      changes,
      sourceRevision: `source-${revision}`,
      projectRevision: `project-${revision}`,
      conflicts: conflict
        ? [
            {
              changeId: "manuscript.md",
              filePath: "manuscript.md",
              reason: "The project and agent changed the same passages.",
            },
          ]
        : [],
      currentContents: Object.fromEntries(
        changes.map((change) => [
          change.id,
          disk.get(`${root}/${change.filePath}`),
        ]),
      ),
      mergedContents: Object.fromEntries(
        changes
          .filter((change) => change.id !== "manuscript.md" || !conflict)
          .map((change) => [change.id, change.newContent]),
      ),
      conflictContents: conflict
        ? {
            "manuscript.md": [
              ...scenario.segments,
              ...(refinement
                ? [
                    {
                      kind: "resolved" as const,
                      content: disk
                        .get(`${candidate}/manuscript.md`)!
                        .slice(scenario.agent.length),
                    },
                  ]
                : []),
            ],
          }
        : {},
    };
  };
  bridge.invoke = async (command, raw, options) => {
    const args = (raw ?? {}) as Record<string, unknown>;
    const path = String(args.path ?? "");
    if (command === "review_project_state")
      return { revision: `project-${revision}`, gitPending: false };
    if (command === "watch_project_files") {
      watchId = String(args.watchId);
      return;
    }
    if (command === "unwatch_project_files") return;
    if (command === "demo_external_project_change") {
      const file = `${root}/${String(args.file ?? "manuscript.md")}`;
      if (args.deleted) disk.delete(file);
      else disk.set(file, "External project content.\n");
      revision += 1;
      if (args.notify !== false)
        await emit("project-files-changed", {
          projectRoot: root,
          watchId,
          paths: [],
          rescan: true,
        });
      return;
    }
    if (command === "read_project_comments_anchored") {
      const snapshot = (await original(command, raw, options)) as object;
      const disconnected = JSON.parse(
        localStorage.getItem(`catalex-harness-disconnected:${root}`) ?? "{}",
      );
      return { ...snapshot, orphanedPaths: Object.keys(disconnected) };
    }
    if (command === "demo_three_way_state")
      return {
        scenario: scenario.id,
        source: Object.fromEntries(
          [...disk].filter(([key]) => key.startsWith(`${root}/`)),
        ),
        candidate: Object.fromEntries(
          [...disk].filter(([key]) => key.startsWith(`${candidate}/`)),
        ),
        pending: [...pending],
        discarded,
        checkpoints,
        queue: useAgentReviewQueueStore.getState().entries.map((entry) => ({
          id: entry.session.sessionId,
          phase: entry.phase,
        })),
      };
    if (command === "plugin:path|join")
      return (args.paths as string[]).join("/").replace(/\/+/g, "/");
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
    if (command === "plugin:fs|read_text_file") return disk.get(path) ?? "";
    if (command === "plugin:fs|read_file")
      return new TextEncoder().encode(disk.get(path) ?? "");
    if (command === "plugin:fs|exists") return disk.has(path);
    if (command === "plugin:fs|stat")
      return {
        size: disk.get(path)?.length ?? 0,
        isFile: true,
        isDirectory: false,
        mtime: 1,
      };
    if (command === "plugin:fs|write_text_file") {
      const headers = (options as { headers?: Record<string, string> })
        ?.headers;
      disk.set(
        decodeURIComponent(headers?.path ?? path),
        new TextDecoder().decode(raw as Uint8Array),
      );
      return;
    }
    if (command === "git_head_file_content")
      return { repo_found: false, head_content: null, ignored: false };
    if (command === "git_panel_status") return { repo_found: false };
    if (command === "git_panel_conflicts") return { files: [] };
    if (command === "preview_agent_workspace") return preview();
    if (command === "reconcile_agent_workspace")
      return { session, changes: preview().changes };
    if (command === "resume_agent_workspace")
      return { ...session, status: "active" };
    if (command === "agent_workspace_source_changed")
      return preview().changes.some((change) => change.sourceChanged);
    if (command === "list_agent_workspaces") return discarded ? [] : [session];
    if (command === "discard_agent_workspace") {
      discarded = true;
      return;
    }
    if (command === "apply_agent_workspace") {
      if (args.expectedSourceRevision !== `source-${revision}`)
        throw new Error(
          "The project changed. Refresh the review before applying.",
        );
      const decisions = args.decisions as AgentWorkspaceDecision[];
      const changedPaths: string[] = [];
      for (const decision of decisions) {
        if (!pending.has(decision.changeId)) continue;
        if (
          decision.accept &&
          decision.changeId === "manuscript.md" &&
          !decision.resolvedConflict
        ) {
          throw new Error(
            "Resolve the overlapping manuscript changes before applying them.",
          );
        }
        const sourcePath = `${root}/${decision.changeId}`;
        const draftPath = `${candidate}/${decision.changeId}`;
        if (decision.accept) {
          const result = decision.content ?? disk.get(draftPath)!;
          if (disk.get(sourcePath) !== result)
            changedPaths.push(decision.changeId);
          disk.set(sourcePath, result);
        }
        if (!decision.partial) disk.set(draftPath, disk.get(sourcePath)!);
        baselines.set(decision.changeId, disk.get(sourcePath)!);
        if (decision.partial) rebased.add(decision.changeId);
        else pending.delete(decision.changeId);
      }
      revision += 1;
      return {
        applied: true,
        changedPaths,
        conflicts: [],
        remainingPreview: pending.size ? preview() : null,
      };
    }
    if (command === "history_init") return null;
    if (command === "history_list")
      return Number(args.offset ?? 0) ? [] : checkpoints;
    if (command === "history_snapshot") {
      const snapshot: SnapshotInfo = {
        id: `main-${revision}-${checkpoints.length}`,
        message: String(args.message ?? "Applied agent changes"),
        timestamp: Math.floor(Date.now() / 1000),
        labels: [],
        changed_files: [...baselines.keys()],
      };
      checkpoints.unshift(snapshot);
      return snapshot;
    }
    if (
      [
        "execute_codex_code",
        "resume_codex_code",
        "execute_claude_code",
        "resume_claude_code",
      ].includes(command)
    ) {
      window.setTimeout(async () => {
        refinement += 1;
        for (const filePath of pending) {
          const path = `${candidate}/${filePath}`;
          disk.set(
            path,
            `${disk.get(path)}\nRefinement ${refinement}: report uncertainty alongside the findings.\n`,
          );
        }
        await emit(
          `${command.includes("codex") ? "codex" : "claude"}-complete`,
          { tab_id: session.tabId, success: true },
        );
      }, 900);
      return;
    }
    return original(command, raw, options);
  };
  useCodexSetupStore.setState({ status: "ready", error: null });
  useClaudeSetupStore.setState({ status: "ready", error: null });
  useHistoryStore.setState({ snapshots: checkpoints });
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
    activeFileId: "manuscript.md",
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
              text: scenario.description,
            },
          ],
        },
      },
    ];
    const tab = {
      ...state.tabs[0],
      id: session.tabId,
      title: "Review Riverside findings",
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
      chatProjectRoot: root,
      tabs: [tab],
      activeTabId: tab.id,
      messages,
      isStreaming: false,
      error: null,
    };
  });
  await useAgentReviewQueueStore.getState().enqueue(session);
  useDocumentStore.getState().setActiveFile("manuscript.md");
  useAgentChatStore.getState().requestDrawerOpen();
}

function DemoWorkspace() {
  useAgentEvents();
  useProjectFileWatch();
  return (
    <>
      <WorkspaceLayout />
      <ProjectChangedDialog />
    </>
  );
}

export function AgentThreeWayDemo() {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (!window.catalex)
      void initialize()
        .then(() => setReady(true))
        .catch((reason) => setError(String(reason)));
  }, []);
  useEffect(() => {
    const notice = new URLSearchParams(location.search).get("commentNotice");
    if (!ready || (notice !== "disconnected" && notice !== "storage")) return;
    // Let the workspace's initial comment load and toast dismissal finish first.
    const timer = window.setTimeout(() => {
      void showCommentNotice(notice).catch((reason) =>
        setError(String(reason)),
      );
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [ready]);
  if (window.catalex) return <p>Open this demo in a browser.</p>;
  return (
    <ThemeProvider attribute="class" defaultTheme="light">
      <div
        className="flex h-screen flex-col bg-background text-foreground"
        data-testid="agent-three-way-demo"
      >
        <div className="flex shrink-0 flex-wrap items-center gap-3 border-b px-3 py-2 text-xs">
          <strong>Riverside Study · Three-way agent review</strong>
          <span className="flex-1 text-muted-foreground">
            Fictional project · Simulated agent and storage
          </span>
          <button
            type="button"
            className="rounded border bg-primary px-2 py-1 text-primary-foreground"
            disabled={!ready}
            onClick={() =>
              void browserHarness()!
                .invoke("demo_external_project_change", {})
                .catch((reason) => setError(String(reason)))
            }
          >
            Simulate external change
          </button>
          <select
            aria-label="Merge scenario"
            className="rounded border bg-background px-2 py-1"
            value={scenario.id}
            onChange={(event) => {
              const url = new URL(location.href);
              url.searchParams.set("scenario", event.target.value);
              location.assign(url.href);
            }}
          >
            {scenarios.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="rounded border px-2 py-1"
            disabled={!ready}
            onClick={() =>
              void showCommentNotice("disconnected").catch((reason) =>
                setError(String(reason)),
              )
            }
          >
            Disconnected comments
          </button>
          <button
            type="button"
            className="rounded border px-2 py-1"
            disabled={!ready}
            onClick={() =>
              void showCommentNotice("storage").catch((reason) =>
                setError(String(reason)),
              )
            }
          >
            Storage error
          </button>
          <button
            type="button"
            className="rounded border px-2 py-1"
            disabled={!ready}
            onClick={() => {
              toast.dismiss("orphaned-project-comments");
              toast.dismiss("comment-path-recovery");
              toast.error("This project is already open in another window.", {
                id: "demo-project-already-open",
                duration: Number.POSITIVE_INFINITY,
                action: {
                  label: "Go to window",
                  onClick: () =>
                    toast.info(
                      "Demo: this would switch to the project’s existing window.",
                      { id: "demo-project-window-switch" },
                    ),
                },
              });
            }}
          >
            Project already open
          </button>
          <button
            type="button"
            className="rounded border px-2 py-1"
            onClick={() => location.reload()}
          >
            Reset demo
          </button>
        </div>
        {error ? (
          <p role="alert" className="p-4">
            {error}
          </p>
        ) : ready ? (
          <div className="min-h-0 flex-1">
            <DemoWorkspace />
          </div>
        ) : (
          <p className="p-4">Preparing review…</p>
        )}
        <Toaster />
      </div>
    </ThemeProvider>
  );
}
