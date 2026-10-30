import type {
  AgentStreamMessage,
  ContentBlock,
  TabState,
} from "@/stores/agent-chat-store";
import { toolTitle } from "./tool-title";
import { providerStatusLabel } from "@/lib/agent-provider-status";

const singleLine = (text: string) => text.replace(/\s+/g, " ").trim();

export function latestAssistantSummary(
  messages: AgentStreamMessage[],
): string | null {
  const results = new Map<string, ContentBlock>();
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.type === "result" && message.result?.trim())
      return singleLine(message.result);
    const blocks = message.message?.content ?? [];
    // Tool-result envelopes are user messages too; only a real prompt is a boundary.
    if (
      message.type === "user" &&
      blocks.some((block) => block.type === "text" || block.type === "image")
    )
      break;
    for (let j = blocks.length - 1; j >= 0; j--) {
      const block = blocks[j];
      if (block.type === "tool_result" && block.tool_use_id)
        results.set(block.tool_use_id, block);
      if (message.type !== "assistant") continue;
      if (block.type === "text" && block.text?.trim())
        return singleLine(block.text);
      if (block.type === "tool_use") {
        const title = toolTitle(
          block,
          block.id ? results.get(block.id) : undefined,
        );
        return singleLine(`${title.label} ${title.detail}`);
      }
      if (block.type === "thinking") return "Working...";
    }
  }
  return null;
}

export function collapsedStatus(tab: TabState | undefined): {
  text: string;
  state: "idle" | "streaming" | "finished" | "error";
} {
  if (!tab) return { text: "No active chat", state: "idle" };
  if (tab.error) return { text: tab.error, state: "error" };
  if (tab.isStreaming) {
    const status = providerStatusLabel(tab.providerStatus);
    if (status) return { text: status, state: "streaming" };
  }
  const start =
    tab.isStreaming && tab.roundTiming
      ? Math.max(0, tab.roundTiming.startIndex - (tab.history?.start ?? 0))
      : 0;
  const summary = latestAssistantSummary(tab.messages.slice(start));
  if (tab.isStreaming)
    return { text: summary ?? "Working...", state: "streaming" };
  if (summary) return { text: summary, state: "finished" };
  return { text: "Ready", state: "idle" };
}
