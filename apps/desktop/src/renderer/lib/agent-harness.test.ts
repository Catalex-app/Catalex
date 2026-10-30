import { describe, expect, it } from "vitest";
import { restoreProviderState } from "./agent-harness";
import { tabFromSharedSession } from "@/stores/agent-chat-store";
import { buildCrossProviderTranscript } from "../../chat-transcript";

describe("harness session restoration", () => {
  it("retains all three native sessions and bounds their handoff cursors", () => {
    expect(
      restoreProviderState(
        { claude: "a", codex: "b", pi: "/pi/c.jsonl" },
        { claude: -1, codex: 99, pi: 2 },
        "pi",
        4,
      ),
    ).toEqual({
      providerSessionIds: { claude: "a", codex: "b", pi: "/pi/c.jsonl" },
      providerSyncCursors: { claude: 0, codex: 4, pi: 2 },
    });
  });
  it("restores a Pi chat and preserves its attribution for cross-harness handoff", () => {
    const tab = tabFromSharedSession({
      shared_session_id: "saved",
      title: "Pi chat",
      last_modified: 123,
      last_provider: "pi",
      provider_session_ids: { pi: "/pi/c.jsonl" },
      messages: [
        {
          type: "assistant",
          provider: "pi",
          message: { content: [{ type: "text", text: "The draft is ready." }] },
        },
      ],
    });
    expect(tab.provider).toBe("pi");
    expect(tab.sessionId).toBe("/pi/c.jsonl");
    expect(tab.providerSyncCursors).toEqual({ pi: 1 });
    expect(buildCrossProviderTranscript(tab.messages)).toBe(
      "Pi: The draft is ready.",
    );
  });
  it("keeps legacy Claude cursor fallback without inventing Pi history", () => {
    expect(restoreProviderState({ claude: "old" }, null, "claude", 3)).toEqual({
      providerSessionIds: { claude: "old" },
      providerSyncCursors: { claude: 3 },
    });
  });
});
