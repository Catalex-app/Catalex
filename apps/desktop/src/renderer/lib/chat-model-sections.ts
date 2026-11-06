import type {
  AgentStreamMessage,
  ChatProvider,
} from "@/stores/agent-chat-store";
import { formatClaudeModelName } from "./claude-models";
import { codexEffortLabel, formatCodexModelName } from "./codex-models";
import { piModelLabel } from "./pi-models";

type Settings = {
  provider: ChatProvider;
  model?: string;
  reasoningEffort?: string;
};

function promptSettings(message: AgentStreamMessage): Settings | undefined {
  if (
    message.type !== "user" ||
    message.subtype === "question_answer" ||
    !message.provider
  )
    return;
  const content = message.message?.content;
  if (content?.length && content.every((block) => block.type === "tool_result"))
    return;
  return {
    provider: message.provider,
    model: message.model,
    reasoningEffort: message.reasoningEffort,
  };
}

function sameSettings(a: Settings, b: Settings) {
  return (
    a.provider === b.provider &&
    a.model === b.model &&
    a.reasoningEffort === b.reasoningEffort
  );
}

export function startsChatModelSection(
  messages: AgentStreamMessage[],
  next: Settings,
  retry = false,
) {
  for (let index = messages.length - 1; index >= 0; index--) {
    const previous = promptSettings(messages[index]);
    if (!previous) continue;
    if (retry) {
      retry = false;
      continue;
    }
    return !sameSettings(previous, next);
  }
  return true;
}

export function chatModelSectionLabels(
  messages: AgentStreamMessage[],
  historyStart = 0,
) {
  let previous: Settings | undefined;
  return messages.map((message) => {
    const settings = promptSettings(message);
    if (!settings) return undefined;
    // Stored boundaries stay stable when older transcript pages are unloaded.
    // For older chats, infer only boundaries whose previous prompt is available.
    const starts =
      message.startsModelSection ??
      (previous ? !sameSettings(previous, settings) : historyStart === 0);
    previous = settings;
    if (!starts) return undefined;
    const provider =
      settings.provider === "claude"
        ? "Claude"
        : settings.provider === "codex"
          ? "Codex"
          : "Pi";
    const model = settings.model
      ? settings.provider === "claude"
        ? formatClaudeModelName(settings.model)
        : settings.provider === "codex"
          ? formatCodexModelName(settings.model)
          : piModelLabel(settings.model)
      : undefined;
    return [
      provider,
      model,
      settings.reasoningEffort
        ? codexEffortLabel(settings.reasoningEffort)
        : undefined,
    ]
      .filter(Boolean)
      .join(" · ");
  });
}
