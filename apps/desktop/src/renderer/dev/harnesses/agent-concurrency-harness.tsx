import { useAgentEvents } from "@/hooks/use-agent-events";
import { useEffect, useState } from "react";
import { ChatWorkspacePane } from "@/components/agent-chat/chat-workspace-pane";
import { ChatTabBar } from "@/components/agent-chat/chat-tab-bar";
import {
  AgentQuestionPrompt,
  AgentDraftNotice,
} from "@/components/agent-chat/agent-question-prompt";
import { ProposedChangesPanel } from "@/components/agent-chat/proposed-changes-panel";
import { useAgentChatStore } from "@/stores/agent-chat-store";
import { useAgentReviewQueueStore } from "@/stores/agent-review-queue-store";
import { useProposedChangesStore } from "@/stores/proposed-changes-store";
import { useDocumentStore } from "@/stores/document-store";
import { useHistoryStore } from "@/stores/history-store";
import type { AgentWorkspaceSession } from "@/lib/agent-workspace";
import { ensureDesktopBrowserMocks } from "../desktop-browser-mocks";

ensureDesktopBrowserMocks();
const projectRoot = "/concurrency-project";
const session = (id: string): AgentWorkspaceSession => ({
  version: 2,
  sessionId: id,
  tabId: id,
  projectRoot,
  mode:
    new URLSearchParams(location.search).get("mode") === "edit"
      ? "edit"
      : "ask",
  status: "review",
  createdAt: 1,
  updatedAt: 1,
  sourceCommit: "fixture-source",
  baselineCommit: "fixture-baseline",
  candidateRoot: `/${id}/candidate`,
  warnings: [],
});

