import type { TabState } from "@/stores/agent-chat-store";

/** Shared runtime/queue policy; presentation and action identity guards stay local. */
export function isChatArchiveEligible(
  tab: Pick<
    TabState,
    "isStreaming" | "isSettling" | "turnPhase" | "pauseState" | "queuedPrompts"
  >,
  {
    isNewChat = false,
    reviewPhases = [],
  }: {
    isNewChat?: boolean;
    reviewPhases?: readonly string[];
  } = {},
): boolean {
  return (
    !isNewChat &&
    !tab.isStreaming &&
    !tab.isSettling &&
    !tab.turnPhase &&
    !tab.queuedPrompts?.length &&
    tab.pauseState !== "pausing" &&
    reviewPhases.every(
      (phase) => tab.pauseState === "paused" && phase === "revising",
    )
  );
}
