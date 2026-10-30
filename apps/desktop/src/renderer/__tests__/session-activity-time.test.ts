import { afterEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@/lib/desktop/core";
import {
  tabFromSharedSession,
  useAgentChatStore,
} from "@/stores/agent-chat-store";
import { useDocumentStore } from "@/stores/document-store";

const initialChat = useAgentChatStore.getState();
const initialDocuments = useDocumentStore.getState();
afterEach(() => {
  useAgentChatStore.setState(initialChat, true);
  useDocumentStore.setState(initialDocuments, true);
  vi.restoreAllMocks();
  vi.mocked(invoke).mockReset();
});

describe.each(["claude", "codex"] as const)("%s activity time", (provider) => {
  it("preserves restored time through cleanup and advances it only for live activity", async () => {
    vi.spyOn(Date, "now").mockReturnValue(500_000);
    const tab = tabFromSharedSession({
      shared_session_id: "old-chat",
      title: "Earlier chat",
      last_modified: 200,
      last_provider: provider,
      provider_session_ids: {},
      messages: [
        { type: "system", subtype: "init" },
        {
          type: "assistant",
          message: {
            content: [{ type: "text", text: "Image: file:///tmp/result.png" }],
          },
        },
      ],
    });
    expect(tab.messages).toHaveLength(1);
    expect(tab.messages[0].message?.content).toHaveLength(2);
    expect(tab.lastActivityAt).toBe(200);
    useDocumentStore.setState({ projectRoot: "/tmp/activity-test" });
    useAgentChatStore.setState({
      tabs: [tab],
      activeTabId: tab.id,
      messages: tab.messages,
    });
    vi.mocked(invoke).mockResolvedValue({
      shared_session_id: "old-chat",
      last_modified: 200,
    });
    await useAgentChatStore.getState()._syncSharedSession(tab.id);
    expect(invoke).toHaveBeenLastCalledWith(
      "save_shared_session",
      expect.objectContaining({ lastActivityAt: 200 }),
    );
    useAgentChatStore
      .getState()
      ._appendMessage(tab.id, { type: "system", subtype: "init" });
    expect(useAgentChatStore.getState().tabs[0].lastActivityAt).toBe(200);
    useAgentChatStore.getState()._appendMessage(tab.id, {
      type: "assistant",
      message: { content: [{ type: "text", text: "New reply" }] },
    });
    expect(useAgentChatStore.getState().tabs[0].lastActivityAt).toBe(500);
    // Saving much later records the activity time, not checkpoint time.
    vi.mocked(Date.now).mockReturnValue(900_000);
    await useAgentChatStore.getState()._syncSharedSession(tab.id);
    expect(invoke).toHaveBeenLastCalledWith(
      "save_shared_session",
      expect.objectContaining({ lastActivityAt: 500 }),
    );
  });
});