export function AgentConcurrencyHarness() {
  useAgentEvents();
  const [ready, setReady] = useState(false);
  const [source, setSource] = useState("Original introduction");
  const entries = useAgentReviewQueueStore((state) => state.entries);
  const changes = useProposedChangesStore((state) => state.changes);
  const activeTabId = useAgentChatStore((state) => state.activeTabId);
  const tabs = useAgentChatStore((state) => state.tabs);
  const workspaceId = useDocumentStore(
    (state) => state.agentWorkspaceSessionId,
  );
  useEffect(() => {
    let sourceText = "Original introduction";
    let revision = 0;
    const conflict =
      new URLSearchParams(location.search).get("conflict") !== "false";
    const internal = (
      window as unknown as {
        __TAURI_INTERNALS__: {
          invoke: (
            cmd: string,
            args?: Record<string, unknown>,
          ) => Promise<unknown>;
        };
      }
    ).__TAURI_INTERNALS__;
    const original = internal.invoke;
    internal.invoke = async (cmd, args = {}) => {
      if (cmd === "preview_agent_workspace") {
        const id = String(args.sessionId);
        const conflicts =
          id === "b" && revision > 0 && conflict
            ? [
                {
                  changeId: "b-main",
                  filePath: "main.tex",
                  reason: "Both drafts changed the introduction.",
                },
              ]
            : [];
        const files = id === "b" ? ["main", "references"] : ["main"];
        const changes = files.map((file) => ({
          id: `${id}-${file}`,
          kind: "modified",
          filePath: `${file}.tex`,
          oldFilePath: `${file}.tex`,
          newFilePath: `${file}.tex`,
          oldContent: "Original introduction",
          newContent: `Agent ${id.toUpperCase()} proposal`,
          sourceAbsolutePath: `${projectRoot}/${file}.tex`,
          candidateAbsolutePath: `/${id}/candidate/${file}.tex`,
          binary: false,
          sourceChanged: revision > 0,
        }));
        return {
          session: session(id),
          changes,
          conflicts,
          sourceRevision: String(revision),
          currentContents: Object.fromEntries(
            changes.map((change) => [change.id, sourceText]),
          ),
          mergedContents: Object.fromEntries(
            changes
              .filter(
                (change) =>
                  !conflicts.some(
                    (conflict) => conflict.changeId === change.id,
                  ),
              )
              .map((change) => [change.id, change.newContent]),
          ),
        };
      }
      if (cmd === "apply_agent_workspace") {
        if (new URLSearchParams(location.search).get("mode") === "edit")
          await new Promise((resolve) => setTimeout(resolve, 600));
        if (new URLSearchParams(location.search).has("applyError"))
          throw new Error("Simulated disk write failure");
        if (args.expectedSourceRevision !== String(revision))
          return {
            applied: false,
            changedPaths: [],
            conflicts: [
              {
                changeId: "stale",
                filePath: "main.tex",
                reason: "Source changed again",
              },
            ],
          };
        const decisions = args.decisions as {
          accept: boolean;
          content?: string;
        }[];
        if (decisions.some((decision) => decision.accept)) {
          sourceText = `Accepted ${String(args.sessionId).toUpperCase()}`;
          revision++;
          setSource(sourceText);
        }
        return {
          applied: true,
          changedPaths: decisions.some((decision) => decision.accept)
            ? ["main.tex"]
            : [],
          conflicts: [],
        };
      }
      if (cmd === "discard_agent_workspace") return;
      return original(cmd, args);
    };
    useHistoryStore.setState({
      init: async () => {},
      createSnapshot: async () => null,
    });
    useDocumentStore.setState({
      projectRoot,
      files: [],
      folders: [],
      initialized: true,
      agentWorkspaceRoot: null,
      agentWorkspaceSessionId: null,
      sourceViewSnapshot: null,
      saveAllFiles: async () => {},
      activateAgentWorkspace: async (id, root) => {
        useDocumentStore.setState({
          agentWorkspaceRoot: root,
          agentWorkspaceSessionId: id,
          files: ["main", "references"].map((file) => ({
            id: `${file}.tex`,
            name: `${file}.tex`,
            relativePath: `${file}.tex`,
            absolutePath: `${root}/${file}.tex`,
            type: "tex",
            content: `Agent ${id.toUpperCase()} proposal`,
            isDirty: false,
          })),
        });
      },
      restoreSourceWorkspace: async () => {
        useDocumentStore.setState({
          agentWorkspaceRoot: null,
          agentWorkspaceSessionId: null,
          files: [],
        });
      },
      addAgentWorkspaceReviewFiles: async () => {},
    });
    useAgentReviewQueueStore.setState({ entries: [] });
    useProposedChangesStore.setState({
      changes: [],
      changesByProject: {},
      workspaceReviewsByProject: {},
      workspaceReview: null,
      activeProjectRoot: projectRoot,
    });
    useAgentChatStore.setState((state) => ({
      activeTabId: "a",
      selectedProvider: "codex",
      tabs: (new URLSearchParams(location.search).has("third")
        ? ["a", "b", "c"]
        : ["a", "b"]
      ).map((id) => ({
        ...state.tabs[0],
        id,
        title: `Agent ${id.toUpperCase()}`,
        provider:
          new URLSearchParams(location.search).get("provider") === "claude"
            ? "claude"
            : "codex",
        isStreaming: true,
        sharedSessionId: id,
        agentWorkspace: { ...session(id), status: "active" },
      })),
      isStreaming: true,
    }));
    setReady(true);
    return () => {
      internal.invoke = original;
    };
  }, []);
  const finish = async (id: string) => {
    const chat = useAgentChatStore.getState();
    chat._setStreaming(id, false);
    chat._setAgentWorkspace(id, session(id));
    await useAgentReviewQueueStore.getState().enqueue(session(id));
  };
  const visibleChange = changes.find(
    (change) => change.workspaceSessionId === workspaceId,
  );
  return (
    <div className="flex min-h-screen flex-col bg-background p-6 text-foreground">
      {ready ? (
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-4">
          <h1 className="font-semibold text-lg">Concurrent agent drafts</h1>
          <ChatTabBar showSessionSelector={false} />
          {new URLSearchParams(location.search).has("compact") && (
            <div data-testid="collapsed-chat">
              <ChatTabBar compact showSessionSelector={false} />
            </div>
          )}
          <div className="flex gap-3">
            {tabs.map((tab) => (
              <button
                className="rounded border px-3 py-2 text-sm"
                type="button"
                key={tab.id}
                onClick={() => void finish(tab.id)}
                disabled={!tab.isStreaming}
              >
                Finish {tab.title}
              </button>
            ))}
          </div>
          <div className="rounded border p-4">
            <span className="text-muted-foreground text-xs">
              Source project
            </span>
            <p data-testid="source-content">{source}</p>
          </div>
          <p
            data-testid="review-queue"
            className="text-muted-foreground text-sm"
          >
            {entries
              .map((entry) => `${entry.session.tabId}: ${entry.phase}`)
              .join(" · ")}
          </p>
          {new URLSearchParams(location.search).has("vibe") && (
            <div data-testid="vibe-pane" className="h-[480px]">
              <ChatWorkspacePane showTabBar={false} />
            </div>
          )}
          <div
            className="rounded-lg border p-4"
            data-testid="active-conversation"
          >
            <h2 className="mb-4 font-medium">
              {tabs.find((tab) => tab.id === activeTabId)?.title}
            </h2>
            <AgentDraftNotice />
            <AgentQuestionPrompt />
            {visibleChange ? (
              <>
                <ProposedChangesPanel
                  change={visibleChange}
                  onKeep={() =>
                    void useProposedChangesStore.getState().keepAll()
                  }
                  onUndo={() =>
                    void useProposedChangesStore.getState().undoAll()
                  }
                />
                <div className="grid grid-cols-2 gap-4 p-4 font-mono text-sm">
                  <pre>{visibleChange.oldContent}</pre>
                  <pre>{visibleChange.newContent}</pre>
                </div>
              </>
            ) : (
              <p className="text-muted-foreground text-sm">
                {entries.find((entry) => entry.session.tabId === activeTabId)
                  ?.phase === "queued"
                  ? "Waiting for the earlier draft to be reviewed."
                  : "Conversation"}
              </p>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
