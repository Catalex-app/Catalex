import { expect, test } from "bun:test";
import { interruptAndWait } from "./interrupt-turn.js";

test("interrupt acknowledgement alone does not release the next turn", async () => {
  let complete!: () => void;
  const completed = new Promise<void>((resolve) => {
    complete = resolve;
  });
  let released = false;
  const waiting = interruptAndWait(async () => undefined, completed).then(
    () => {
      released = true;
    },
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(released).toBe(false);
  complete();
  await waiting;
  expect(released).toBe(true);
});

test("a terminal result still waits for the pending interrupt command", async () => {
  let acknowledge!: () => void;
  const acknowledgement = new Promise<void>((resolve) => {
    acknowledge = resolve;
  });
  let released = false;
  const waiting = interruptAndWait(
    () => acknowledgement,
    Promise.resolve(),
  ).then(() => {
    released = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(released).toBe(false);
  acknowledge();
  await waiting;
  expect(released).toBe(true);
});

test("missing terminal result times out so the caller can close the query", async () => {
  await expect(
    interruptAndWait(async () => undefined, new Promise(() => {}), 5),
  ).rejects.toThrow("Interrupt timed out");
});

test("interrupt rejection reaches the caller for session disposal", async () => {
  await expect(
    interruptAndWait(
      async () => {
        throw new Error("Disconnected");
      },
      new Promise(() => {}),
    ),
  ).rejects.toThrow("Disconnected");
});
