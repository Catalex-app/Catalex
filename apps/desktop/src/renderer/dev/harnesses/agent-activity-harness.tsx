import { useEffect } from "react";
import { ChatComposer } from "@/components/agent-chat/chat-composer";
import { ChatMessages } from "@/components/agent-chat/chat-messages";
import {
  type AgentStreamMessage,
  useAgentChatStore,
} from "@/stores/agent-chat-store";
import { useClaudeSetupStore } from "@/stores/claude-setup-store";
import {
  type CodexModelInfo,
  useCodexSetupStore,
} from "@/stores/codex-setup-store";
import { useDocumentStore } from "@/stores/document-store";

const HARNESS_MODELS: CodexModelInfo[] = [
  {
    model: "gpt-5.6-sol",
    display_name: "GPT-5.6 Sol",
    description: "Frontier agentic coding model",
    supported_reasoning_efforts: [
      { value: "low", description: "Fast responses" },
      { value: "medium", description: "Balanced reasoning" },
      { value: "high", description: "Deeper reasoning" },
      { value: "xhigh", description: "Extra-high reasoning" },
      { value: "max", description: "Maximum reasoning" },
      { value: "ultra", description: "Ultra reasoning" },
    ],
    default_reasoning_effort: "medium",
    is_default: true,
  },
  {
    model: "gpt-5.6-terra",
    display_name: "GPT-5.6 Terra",
    description: "Balanced model for everyday work",
    supported_reasoning_efforts: [
      { value: "low", description: "Fast responses" },
      { value: "medium", description: "Balanced reasoning" },
      { value: "high", description: "Deeper reasoning" },
    ],
    default_reasoning_effort: "medium",
    is_default: false,
  },
  {
    model: "gpt-5.4-mini",
    display_name: "GPT-5.4 Mini",
    description: "Fast, efficient coding model",
    supported_reasoning_efforts: [
      { value: "low", description: "Fast responses" },
      { value: "medium", description: "Balanced reasoning" },
      { value: "high", description: "Deeper reasoning" },
    ],
    default_reasoning_effort: "medium",
    is_default: false,
  },
];

function ensureAgentActivityHarnessTauriMocks() {
  if (typeof window === "undefined") return;
  const win = window as Window & {
    __TAURI_INTERNALS__?: {
      invoke?: (cmd: string) => Promise<unknown>;
      transformCallback?: (
        callback: (...args: unknown[]) => void,
        once?: boolean,
      ) => number;
      unregisterCallback?: (id: number) => void;
      metadata?: {
        currentWindow?: { label: string };
        currentWebview?: { label: string };
      };
      plugins?: {
        path?: { sep?: string; delimiter?: string };
      };
    };
    __TAURI_EVENT_PLUGIN_INTERNALS__?: {
      unregisterListener: (event: string, eventId: number) => void;
    };
  };

  win.__TAURI_EVENT_PLUGIN_INTERNALS__ ??= {
    unregisterListener: () => {},
  };

  let callbackId = 0;
  let listenerId = 0;
  const callbacks = new Map<number, (...args: unknown[]) => void>();
  win.__TAURI_INTERNALS__ = {
    metadata: {
      currentWindow: { label: "agent-activity-harness" },
      currentWebview: { label: "agent-activity-harness" },
    },
    transformCallback: (callback, once = false) => {
      callbackId += 1;
      const id = callbackId;
      callbacks.set(id, (...args) => {
        callback(...args);
        if (once) callbacks.delete(id);
      });
      return id;
    },
    unregisterCallback: (id) => callbacks.delete(id),
    invoke: async (cmd) => {
      if (cmd === "check_claude_status") {
        return {
          installed: true,
          authenticated: true,
          missing_git: false,
          version: "2.1.0",
          account_email: "harness@example.com",
        };
      }
      if (cmd === "check_codex_status") {
        return {
          installed: true,
          authenticated: true,
          binary_path: "/usr/local/bin/codex",
          version: "0.144.5",
          account_label: "Harness Account",
        };
      }
      if (cmd === "list_codex_models") return HARNESS_MODELS;
      if (cmd === "slash_commands_list") return [];
      if (cmd.includes("listen")) {
        listenerId += 1;
        return listenerId;
      }
      return null;
    },
    plugins: { path: { sep: "/", delimiter: ":" } },
  };
}

export function AgentActivityHarness() {
  ensureAgentActivityHarnessTauriMocks();

  useEffect(() => {
    const userMessage: AgentStreamMessage = {
      type: "user",
      message: {
        content: [
          {
            type: "text",
            text: "Show me what you inspect while answering this question.",
          },
        ],
      },
    };

    useDocumentStore.setState({
      projectRoot: "/tmp/agent-activity-harness",
      files: [],
      folders: [],
      activeFileId: undefined,
      openFileIds: [],
      initialized: true,
    });
    useClaudeSetupStore.setState({ status: "ready" });
    useCodexSetupStore.setState({
      status: "ready",
      version: "0.144.5",
      accountLabel: "Harness Account",
      models: HARNESS_MODELS,
      modelsStatus: "ready",
      modelsError: null,
    });
    useAgentChatStore.setState((state) => ({
      selectedProvider: "codex",
      selectedCodexModel: "gpt-5.6-sol",
      selectedCodexReasoningEffort: "ultra",
      messages: [userMessage],
      isStreaming: false,
      tabs: state.tabs.map((tab) =>
        tab.id === state.activeTabId
          ? {
              ...tab,
              provider: "codex",
              messages: [userMessage],
              isStreaming: false,
            }
          : tab,
      ),
    }));

    const store = useAgentChatStore.getState();
    store._applyActivity(store.activeTabId, {
      kind: "thinking_replace",
      id: "reasoning-1",
      text: "I’ll inspect the relevant files and verify the current behavior.",
    });
    store._applyActivity(store.activeTabId, {
      kind: "tool_started",
      id: "command-1",
      name: "Bash",
      input: { command: "rg -n 'model/list|codex-activity' apps/desktop" },
    });
    store._applyActivity(store.activeTabId, {
      kind: "tool_completed",
      id: "command-1",
      content: "apps/desktop/backend/src/codex.rs: model/list",
      isError: false,
    });
    store._applyActivity(store.activeTabId, {
      kind: "tool_started",
      id: "edit-1",
      name: "Edit",
      input: { file_path: "apps/desktop/backend/src/codex.rs" },
    });
    store._applyActivity(store.activeTabId, {
      kind: "tool_completed",
      id: "edit-1",
      content: "Updated Codex event normalization",
      isError: false,
    });
    store._applyActivity(store.activeTabId, {
      kind: "text_replace",
      id: "answer-1",
      text: "Codex now exposes its reasoning, tool calls, and final answer as one ordered response.",
    });
  }, []);

  return (
    <div
      data-testid="agent-activity-harness-shell"
      className="flex h-screen items-center justify-center bg-muted/30 p-6 text-foreground"
    >
      <div className="flex h-full w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-border bg-background shadow-sm">
        <div className="border-border border-b px-4 py-3">
          <div className="font-semibold text-sm">Agent activity harness</div>
          <div className="text-muted-foreground text-xs">
            Live response blocks and detected Codex models
          </div>
        </div>
        <div className="relative min-h-0 flex-1">
          <ChatMessages />
        </div>
        <div className="border-border border-t">
          <ChatComposer isExpanded />
        </div>
      </div>
    </div>
  );
}
