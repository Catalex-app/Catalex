import { describe, expect, it } from "vitest";
import {
  formatRoundDuration,
  roundElapsed,
  stampRoundDuration,
} from "./agent-round-timing";
import type { AgentStreamMessage } from "@/stores/agent-chat-store";

const answer: AgentStreamMessage = {
  type: "assistant",
  message: { content: [{ type: "text", text: "Done" }] },
};
describe("round durations", () => {
  it("stamps Claude's visible answer instead of the duplicate hidden result", () => {
    const messages: AgentStreamMessage[] = [
      answer,
      { type: "result", result: "Done", duration_ms: 99999 },
    ];
    const stamped = stampRoundDuration(messages, 0, 4200, 1791000000000);
    expect(stamped[0].roundCompletedAt).toBe(1791000000000);
    expect(stamped[0].roundDurationMs).toBe(4200);
    expect(stamped[1].roundDurationMs).toBeUndefined();
    expect(messages[0].roundDurationMs).toBeUndefined();
  });
  it("does not stamp an earlier round when this one produced no answer", () => {
    const messages: AgentStreamMessage[] = [
      answer,
      { type: "user" },
      { type: "result", is_error: true, result: "Failed" },
    ];
    const stamped = stampRoundDuration(messages, 1, 4200);
    expect(stamped[0].roundDurationMs).toBeUndefined();
    expect(stamped[2].roundDurationMs).toBe(4200);
  });
  it("supports result-only and image answers and metadata serialization", () => {
    for (const message of [
      { type: "result", result: "Done" },
      {
        type: "assistant",
        message: {
          content: [
            { type: "image", imageDataUrl: "data:image/png;base64,abc" },
          ],
        },
      },
    ] as AgentStreamMessage[]) {
      expect(
        JSON.parse(JSON.stringify(stampRoundDuration([message], 0, 4200)))[0]
          .roundDurationMs,
      ).toBe(4200);
    }
  });
  it("preserves a stop before output without stamping an older answer", () => {
    const stamped = stampRoundDuration(
      [answer, { type: "user" }],
      1,
      1200,
      5000,
    );
    expect(stamped[0].roundDurationMs).toBeUndefined();
    expect(stamped.slice(-1)[0]).toMatchObject({
      type: "result",
      subtype: "round_stopped",
      roundDurationMs: 1200,
      roundCompletedAt: 5000,
    });
  });
  it("formats seconds, minutes, hours and guards clock reversal", () => {
    expect([0, 59000, 62000, 3661000].map(formatRoundDuration)).toEqual([
      "0s",
      "59s",
      "1m 2s",
      "1h 1m 1s",
    ]);
    expect(
      roundElapsed(
        { elapsedMs: 4000, runningSince: 10000, startIndex: 0, waitingFor: [] },
        9000,
      ),
    ).toBe(4000);
  });
});
