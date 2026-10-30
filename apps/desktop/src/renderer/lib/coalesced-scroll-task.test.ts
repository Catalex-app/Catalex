import { afterEach, expect, it, vi } from "vitest";
import { CoalescedScrollTask } from "./coalesced-scroll-task";

afterEach(() => vi.useRealTimers());

it("runs during sustained input, serializes slow work and keeps only the latest pending target", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const starts: number[] = [];
  let release: (() => void) | undefined;
  const task = new CoalescedScrollTask<number>(async (value) => {
    starts.push(value);
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  });
  task.push(1);
  await vi.advanceTimersByTimeAsync(1);
  for (let i = 2; i <= 100; i++) task.push(i);
  await vi.advanceTimersByTimeAsync(1000);
  expect(starts).toEqual([1]);
  release?.();
  await vi.advanceTimersByTimeAsync(1);
  expect(starts).toEqual([1, 100]);
  task.push(101);
  task.clear();
  release?.();
  await vi.advanceTimersByTimeAsync(1000);
  expect(starts).toEqual([1, 100]);
});

it("throttles fast requests without waiting for input to stop and survives errors", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const starts: number[] = [];
  const task = new CoalescedScrollTask<number>(async (value) => {
    starts.push(performance.now());
    if (value === 0) throw new Error("unavailable");
  });
  for (let i = 0; i < 30; i++) {
    task.push(i);
    await vi.advanceTimersByTimeAsync(16);
  }
  expect(starts.length).toBeGreaterThan(2);
  expect(starts.length).toBeLessThanOrEqual(5);
  for (let i = 1; i < starts.length; i++)
    expect(starts[i] - starts[i - 1]).toBeGreaterThanOrEqual(120);
  task.clear();
});
