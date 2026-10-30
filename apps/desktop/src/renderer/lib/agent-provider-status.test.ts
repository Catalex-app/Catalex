import { describe, expect, it } from "vitest";
import {
  claudeProviderStatus,
  providerStatusLabel,
  readCodexProviderStatus,
} from "./agent-provider-status";

describe("provider status display", () => {
  it.each([
    "compacting",
    "requesting",
    "future status",
    null,
  ])("passes through Claude status %s", (status) => {
    expect(
      claudeProviderStatus({ type: "system", subtype: "status", status }),
    ).toBe(status);
  });

  it("uses explicit retry and completion events", () => {
    expect(
      claudeProviderStatus({
        type: "system",
        subtype: "api_retry",
        error_status: 429,
      }),
    ).toBe("retrying");
    expect(
      claudeProviderStatus({ type: "system", subtype: "compact_boundary" }),
    ).toBeNull();
    expect(
      claudeProviderStatus({
        type: "stream_event",
        event: { type: "message_start" },
      }),
    ).toBeNull();
    expect(claudeProviderStatus({ type: "result" })).toBeNull();
  });

  it("does not interpret errors, telemetry, or subagent messages", () => {
    for (const message of [
      { type: "assistant", error: "rate_limit" },
      { type: "tool_progress", subagent_retry: {} },
      { type: "rate_limit_event" },
      { type: "stream_event", event: { type: "ping" } },
      {
        type: "system",
        subtype: "status",
        status: "compacting",
        parent_tool_use_id: "child",
      },
    ])
      expect(claudeProviderStatus(message)).toBeUndefined();
  });

  it("passes through Codex status strings and rejects malformed payloads", () => {
    for (const status of ["compacting", "retrying", "future status", null])
      expect(readCodexProviderStatus({ type: "provider_status", status })).toBe(
        status,
      );
    for (const message of [
      null,
      {},
      { type: "error", message: "reconnecting" },
      { type: "provider_status", status: 1 },
    ])
      expect(readCodexProviderStatus(message)).toBeUndefined();
  });

  it("only formats the reported label", () => {
    expect(providerStatusLabel("compacting")).toBe("Compacting...");
    expect(providerStatusLabel("future status")).toBe("Future status...");
    expect(providerStatusLabel(null)).toBeNull();
  });
});
