import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@/lib/desktop/core";
import {
  readSubscriptionUsage,
  subscriptionWindows,
} from "./subscription-usage";

describe("subscription usage", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
  });

  it("shows only the returned Codex windows, including secondary-only plans", () => {
    expect(
      subscriptionWindows("codex", {
        rateLimits: {
          primary: null,
          secondary: {
            usedPercent: 24,
            windowDurationMins: 10080,
            resetsAt: 1800000000,
          },
        },
      }),
    ).toEqual([
      {
        id: "codex:secondary",
        label: "7-day",
        usedPercent: 24,
        resetsAt: new Date(1800000000000).toISOString(),
      },
    ]);
  });

  it("prefers multiple Codex buckets over the legacy duplicate", () => {
    const bucket = { primary: { usedPercent: 0, windowDurationMins: 300 } };
    expect(
      subscriptionWindows("codex", {
        rateLimits: bucket,
        rateLimitsByLimitId: {
          codex: bucket,
          other: {
            limitName: "Other models",
            secondary: { usedPercent: 30, windowDurationMins: 1440 },
          },
        },
      }).map((window) => window.label),
    ).toEqual(["codex · 5-hour", "Other models · 1-day"]);
  });

  it("preserves zero usage but never invents missing Claude percentages", () => {
    expect(
      subscriptionWindows("claude", {
        rate_limits_available: true,
        rate_limits: {
          five_hour: { utilization: 0, resets_at: null },
          seven_day: { utilization: null },
          seven_day_opus: null,
        },
      }),
    ).toEqual([
      { id: "five_hour", label: "5-hour", usedPercent: 0, resetsAt: null },
    ]);
    expect(
      subscriptionWindows("claude", {
        rate_limits_available: false,
        rate_limits: { five_hour: { utilization: 20 } },
      }),
    ).toEqual([]);
  });

  it.each([
    null,
    {},
    { rateLimits: { primary: { usedPercent: "5" } } },
    { rateLimits: { primary: { usedPercent: Number.NaN } } },
  ])("handles unavailable or malformed usage", (value) => {
    expect(subscriptionWindows("codex", value)).toEqual([]);
  });

  it("clamps percentages and ignores invalid reset timestamps", () => {
    expect(
      subscriptionWindows("codex", {
        rateLimits: { primary: { usedPercent: 110, resetsAt: "invalid" } },
      })[0],
    ).toMatchObject({ usedPercent: 100, resetsAt: null });
  });

  it("shares only in-flight requests and queries again on the next open", async () => {
    vi.mocked(invoke).mockResolvedValue({ rateLimits: {} });
    await Promise.all([
      readSubscriptionUsage("codex"),
      readSubscriptionUsage("codex"),
    ]);
    expect(invoke).toHaveBeenCalledTimes(1);
    await readSubscriptionUsage("codex");
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke).toHaveBeenLastCalledWith("read_codex_subscription_usage");
  });

  it("does not cache failed requests or fall back to a model turn", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("unsupported"));
    await expect(readSubscriptionUsage("claude")).rejects.toThrow(
      "unsupported",
    );
    await expect(readSubscriptionUsage("claude")).rejects.toThrow(
      "unsupported",
    );
    expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).toEqual([
      "read_claude_subscription_usage",
      "read_claude_subscription_usage",
    ]);
  });
});
