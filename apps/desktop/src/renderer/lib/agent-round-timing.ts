import type { AgentStreamMessage } from "@/stores/agent-chat-store";

export interface AgentRoundTiming {
  elapsedMs: number;
  runningSince: number | null;
  /** Absolute transcript index of the prompt that began this round. */
  startIndex: number;
  waitingFor: string[];
  /** This execution stopped, regardless of success, cancellation, or error. */
  finished?: boolean;
}

export function roundElapsed(timing: AgentRoundTiming, now = Date.now()) {
  return (
    timing.elapsedMs +
    (timing.runningSince === null ? 0 : Math.max(0, now - timing.runningSince))
  );
}

export function freezeRound(
  timing: AgentRoundTiming,
  now = Date.now(),
): AgentRoundTiming {
  return {
    ...timing,
    elapsedMs: roundElapsed(timing, now),
    runningSince: null,
  };
}

export function formatRoundDuration(ms: number) {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m ${seconds % 60}s`;
}

/** Match the last answer actually displayed, including Claude's duplicate result. */
export function stampRoundDuration(
  messages: AgentStreamMessage[],
  start: number,
  elapsedMs: number,
  completedAt = Date.now(),
): AgentStreamMessage[] {
  const assistantTexts = new Set(
    messages.flatMap((message) =>
      message.type === "assistant"
        ? (message.message?.content ?? []).flatMap((block) =>
            block.type === "text" && block.text ? [block.text.trim()] : [],
          )
        : [],
    ),
  );
  for (let index = messages.length - 1; index >= Math.max(0, start); index--) {
    const message = messages[index];
    const answer =
      message.type === "assistant"
        ? message.message?.content?.some(
            (block) =>
              (block.type === "text" && block.text) ||
              (block.type === "image" && block.imageDataUrl) ||
              block.type === "tool_use" ||
              block.type === "thinking",
          )
        : message.type === "result" &&
          (message.errors?.length ||
            (message.result && !assistantTexts.has(message.result.trim())));
    if (answer)
      return messages.map((item, i) =>
        i === index
          ? {
              ...item,
              roundDurationMs: elapsedMs,
              roundCompletedAt: completedAt,
            }
          : item,
      );
  }
  // Even a stop before the first output needs a durable transcript entry.
  return [
    ...messages,
    {
      type: "result",
      subtype: "round_stopped",
      roundDurationMs: elapsedMs,
      roundCompletedAt: completedAt,
    },
  ];
}
