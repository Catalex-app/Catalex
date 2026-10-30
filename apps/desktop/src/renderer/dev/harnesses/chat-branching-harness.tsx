import { useEffect } from "react";
import { ChatMessages } from "@/components/agent-chat/chat-messages";
import {
  type AgentStreamMessage,
  useAgentChatStore,
} from "@/stores/agent-chat-store";
import { useDocumentStore } from "@/stores/document-store";

function ensureChatBranchingHarnessTauriMocks() {
  if (typeof window === "undefined") return;
  const win = window as Window & {
    __TAURI_INTERNALS__?: {
      invoke?: (cmd: string) => Promise<unknown>;
    };
  };

  win.__TAURI_INTERNALS__ = {
    ...win.__TAURI_INTERNALS__,
    invoke: async (cmd) => {
      if (cmd === "save_shared_session") {
        return {
          shared_session_id: "chat-branching-harness-fork",
          last_modified: 1,
        };
      }
      return null;
    },
  };
}

const HARNESS_MESSAGES: AgentStreamMessage[] = [
  {
    type: "user",
    provider: "codex",
    message: { content: [{ type: "text", text: "First question" }] },
  },
  {
    type: "assistant",
    provider: "codex",
    message: {
      content: [
        {
          type: "text",
          text: "First answer. This is a valid place to start a branch.",
        },
      ],
    },
  },
  {
    type: "user",
    provider: "codex",
    message: { content: [{ type: "text", text: "Second question" }] },
  },
  {
    type: "assistant",
    provider: "codex",
    message: {
      content: [
        {
          type: "text",
          text: "Second answer. The original chat continues here.",
        },
      ],
    },
  },
];

export function ChatBranchingHarness() {
  ensureChatBranchingHarnessTauriMocks();

  useEffect(() => {
    useDocumentStore.setState({
      projectRoot: "/tmp/chat-branching-harness",
      files: [],
      folders: [],
      activeFileId: undefined,
      openFileIds: [],
      initialized: true,
    });
    useAgentChatStore.setState((state) => {
      const sourceTab = {
        ...state.tabs[0],
        id: "chat-branching-source",
        title: "Original chat",
        provider: "codex" as const,
        sessionId: "source-runtime",
        sharedSessionId: "source-shared-session",
        providerSessionIds: { codex: "source-runtime" },
        providerSyncCursors: { codex: 4 },
        messages: HARNESS_MESSAGES,
        isStreaming: false,
      };
      return {
        tabs: [sourceTab],
        activeTabId: sourceTab.id,
        selectedProvider: "codex",
        messages: HARNESS_MESSAGES,
        sessionId: sourceTab.sessionId,
        isStreaming: false,
        error: null,
      };
    });
  }, []);

  const tabs = useAgentChatStore((state) => state.tabs);
  const activeTabId = useAgentChatStore((state) => state.activeTabId);
  const activeTab = tabs.find((tab) => tab.id === activeTabId);

  return (
    <div
      data-testid="chat-branching-harness-shell"
      className="flex h-screen items-center justify-center bg-muted/30 p-6 text-foreground"
    >
      <div className="flex h-full w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-border bg-background shadow-sm">
        <div className="flex items-center justify-between border-border border-b px-4 py-3">
          <div>
            <div className="font-semibold text-sm">Chat branching harness</div>
            <div className="text-muted-foreground text-xs">
              Fork actions appear once at the end of each completed answer
            </div>
          </div>
          <div className="text-right text-xs">
            <div data-testid="active-chat-title">{activeTab?.title}</div>
            <div data-testid="chat-tab-count" className="text-muted-foreground">
              {tabs.length} {tabs.length === 1 ? "chat" : "chats"}
            </div>
          </div>
        </div>
        <div className="relative min-h-0 flex-1">
          <ChatMessages />
        </div>
      </div>
    </div>
  );
}
