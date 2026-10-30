import {
  restoreProjectChats,
  subscribeProjectChats,
} from "@/lib/project-chat-lifecycle";
import { useEffect, useState } from "react";
import { ChatComposer } from "@/components/agent-chat/chat-composer";
import { ChatMessages } from "@/components/agent-chat/chat-messages";
import { useAgentEvents } from "@/hooks/use-agent-events";
import { useAgentChatStore } from "@/stores/agent-chat-store";
import { useClaudeSetupStore } from "@/stores/claude-setup-store";
import { useCodexSetupStore } from "@/stores/codex-setup-store";
import { useDocumentStore } from "@/stores/document-store";
import { useHistoryStore } from "@/stores/history-store";
import { useSettingsStore } from "@/stores/settings-store";
import { cn } from "@/lib/utils";
import { ensureDesktopBrowserMocks } from "../desktop-browser-mocks";

ensureDesktopBrowserMocks();

(
  window as Window & { __agentPauseChatStore?: typeof useAgentChatStore }
).__agentPauseChatStore = useAgentChatStore;

export function AgentPauseHarness() {
  const [calls, setCalls] = useState<string[]>([]);
  const [expanded, setExpanded] = useState(true);
  const [dark, setDark] = useState(false);
  const projectRoot = useDocumentStore((state) => state.projectRoot);
  const leaving = useAgentChatStore((state) => state.isLeavingProject);
  const tabs = useAgentChatStore((state) => state.tabs);
  const activeTabId = useAgentChatStore((state) => state.activeTabId);
  const tab = tabs.find((item) => item.id === activeTabId);
  useEffect(() => {
    const provider: "claude" | "codex" =
      new URLSearchParams(location.search).get("provider") === "claude"
        ? "claude"
        : "codex";
    const workspace = {
      version: 2 as const,
      sessionId: "pause-draft",
      projectRoot: "/pause-project",
      tabId: "pause-tab",
      mode: "ask" as const,
      status: "active" as const,
      createdAt: 1,
      updatedAt: 1,
      sourceCommit: "fixture-source",
      baselineCommit: "fixture-baseline",
      candidateRoot: "/pause-candidate",
      warnings: [],
    };
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
      if (cmd === "inspect_paused_workspace")
        return { changed: false, revision: "unchanged", changes: [] };
      if (cmd.startsWith("cancel_")) {
        setCalls((current) => [...current, `${cmd} (${String(args.tabId)})`]);
        setTimeout(() => {
          void original("plugin:event|emit", {
            event: `${provider}-complete`,
            payload: { tab_id: args.tabId, success: false },
          });
        }, 800);
        return;
      }
      if (/^(execute|resume)_(claude|codex)_code$/.test(cmd)) {
        setCalls((current) => [
          ...current,
          `${cmd} (${String(args.sessionId ?? "new")})`,
        ]);
        await new Promise((resolve) => setTimeout(resolve, 150));
        return;
      }
      if (cmd === "save_shared_session")
        return { shared_session_id: "pause-shared" };
      if (cmd === "prepare_agent_workspace") return workspace;
      if (cmd === "reconcile_agent_workspace")
        return { session: { ...workspace, status: "cancelled" }, changes: [] };
      return original(cmd, args);
    };
    useDocumentStore.setState({
      projectRoot: workspace.projectRoot,
      files: [],
      folders: [],
      initialized: true,
      activeFileId: undefined,
      agentWorkspaceSessionId: workspace.sessionId,
      agentWorkspaceRoot: workspace.candidateRoot,
      refreshFiles: async () => {},
      saveAllFiles: async () => {},
      activateAgentWorkspace: async () => {},
    });
    useHistoryStore.setState({ createSnapshot: async () => null });
    useSettingsStore.setState({ globalAgentPrompt: "" });
    useClaudeSetupStore.setState({
      status: "ready",
      modelsStatus: "ready",
      models: [
        {
          value: "opus",
          displayName: "Opus",
          description: "Harness",
          supportedEffortLevels: ["medium"],
        },
      ],
    });
    useCodexSetupStore.setState({
      status: "ready",
      modelsStatus: "ready",
      models: [
        {
          model: "gpt-5.6-sol",
          display_name: "GPT-5.6 Sol",
          description: "Harness",
          supported_reasoning_efforts: [
            { value: "medium", description: "Balanced" },
          ],
          default_reasoning_effort: "medium",
          is_default: true,
        },
      ],
    });
    const saved = localStorage.getItem("catalex-project-chats:/pause-project");
    if (saved) void restoreProjectChats("/pause-project");
    else
      useAgentChatStore.setState((state) => {
        const current = {
          ...state.tabs[0],
          id: workspace.tabId,
          provider,
          sessionId: "native-session",
          providerSessionIds: { [provider]: "native-session" },
          sharedSessionId: "pause-shared",
          isStreaming: true,
          turnPhase: "running" as const,
          pauseState: null,
          agentWorkspace: workspace,
          messages: [
            {
              type: "user" as const,
              provider,
              message: {
                content: [
                  {
                    type: "text" as const,
                    text: "Review the introduction and improve its clarity.",
                  },
                ],
              },
            },
            {
              type: "assistant" as const,
              provider,
              message: {
                content: [
                  {
                    type: "text" as const,
                    text: "I’m reviewing the introduction. Stop ends this turn; closing the project saves it as paused.",
                  },
                ],
              },
            },
          ],
        };
        return {
          chatProjectRoot: workspace.projectRoot,
          tabs: [current],
          activeTabId: current.id,
          selectedProvider: provider,
          selectedCodexModel: "gpt-5.6-sol",
          selectedCodexReasoningEffort: "medium",
          selectedClaudeModel: "opus",
          messages: current.messages,
          isStreaming: true,
        };
      });
    const unsubscribe = subscribeProjectChats(console.error);
    return () => {
      unsubscribe();
      internal.invoke = original;
    };
  }, []);
  useAgentEvents();

  return (
    <div
      className={cn(
        "flex h-screen flex-col items-center gap-4 bg-background p-6 text-foreground",
        dark && "dark",
      )}
    >
      <div className="flex items-center gap-4 text-sm">
        <strong>Stop / Pause / Continue · {tab?.provider}</strong>
        {projectRoot ? (
          <button
            disabled={leaving}
            onClick={() => void useDocumentStore.getState().closeProject()}
          >
            {leaving ? "Pausing and saving…" : "Back to welcome"}
          </button>
        ) : (
          <button
            onClick={async () => {
              await restoreProjectChats("/pause-project");
              useDocumentStore.setState({
                projectRoot: "/pause-project",
                initialized: true,
              });
            }}
          >
            Reopen project
          </button>
        )}
        <button onClick={() => setExpanded(!expanded)}>Toggle layout</button>
        <button onClick={() => setDark(!dark)}>Toggle theme</button>
        <span data-testid="pause-status">
          {tab?.pauseState ??
            (tab?.cancelledByUser
              ? "stopping"
              : tab?.isStreaming
                ? "working"
                : "idle")}
        </span>
      </div>
      {projectRoot ? (
        <div className="flex min-h-0 w-full max-w-xl flex-1 flex-col overflow-hidden rounded-xl border border-border">
          <div className="relative min-h-0 flex-1">
            <ChatMessages />
          </div>
          <ChatComposer isExpanded={expanded} />
        </div>
      ) : (
        <div data-testid="welcome">Welcome · Your chats are saved</div>
      )}
      <div
        className="w-full max-w-xl text-muted-foreground text-xs"
        data-testid="provider-calls"
      >
        {calls.join(" → ") || "No interrupt sent yet"}
      </div>
    </div>
  );
}
