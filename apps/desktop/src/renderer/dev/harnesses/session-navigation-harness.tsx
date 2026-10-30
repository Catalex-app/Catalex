import { useEffect, useState } from "react";
import { SessionListPanel } from "@/components/agent-chat/session-list-panel";
import { SessionSelector } from "@/components/agent-chat/session-selector";
import { useAgentChatStore } from "@/stores/agent-chat-store";
import { useDocumentStore } from "@/stores/document-store";
import { ensureDesktopBrowserMocks } from "../desktop-browser-mocks";

ensureDesktopBrowserMocks();

export function SessionNavigationHarness() {
  const [ready, setReady] = useState(false);
  const [calls, setCalls] = useState<string[]>([]);
  const tabs = useAgentChatStore((state) => state.tabs);
  const activeTabId = useAgentChatStore((state) => state.activeTabId);
  const activeTab = tabs.find((tab) => tab.id === activeTabId);
  const backgroundTab = tabs.find((tab) => tab.id === "working-tab");

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const paused = params.get("paused") === "true";
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
    const sessions = [
      {
        shared_session_id: "working-session",
        title: "Background review",
        archived: false,
      },
      {
        shared_session_id: "saved-session",
        title: "Saved conversation",
        archived: false,
      },
      {
        shared_session_id: "archived-session",
        title: "Archived conversation",
        archived: true,
      },
    ].map((session) => ({
      ...session,
      last_provider: "codex",
      last_modified: Date.now() / 1000,
    }));
    internal.invoke = async (cmd, args = {}) => {
      if (cmd === "list_shared_sessions")
        return [...sessions].sort((a, b) => b.last_modified - a.last_modified);
      if (cmd === "save_shared_session") {
        const session = sessions.find(
          (item) => item.shared_session_id === args.sharedSessionId,
        );
        if (!session) throw new Error("Unknown harness session");
        session.last_modified = Math.max(
          session.last_modified,
          Number(args.lastActivityAt ?? 0),
        );
        return { ...session };
      }
      if (cmd === "load_shared_session") {
        setCalls((current) => [
          ...current,
          `${cmd}:${String(args.sharedSessionId)}`,
        ]);
        return {
          ...sessions.find(
            (session) => session.shared_session_id === args.sharedSessionId,
          ),
          messages: [
            {
              type: "user",
              message: {
                content: [{ type: "text", text: "Earlier conversation" }],
              },
            },
          ],
        };
      }
      if (/^(dispose|cancel)_/.test(cmd)) {
        setCalls((current) => [...current, `${cmd}:${String(args.tabId)}`]);
        return;
      }
      return original(cmd, args);
    };
    useDocumentStore.setState({
      projectRoot: "/session-navigation-project",
      files: [],
      folders: [],
      initialized: true,
      activeFileId: undefined,
      agentWorkspaceRoot: null,
    });
    useAgentChatStore.setState((state) => {
      const tab = {
        ...state.tabs[0],
        id: "working-tab",
        title: "Background review",
        provider: "codex" as const,
        sharedSessionId: "working-session",
        sessionId: "native-working-session",
        isStreaming: !paused,
        pauseState: paused ? ("paused" as const) : null,
        turnPhase: paused ? null : ("running" as const),
        agentWorkspace: {
          version: 2 as const,
          sessionId: "working-draft",
          projectRoot: "/session-navigation-project",
          tabId: "working-tab",
          mode: "ask" as const,
          status: "active" as const,
          createdAt: 1,
          updatedAt: 1,
          sourceCommit: "fixture-source",
          baselineCommit: "fixture-baseline",
          candidateRoot: "/candidate",
          warnings: [],
        },
        messages: [
          {
            type: "user" as const,
            message: {
              content: [
                { type: "text" as const, text: "Review the introduction" },
              ],
            },
          },
        ],
      };
      return {
        tabs: [tab],
        activeTabId: tab.id,
        selectedProvider: tab.provider,
        messages: tab.messages,
        sessionId: tab.sessionId,
        isStreaming: tab.isStreaming,
        error: null,
      };
    });
    setReady(true);
    return () => {
      internal.invoke = original;
    };
  }, []);

  return (
    <div className="flex min-h-screen gap-8 bg-background p-8 text-foreground">
      {ready ? (
        <>
          <aside
            className="w-80 rounded-lg border p-3"
            data-testid="vibe-sessions"
          >
            <SessionListPanel />
          </aside>
          <main className="w-96 space-y-6">
            <div className="flex items-center justify-between rounded-lg border p-3">
              <span>Duet session history</span>
              <SessionSelector />
            </div>
            <div className="space-y-2 rounded-lg border p-4">
              <p data-testid="active-title">{activeTab?.title}</p>
              <p data-testid="tab-count">{tabs.length} tabs</p>
              <p data-testid="background-state">
                {backgroundTab?.isStreaming
                  ? "running"
                  : (backgroundTab?.pauseState ?? "idle")}
              </p>
              <p data-testid="background-draft">
                {backgroundTab?.agentWorkspace?.sessionId}
              </p>
              <p data-testid="background-messages">
                {backgroundTab?.messages.length} messages
              </p>
              <p data-testid="visible-messages">
                {activeTab?.messages.length} messages
              </p>
            </div>
            <button
              type="button"
              onClick={() =>
                useAgentChatStore.getState()._appendMessage("working-tab", {
                  type: "assistant",
                  message: {
                    content: [{ type: "text", text: "Background progress" }],
                  },
                })
              }
            >
              Simulate background response
            </button>
            <button
              type="button"
              onClick={() =>
                useAgentChatStore.getState()._setStreaming("working-tab", false)
              }
            >
              Finish background run
            </button>
            <button
              type="button"
              onClick={() =>
                void useAgentChatStore
                  .getState()
                  ._syncSharedSession("working-tab")
              }
            >
              Save background chat
            </button>
            <pre data-testid="native-calls" className="text-xs">
              {calls.join("\n")}
            </pre>
          </main>
        </>
      ) : null}
    </div>
  );
}
