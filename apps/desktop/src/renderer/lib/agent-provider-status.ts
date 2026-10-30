function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

export function readCodexProviderStatus(
  value: unknown,
): string | null | undefined {
  const message = record(value);
  if (
    message?.type === "provider_status" &&
    (typeof message.status === "string" || message.status === null)
  )
    return message.status;
  return undefined;
}

export function claudeProviderStatus(
  value: unknown,
): string | null | undefined {
  const message = record(value);
  if (
    !message ||
    message.parent_tool_use_id != null ||
    message.agent_id != null
  )
    return undefined;
  if (message.type === "system") {
    if (
      message.subtype === "status" &&
      (typeof message.status === "string" || message.status === null)
    )
      return message.status;
    if (message.subtype === "api_retry") return "retrying";
    if (message.subtype === "compact_boundary") return null;
  }
  if (
    (message.type === "assistant" && !message.error) ||
    (message.type === "stream_event" &&
      record(message.event)?.type === "message_start") ||
    message.type === "result"
  )
    return null;
  return undefined;
}

export function providerStatusLabel(
  status: string | null | undefined,
): string | null {
  return status
    ? `${status.charAt(0).toUpperCase()}${status.slice(1)}...`
    : null;
}
