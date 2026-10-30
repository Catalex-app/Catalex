import { describe, expect, it } from "vitest";
import { readAgentContextUsage } from "./agent-context-usage";

describe("response context usage", () => {
  it("reads Pi response usage and leaves unreported capacity unknown", () => {
    expect(
      readAgentContextUsage("pi", {
        type: "usage",
        tokens: 120,
        capacity: 1000,
        model: "model",
      }),
    ).toEqual({ tokens: 120, capacity: 1000, model: "model" });
    expect(readAgentContextUsage("pi", { type: "usage", tokens: 0 })).toEqual({
      tokens: 0,
      capacity: null,
    });
    for (const tokens of [undefined, -1, NaN, Infinity, "120"]) {
      expect(
        readAgentContextUsage("pi", { type: "usage", tokens }),
      ).toBeUndefined();
    }
    expect(
      readAgentContextUsage("pi", { type: "session", tokens: 120 }),
    ).toBeUndefined();
  });

  it("uses the latest Codex snapshot, not cumulative usage or cached tokens twice", () => {
    expect(
      readAgentContextUsage("codex", {
        method: "thread/tokenUsage/updated",
        params: {
          tokenUsage: {
            last: { totalTokens: 120, cachedInputTokens: 80 },
            total: { totalTokens: 99999 },
            modelContextWindow: 1000,
          },
        },
      }),
    ).toEqual({ tokens: 120, capacity: 1000 });
  });

  it("includes Claude cached input and output once, and permits compaction decreases", () => {
    const event = {
      type: "assistant",
      message: {
        model: "opus",
        usage: {
          input_tokens: 10,
          cache_read_input_tokens: 20,
          cache_creation_input_tokens: 30,
          output_tokens: 5,
        },
      },
    };
    expect(
      readAgentContextUsage("claude", event, {
        tokens: 900,
        capacity: 1000,
        model: "opus",
      }),
    ).toEqual({ tokens: 65, capacity: 1000, model: "opus" });
    expect(
      readAgentContextUsage("claude", {
        ...event,
        parent_tool_use_id: "subagent",
      }),
    ).toBeUndefined();
  });

  it("reads only the matching result capacity, never cumulative result tokens", () => {
    const previous = { tokens: 65, capacity: null, model: "opus" };
    expect(
      readAgentContextUsage(
        "claude",
        {
          type: "result",
          usage: { input_tokens: 9999 },
          modelUsage: {
            opus: { contextWindow: 1000 },
            haiku: { contextWindow: 2000 },
          },
        },
        previous,
      ),
    ).toEqual({ ...previous, capacity: 1000 });
    expect(
      readAgentContextUsage(
        "claude",
        { type: "result", modelUsage: { haiku: { contextWindow: 2000 } } },
        previous,
      ),
    ).toBeUndefined();
  });

  it("does not invent missing capacities or accept invalid counts", () => {
    expect(
      readAgentContextUsage("codex", {
        method: "thread/tokenUsage/updated",
        params: { tokenUsage: { last: { totalTokens: 0 } } },
      }),
    ).toEqual({ tokens: 0, capacity: null });
    for (const tokens of [undefined, -1, NaN, Infinity, "120"]) {
      expect(
        readAgentContextUsage("codex", {
          method: "thread/tokenUsage/updated",
          params: { tokenUsage: { last: { totalTokens: tokens } } },
        }),
      ).toBeUndefined();
    }
  });
});
