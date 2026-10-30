import { useEffect, useState } from "react";
import { ThemeProvider } from "next-themes";
import { WorkspaceLayout } from "@/components/workspace/workspace-layout";
import { Toaster } from "@/components/ui/sonner";
import type { AgentMergeSegment } from "@/lib/agent-workspace";
import { browserHarness } from "@/lib/desktop/bridge";
import { useDocumentStore } from "@/stores/document-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useAgentChatStore } from "@/stores/agent-chat-store";
import { useAgentReviewQueueStore } from "@/stores/agent-review-queue-store";
import { useProposedChangesStore } from "@/stores/proposed-changes-store";
import { ensureDesktopBrowserMocks } from "../desktop-browser-mocks";
import fixtures from "./agent-three-way-fixtures.json";

// Both review paths use the same native-Git-verified merge inputs. Only the
// project Git adapter is active here; no agent session or private draft exists.
const scenario =
  fixtures.find(
    (item) => item.id === new URLSearchParams(location.search).get("scenario"),
  ) ?? fixtures[1];
const root = "/browser-demo/Riverside Git Project";
const file = "manuscript.md";

function createDemoFile(path: string, fixture: (typeof fixtures)[number]) {
  const segments = fixture.segments as AgentMergeSegment[];
  const rawConflict = segments
    .map((segment) =>
      segment.kind === "resolved"
        ? segment.content
        : `<<<<<<< HEAD\n${segment.current}||||||| ancestor\n${segment.ancestor}=======\n${segment.agent}>>>>>>> origin/main\n`,
    )
    .join("");
  return {
    path,
    fixture,
    segments,
    rawConflict,
    version: `project-git-${fixture.id}-${path}-v1`,
    content: rawConflict,
    conflicted: true,
    staged: false,
  };
}

