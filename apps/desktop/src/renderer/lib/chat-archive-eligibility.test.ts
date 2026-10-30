import { describe, expect, it } from "vitest";
import { isChatArchiveEligible } from "./chat-archive-eligibility";
import type { TabState } from "@/stores/agent-chat-store";
const idle = {
  isStreaming: false,
  isSettling: false,
  turnPhase: null,
  pauseState: null,
} as const;
describe("chat archive eligibility", () => {
  it("allows idle and paused chats but not new chats", () => {
    expect(isChatArchiveEligible(idle)).toBe(true);
    expect(isChatArchiveEligible({ ...idle, pauseState: "paused" })).toBe(true);
    expect(isChatArchiveEligible(idle, { isNewChat: true })).toBe(false);
  });
  it.each([
    { isStreaming: true },
    { isSettling: true },
    { turnPhase: "starting" },
    { pauseState: "pausing" },
    { queuedPrompts: [{ id: "queued", prompt: "Next", context: [] }] },
  ])("blocks active runtime state %j", (patch) => {
    expect(isChatArchiveEligible({ ...idle, ...patch } as TabState)).toBe(
      false,
    );
  });
  it.each([
    "queued",
    "checking",
    "question",
    "review",
    "applying",
    "revising",
  ])("blocks %s review except stopped refinement", (phase) => {
    expect(isChatArchiveEligible(idle, { reviewPhases: [phase] })).toBe(false);
    expect(
      isChatArchiveEligible(
        { ...idle, pauseState: "paused" },
        { reviewPhases: [phase] },
      ),
    ).toBe(phase === "revising");
  });
  it("checks every queue entry", () => {
    expect(
      isChatArchiveEligible(
        { ...idle, pauseState: "paused" },
        { reviewPhases: ["revising", "queued"] },
      ),
    ).toBe(false);
  });
});
