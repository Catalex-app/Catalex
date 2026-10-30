export interface TranscriptMessage {
  type: string;
  provider?: string;
  result?: string;
  message?: { content?: Array<{ type: string; text?: string; name?: string }> };
}

function getTranscriptText(msg: TranscriptMessage): string | null {
  if (msg.type === "result") {
    if (typeof msg.result === "string" && msg.result.trim()) {
      return msg.result.trim();
    }
    return null;
  }

  if (msg.type !== "user" && msg.type !== "assistant") return null;

  const blocks = msg.message?.content ?? [];
  const textParts = blocks
    .map((block) => {
      if (block.type === "text") return block.text?.trim() ?? "";
      if (block.type === "thinking") return "";
      if (block.type === "tool_use" && block.name)
        return `[tool use: ${block.name}]`;
      return "";
    })
    .filter((part) => part.length > 0);

  if (textParts.length === 0) return null;
  return textParts.join("\n");
}

export function buildTranscriptEntries(
  messages: TranscriptMessage[],
): string[] {
  return messages
    .map((msg) => {
      const body = getTranscriptText(msg);
      if (!body) return null;
      const role =
        msg.type === "assistant" || msg.type === "result"
          ? msg.provider === "claude"
            ? "Claude"
            : msg.provider === "codex"
              ? "Codex"
              : msg.provider === "pi"
                ? "Pi"
                : "Assistant"
          : "User";
      return `${role}: ${body}`;
    })
    .filter((entry): entry is string => entry !== null);
}

export function handoffMessageCount(messages: TranscriptMessage[]): number {
  return buildTranscriptEntries(messages).length;
}

export function buildCrossProviderTranscript(
  messages: TranscriptMessage[],
  syncedMessageCount = 0,
): string {
  const entries = buildTranscriptEntries(messages);
  const safeCursor = Math.max(0, Math.min(syncedMessageCount, entries.length));
  return entries.slice(safeCursor).join("\n\n");
}