async function initialize() {
  ensureDesktopBrowserMocks();
  const bridge = browserHarness()!;
  const original = bridge.invoke;
  const files = [
    createDemoFile(file, scenario),
    createDemoFile("methods.md", fixtures[0]),
    createDemoFile("appendix.md", fixtures[2]),
  ];
  const primary = files[0];
  const findFile = (path: string) =>
    files.find(
      (entry) => `${root}/${entry.path}` === path || entry.path === path,
    );
  const pendingFiles = () => files.filter((entry) => entry.conflicted);
  let mergeActive = true;
  const privateCommands: string[] = [];
  const side = (path: string, text: string) => ({
    path,
    text,
    binary: false,
    size: new TextEncoder().encode(text).length,
    preview_url: null,
    supported: true,
  });
  bridge.invoke = async (command, raw, options) => {
    const args = (raw ?? {}) as Record<string, unknown>;
    const path = String(args.path ?? "");
    const entry = findFile(String(args.filePath ?? path));
    if (command === "demo_project_git_state")
      return {
        scenario: scenario.id,
        content: primary.content,
        conflicted: primary.conflicted,
        staged: primary.staged,
        mergeActive,
        files: files.map(({ path, content, conflicted, staged }) => ({
          path,
          content,
          conflicted,
          staged,
        })),
        pendingFiles: pendingFiles().map((entry) => entry.path),
        privateCommands,
        agentWorkspaceRoot: useDocumentStore.getState().agentWorkspaceRoot,
        agentReviewCount: useProposedChangesStore.getState().changes.length,
        agentQueueCount: useAgentReviewQueueStore.getState().entries.length,
      };
    if (command === "list_agent_workspaces") return [];
    if (
      /^(prepare|resume|reconcile|preview|apply|discard)_agent_workspace$/.test(
        command,
      )
    ) {
      privateCommands.push(command);
      throw new Error(
        "Private agent workspaces are not part of this project Git demo.",
      );
    }
    if (command === "plugin:path|join")
      return (args.paths as string[]).join("/").replace(/\/+/g, "/");
    if (command === "plugin:fs|read_dir")
      return path === root
        ? files.map((entry) => ({
            name: entry.path,
            isFile: true,
            isDirectory: false,
            isSymlink: false,
          }))
        : [];
    if (command === "plugin:fs|read_text_file") return entry?.content ?? "";
    if (command === "plugin:fs|read_file")
      return new TextEncoder().encode(entry?.content ?? "");
    if (command === "plugin:fs|exists") return path === root || Boolean(entry);
    if (command === "plugin:fs|stat")
      return {
        size: new TextEncoder().encode(entry?.content ?? "").length,
        isFile: true,
        isDirectory: false,
        mtime: 1,
      };
    if (command === "plugin:fs|write_text_file") {
      const headers = (options as { headers?: Record<string, string> })
        ?.headers;
      const target = findFile(decodeURIComponent(headers?.path ?? path));
      if (target) target.content = new TextDecoder().decode(raw as Uint8Array);
      return;
    }
    if (command === "git_head_file_content")
      return {
        repo_found: true,
        head_content: entry?.fixture.current ?? null,
        ignored: false,
      };
    if (command === "git_conflict_file_content")
      return entry?.conflicted
        ? {
            conflicted: true,
            version: entry.version,
            ancestor_content: entry.fixture.base,
            current_content: entry.segments
              .map((segment) =>
                segment.kind === "resolved" ? segment.content : segment.current,
              )
              .join(""),
            incoming_content: entry.segments
              .map((segment) =>
                segment.kind === "resolved" ? segment.content : segment.agent,
              )
              .join(""),
            conflict_contents: entry.segments,
          }
        : { conflicted: false, current_content: null, incoming_content: null };
    if (command === "git_panel_conflicts")
      return {
        rebasing: false,
        files: pendingFiles().map((entry) => ({
          path: entry.path,
          document_path: entry.path,
          version: entry.version,
          ancestor: side(entry.path, entry.fixture.base),
          current: side(entry.path, entry.fixture.current),
          incoming: side(entry.path, entry.fixture.agent),
        })),
      };
    if (command === "git_panel_resolve_conflict") {
      if (
        !entry?.conflicted ||
        args.expectedVersion !== entry.version ||
        typeof args.content !== "string"
      )
        return {
          success: false,
          message: "The conflict changed. Refresh the review.",
        };
      entry.content = args.content;
      entry.conflicted = false;
      entry.staged = true;
      return { success: true, message: `Resolved and staged ${entry.path}` };
    }
    if (command === "git_panel_reopen_conflict") {
      if (!entry) return { success: false, message: "File not found" };
      entry.conflicted = true;
      entry.staged = false;
      entry.content = entry.rawConflict;
      return { success: true, message: "Conflict reopened" };
    }
    if (command === "git_panel_status")
      return {
        repo_found: true,
        branch: "main",
        upstream_branch: "origin/main",
        ahead: mergeActive ? 1 : 2,
        behind: mergeActive ? 1 : 0,
        staged: files.filter((entry) => entry.staged).length,
        unstaged: 0,
        untracked: 0,
        conflicted: pendingFiles().length,
        operation: mergeActive ? "merge" : null,
        can_push: !mergeActive,
      };
    if (command === "git_panel_changed_files")
      return mergeActive
        ? files.map((entry) => ({
            path: entry.path,
            staged: entry.staged,
            unstaged: false,
            untracked: false,
            conflicted: entry.conflicted,
          }))
        : [];
    if (command === "git_worktree_file_line_stats") return [];
    if (command === "git_panel_pull_status")
      return { can_pull: false, behind: 0, behind_commits: [] };
    if (command === "git_panel_branches")
      return [{ name: "main", is_current: true }];
    if (
      command === "git_panel_history" ||
      command === "git_panel_graph" ||
      command === "git_panel_stash_list"
    )
      return [];
    if (command === "git_panel_commit_selected") {
      if (pendingFiles().length)
        return {
          success: false,
          message: "Resolve the remaining conflicts first.",
        };
      mergeActive = false;
      for (const entry of files) entry.staged = false;
      return { success: true, message: "Demo merge completed" };
    }
    if (command === "git_panel_abort_operation") {
      mergeActive = false;
      for (const entry of files) {
        entry.staged = false;
        entry.conflicted = false;
        entry.content = entry.fixture.current;
      }
      return { success: true, message: "Demo merge aborted" };
    }
    if (command === "history_list") return [];
    return original(command, raw, options);
  };
  useSettingsStore
    .getState()
    .setWorkspacePreferences(root, { mode: "artisan", chatLayout: "drawer" });
  useProposedChangesStore.setState({
    changes: [],
    changesByProject: {},
    workspaceReview: null,
    workspaceReviewsByProject: {},
    activeProjectRoot: root,
  });
  useAgentReviewQueueStore.setState({ entries: [] });
  useAgentChatStore.setState((state) => ({
    messages: [],
    chatProjectRoot: root,
    isStreaming: false,
    error: null,
    drawerOpenRequested: false,
    tabs: state.tabs.map((tab) => ({
      ...tab,
      messages: [],
      agentWorkspace: null,
      isStreaming: false,
      isSettling: false,
      error: null,
    })),
  }));
  useAgentChatStore.getState().requestDrawerCollapse();
  useDocumentStore.setState({
    projectRoot: root,
    files: [],
    folders: [],
    initialized: true,
    agentWorkspaceRoot: null,
    agentWorkspaceSessionId: null,
    sourceViewSnapshot: null,
    activeFileId: file,
    openFileIds: [],
    selectionRange: null,
  });
  await useDocumentStore.getState().refreshFiles();
  useDocumentStore.getState().setActiveFile(file);
}

export function GitThreeWayDemo() {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (!window.catalex)
      void initialize()
        .then(() => setReady(true))
        .catch((reason) => setError(String(reason)));
  }, []);
  if (window.catalex) return <p>Open this demo in a browser.</p>;
  return (
    <ThemeProvider attribute="class" defaultTheme="light">
      <div
        className="flex h-screen flex-col bg-background text-foreground"
        data-testid="project-git-three-way-demo"
      >
        <div className="flex shrink-0 items-center gap-3 border-b px-3 py-2 text-xs">
          <strong>Riverside Study · Project Git merge</strong>
          <span className="flex-1 text-muted-foreground">
            main ← origin/main · Simulated repository · No agent draft
          </span>
          <select
            aria-label="Git merge scenario"
            className="rounded border bg-background px-2 py-1"
            value={scenario.id}
            onChange={(event) => {
              const url = new URL(location.href);
              url.searchParams.set("scenario", event.target.value);
              location.assign(url.href);
            }}
          >
            {fixtures.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
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
            <WorkspaceLayout />
          </div>
        ) : (
          <p className="p-4">Preparing project Git merge…</p>
        )}
        <Toaster />
      </div>
    </ThemeProvider>
  );
}
