import { describe, expect, it } from "vitest";
import type {
  AgentStreamMessage,
  ContentBlock,
  TabState,
} from "@/stores/agent-chat-store";
import { collapsedStatus, latestAssistantSummary } from "./collapsed-status";
import { toolTitle } from "./tool-title";

const msg = (
  type: AgentStreamMessage["type"],
  ...content: ContentBlock[]
): AgentStreamMessage => ({ type, message: { content } });
const text = (text: string): ContentBlock => ({ type: "text", text });
const tool: ContentBlock = {
  type: "tool_use",
  id: "read-1",
  name: "Read",
  input: { file_path: "paper.tex" },
};

describe("collapsed chat status", () => {
  it("shows provider status ahead of old text, but errors take priority", () => {
    const tab = {
      messages: [msg("assistant", text("Old progress"))],
      isStreaming: true,
      providerStatus: "compacting",
    } as TabState;
    expect(collapsedStatus(tab).text).toBe("Compacting...");
    expect(
      collapsedStatus({
        ...tab,
        providerStatus: "retrying",
      }).text,
    ).toBe("Retrying...");
    expect(collapsedStatus({ ...tab, error: "Failed" }).text).toBe("Failed");
    expect(collapsedStatus({ ...tab, isStreaming: false }).text).toBe(
      "Old progress",
    );
  });
  it("does not leak the previous answer into a new prompt", () => {
    const messages = [
      msg("assistant", text("Old answer")),
      { type: "result", result: "Old answer" } as AgentStreamMessage,
      msg("user", text("New question")),
    ];
    expect(latestAssistantSummary(messages)).toBeNull();
    expect(
      collapsedStatus({ messages, isStreaming: true } as TabState),
    ).toEqual({ text: "Working...", state: "streaming" });
  });
  it("uses the absolute round boundary when history is windowed", () => {
    expect(
      collapsedStatus({
        messages: [msg("assistant", text("Previous round"))],
        isStreaming: true,
        history: { start: 40 },
        roundTiming: { startIndex: 41 },
      } as TabState).text,
    ).toBe("Working...");
  });
  it("shows the most recent block rather than always preferring tools", () => {
    expect(
      latestAssistantSummary([
        msg("assistant", tool, text("Read complete.\nWriting now.")),
      ]),
    ).toBe("Read complete. Writing now.");
    expect(
      latestAssistantSummary([msg("assistant", text("Checking"), tool)]),
    ).toBe("Reading paper.tex");
    expect(
      latestAssistantSummary([
        msg("assistant", tool, { type: "thinking", thinking: "Plan" }),
      ]),
    ).toBe("Working...");
  });
  it("matches results through user envelopes without treating them as prompts", () => {
    expect(
      latestAssistantSummary([
        msg("assistant", tool),
        msg("user", {
          type: "tool_result",
          tool_use_id: "read-1",
          content: "file contents",
        }),
      ]),
    ).toBe("Read paper.tex");
  });
  it("preserves completion, error, and empty states", () => {
    expect(collapsedStatus(undefined).state).toBe("idle");
    expect(
      collapsedStatus({
        messages: [],
        isStreaming: false,
      } as unknown as TabState).text,
    ).toBe("Ready");
    expect(
      collapsedStatus({ messages: [], error: "Failed" } as unknown as TabState),
    ).toEqual({ text: "Failed", state: "error" });
    expect(
      latestAssistantSummary([
        { type: "result", result: "Final answer" } as AgentStreamMessage,
      ]),
    ).toBe("Final answer");
  });
  it.each([
    ["Write", { file_path: "a.tex" }, "Writing a.tex"],
    ["MultiEdit", { file_path: "a.tex" }, "Editing a.tex"],
    ["Glob", { pattern: "*.tex" }, "Searching *.tex"],
    ["Grep", { pattern: "abstract" }, "Grepping abstract"],
    ["Bash", { command: "pnpm test" }, "$ pnpm test"],
    [
      "TodoWrite",
      { todos: [{ status: "completed" }, { status: "pending" }] },
      "Todos (1/2)",
    ],
    ["mcp__search", {}, "Running mcp__search"],
  ])("uses the shared %s title", (name, input, expected) => {
    const title = toolTitle({ type: "tool_use", name, input });
    expect(`${title.label} ${title.detail}`.trim()).toBe(expected);
  });
});
