export type AgentContextUsage = {
  tokens: number;
  capacity: number | null;
  model?: string;
};

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

export function readAgentContextUsage(
  provider: "claude" | "codex" | "pi",
  value: unknown,
  previous?: AgentContextUsage,
): AgentContextUsage | undefined {
  const event = record(value);
  if (provider === "pi") {
    if (event.type !== "usage") return;
    const tokens = count(event.tokens);
    if (tokens === null) return;
    return {
      tokens,
      capacity: count(event.capacity) || null,
      model: typeof event.model === "string" ? event.model : undefined,
    };
  }
  if (provider === "codex") {
    if (event.method !== "thread/tokenUsage/updated") return;
    const usage = record(record(event.params).tokenUsage);
    const tokens = count(record(usage.last).totalTokens);
    if (tokens === null) return;
    return { tokens, capacity: count(usage.modelContextWindow) || null };
  }
  if (event.parent_tool_use_id) return;
  if (event.type === "assistant") {
    const message = record(event.message);
    const usage = record(message.usage);
    const input = count(usage.input_tokens);
    if (input === null) return;
    const model = typeof message.model === "string" ? message.model : undefined;
    return {
      tokens:
        input +
        (count(usage.cache_read_input_tokens) ?? 0) +
        (count(usage.cache_creation_input_tokens) ?? 0) +
        (count(usage.output_tokens) ?? 0),
      capacity: model && model === previous?.model ? previous.capacity : null,
      model,
    };
  }
  if (event.type === "result" && previous?.model) {
    const usage = record(record(event.modelUsage)[previous.model]);
    const capacity = count(usage.contextWindow);
    if (capacity) return { ...previous, capacity };
  }
}
