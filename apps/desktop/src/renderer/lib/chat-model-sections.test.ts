import { describe, expect, it } from "vitest";
import type { AgentStreamMessage } from "@/stores/agent-chat-store";
import {
  chatModelSectionLabels,
  startsChatModelSection,
} from "./chat-model-sections";

const prompt = (
  patch: Partial<AgentStreamMessage> = {},
): AgentStreamMessage => ({
  type: "user",
  provider: "codex",
  model: "gpt-6.1-sol",
  reasoningEffort: "high",
  message: { content: [{ type: "text", text: "Hello" }] },
  ...patch,
});

describe("chat model sections", () => {
  it("labels the first prompt and each provider, model, or effort change", () => {
    const messages = [
      prompt(),
      prompt(),
      prompt({ reasoningEffort: "low" }),
      prompt({ model: "gpt-6.1", reasoningEffort: "low" }),
      prompt({ provider: "claude", model: "claude-sonnet-4-6" }),
    ];
    expect(chatModelSectionLabels(messages)).toEqual([
      "Codex · GPT-6.1-Sol · High",
      undefined,
      "Codex · GPT-6.1-Sol · Low",
      "Codex · GPT-6.1 · Low",
      "Claude · Sonnet 4.6 · High",
    ]);
  });

  it("ignores tool results, question answers, and response model aliases", () => {
    const messages = [
      prompt(),
      prompt({ type: "assistant", model: "resolved-model" }),
      prompt({ subtype: "question_answer", reasoningEffort: "low" }),
      prompt({
        message: { content: [{ type: "tool_result", tool_use_id: "tool" }] },
      }),
      prompt(),
    ];
    expect(chatModelSectionLabels(messages).filter(Boolean)).toEqual([
      "Codex · GPT-6.1-Sol · High",
    ]);
    expect(
      startsChatModelSection(messages, {
        provider: "codex",
        model: "gpt-6.1-sol",
        reasoningEffort: "high",
      }),
    ).toBe(false);
  });

  it("keeps stored boundaries stable across pages and does not invent an older page boundary", () => {
    expect(
      chatModelSectionLabels([prompt({ startsModelSection: false })], 500),
    ).toEqual([undefined]);
    expect(
      chatModelSectionLabels([prompt({ startsModelSection: true })], 500),
    ).toEqual(["Codex · GPT-6.1-Sol · High"]);
    expect(chatModelSectionLabels([prompt()], 500)).toEqual([undefined]);
    expect(
      chatModelSectionLabels([
        prompt({ model: undefined, reasoningEffort: undefined }),
      ]),
    ).toEqual(["Codex"]);
  });

  it("compares a retried prompt to the preceding exchange", () => {
    const settings = {
      provider: "codex" as const,
      model: "gpt-6.1-sol",
      reasoningEffort: "high",
    };
    expect(startsChatModelSection([prompt()], settings, true)).toBe(true);
    expect(
      startsChatModelSection(
        [prompt(), prompt({ reasoningEffort: "low" })],
        settings,
        true,
      ),
    ).toBe(false);
  });
});
