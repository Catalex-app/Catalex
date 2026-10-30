import { afterEach, expect, it, vi } from "vitest";
import {
  type CommentWaitChoices,
  waitForCommentsOnClose,
} from "./comment-close-wait";
import { ProjectExitCanceled } from "./project-chat-lifecycle";

afterEach(() => vi.useRealTimers());

function fixture() {
  vi.useFakeTimers();
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const saving = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  let choices: CommentWaitChoices | null = null;
  const show = vi.fn((next: CommentWaitChoices | null) => {
    choices = next;
  });
  const closing = waitForCommentsOnClose(saving, show);
  return { resolve, reject, closing, show, choices: () => choices! };
}

it("shows no dialog for a quick save and clears its timer", async () => {
  const f = fixture();
  f.resolve();
  await f.closing;
  await vi.advanceTimersByTimeAsync(5_000);
  expect(f.show.mock.calls.every(([value]) => value === null)).toBe(true);
});

it("offers choices after five seconds, keeps waiting on the same save, then completes", async () => {
  const f = fixture();
  await vi.advanceTimersByTimeAsync(4_999);
  expect(f.choices()).toBeNull();
  await vi.advanceTimersByTimeAsync(1);
  f.choices().wait();
  expect(f.choices()).toBeNull();
  await vi.advanceTimersByTimeAsync(5_000);
  expect(f.choices()).not.toBeNull();
  f.resolve();
  await f.closing;
  expect(f.choices()).toBeNull();
});

it("cancel prevents a late completion from approving close", async () => {
  const f = fixture();
  const result = expect(f.closing).rejects.toBeInstanceOf(ProjectExitCanceled);
  await vi.advanceTimersByTimeAsync(5_000);
  f.choices().cancel();
  await result;
  const calls = f.show.mock.calls.length;
  f.resolve();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(f.show).toHaveBeenCalledTimes(calls);
});

it("close anyway stops waiting and safely handles a later save failure", async () => {
  const f = fixture();
  await vi.advanceTimersByTimeAsync(5_000);
  f.choices().discard();
  await f.closing;
  const calls = f.show.mock.calls.length;
  f.reject(new Error("Late failure"));
  await vi.advanceTimersByTimeAsync(10_000);
  expect(f.show).toHaveBeenCalledTimes(calls);
});

it("propagates failures while waiting so the error choices can be shown", async () => {
  const f = fixture();
  const result = expect(f.closing).rejects.toThrow("Disk full");
  await vi.advanceTimersByTimeAsync(5_000);
  f.reject(new Error("Disk full"));
  await result;
  expect(f.choices()).toBeNull();
});
