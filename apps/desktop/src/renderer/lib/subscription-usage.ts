import { invoke } from "@/lib/desktop/core";
import type { ChatProvider } from "@/stores/settings-store";

export interface SubscriptionWindow {
  id: string;
  label: string;
  usedPercent: number;
  resetsAt: string | null;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function resetDate(value: unknown): string | null {
  const date =
    typeof value === "number"
      ? new Date(value * 1000)
      : typeof value === "string"
        ? new Date(value)
        : null;
  return date && Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function durationLabel(minutes: unknown, fallback: string): string {
  if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes <= 0)
    return fallback;
  if (minutes % 1440 === 0) return `${minutes / 1440}-day`;
  if (minutes % 60 === 0) return `${minutes / 60}-hour`;
  return `${minutes}-minute`;
}

export function subscriptionWindows(
  provider: ChatProvider,
  value: unknown,
): SubscriptionWindow[] {
  const response = record(value);
  const windows: SubscriptionWindow[] = [];
  const add = (id: string, label: string, used: unknown, reset: unknown) => {
    if (typeof used !== "number" || !Number.isFinite(used)) return;
    windows.push({
      id,
      label,
      usedPercent: Math.min(100, Math.max(0, used)),
      resetsAt: resetDate(reset),
    });
  };
  if (provider === "codex") {
    const buckets = Object.entries(record(response.rateLimitsByLimitId));
    if (!buckets.length) buckets.push(["codex", response.rateLimits]);
    for (const [id, value] of buckets) {
      const bucket = record(value);
      const prefix =
        buckets.length > 1
          ? `${typeof bucket.limitName === "string" ? bucket.limitName : id} · `
          : "";
      for (const key of ["primary", "secondary"]) {
        const window = record(bucket[key]);
        add(
          `${id}:${key}`,
          prefix +
            durationLabel(
              window.windowDurationMins,
              key === "primary" ? "Primary limit" : "Secondary limit",
            ),
          window.usedPercent,
          window.resetsAt,
        );
      }
    }
  } else if (response.rate_limits_available === true) {
    const labels: Record<string, string> = {
      five_hour: "5-hour",
      seven_day: "7-day",
      seven_day_opus: "7-day · Opus",
      seven_day_sonnet: "7-day · Sonnet",
      seven_day_oauth_apps: "7-day · OAuth apps",
    };
    for (const [id, value] of Object.entries(record(response.rate_limits))) {
      const window = record(value);
      add(
        id,
        labels[id] ?? id.replace(/_/g, " "),
        window.utilization,
        window.resets_at,
      );
    }
  }
  return windows;
}

const pending = new Map<ChatProvider, Promise<SubscriptionWindow[]>>();

export function readSubscriptionUsage(
  provider: ChatProvider,
): Promise<SubscriptionWindow[]> {
  if (provider === "pi") return Promise.resolve([]);
  const existing = pending.get(provider);
  if (existing) return existing;
  const request = invoke<unknown>(`read_${provider}_subscription_usage`)
    .then((value) => subscriptionWindows(provider, value))
    .finally(() => pending.delete(provider));
  pending.set(provider, request);
  return request;
}
