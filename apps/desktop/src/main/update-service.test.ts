import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  UpdateService,
  UPDATE_CHECK_INTERVAL_MS,
  UPDATE_RETRY_INTERVAL_MS,
} from "./update-service";
import type { UpdateCheckResult } from "../update-types";

const update = {
  mode: "manual" as const,
  version: "0.1.1-beta",
  releaseUrl: "https://github.com/Catalex-app/Catalex/releases/tag/v0.1.1-beta",
};
const services: UpdateService[] = [];
function setup(
  fetcher = vi.fn<() => Promise<UpdateCheckResult>>().mockResolvedValue(update),
) {
  const changed = vi.fn();
  const service = new UpdateService(fetcher, changed);
  services.push(service);
  return { service, fetcher, changed };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => {
  for (const service of services.splice(0)) service.stop();
  vi.useRealTimers();
});

it("checks once on startup and every 24 hours, independent of state reads", async () => {
  const { service, fetcher } = setup();
  service.start();
  service.start();
  await service.check();
  expect(fetcher).toHaveBeenCalledTimes(1);
  for (let window = 0; window < 10; window++)
    expect(service.getState().update).toEqual(update);
  expect(fetcher).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS - 1);
  expect(fetcher).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(fetcher).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS);
  expect(fetcher).toHaveBeenCalledTimes(3);
});
it("checks once after an overdue wake, and does nothing on an early or repeated wake", async () => {
  const { service, fetcher } = setup();
  service.start();
  await service.check();
  await service.checkIfDue();
  expect(fetcher).toHaveBeenCalledTimes(1);
  vi.setSystemTime(UPDATE_CHECK_INTERVAL_MS + 1000);
  await Promise.all([service.checkIfDue(), service.checkIfDue()]);
  expect(fetcher).toHaveBeenCalledTimes(2);
  await service.checkIfDue();
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it("manual checks run immediately and reset the daily deadline", async () => {
  const { service, fetcher } = setup();
  service.start();
  await service.check();
  await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS / 2);
  await service.check();
  expect(fetcher).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS / 2);
  expect(fetcher).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS / 2);
  expect(fetcher).toHaveBeenCalledTimes(3);
});
it("shares an in-flight check and keeps a known update while rechecking", async () => {
  const { service, fetcher, changed } = setup();
  service.start();
  await service.check();
  let finish!: (result: UpdateCheckResult) => void;
  fetcher.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const first = service.check();
  const second = service.check();
  expect(second).toBe(first);
  expect(service.getState()).toMatchObject({ checking: true, update });
  expect(fetcher).toHaveBeenCalledTimes(2);
  finish(update);
  await first;
  expect(service.getState()).toMatchObject({
    checking: false,
    update,
    status: "ready",
  });
  expect(changed.mock.calls.map(([state]) => state.revision)).toEqual([
    1, 2, 3, 4,
  ]);
});
it("preserves the last known update on failure and retries after one hour", async () => {
  const { service, fetcher } = setup();
  service.start();
  await service.check();
  fetcher.mockRejectedValueOnce(new Error("Offline"));
  await service.check();
  expect(service.getState()).toMatchObject({
    status: "error",
    message: "Offline",
    update,
    checking: false,
  });
  await vi.advanceTimersByTimeAsync(UPDATE_RETRY_INTERVAL_MS - 1);
  expect(fetcher).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(service.getState().status).toBe("ready");
});
it("reports unavailable checks without claiming up to date and retries", async () => {
  const { service, fetcher } = setup();
  fetcher.mockResolvedValueOnce({
    unavailable: true,
    message: "No public releases",
  });
  service.start();
  await service.check();
  expect(service.getState()).toMatchObject({
    status: "unavailable",
    update: null,
    message: "No public releases",
  });
  fetcher.mockResolvedValueOnce(null);
  await vi.advanceTimersByTimeAsync(UPDATE_RETRY_INTERVAL_MS);
  expect(service.getState()).toMatchObject({ status: "ready", update: null });
});
it("stops its timer and never publishes a late result after shutdown", async () => {
  let finish!: (result: UpdateCheckResult) => void;
  const fetcher = vi.fn<() => Promise<UpdateCheckResult>>().mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const { service, changed } = setup(fetcher);
  service.start();
  const pending = service.check();
  service.stop();
  finish(update);
  await pending;
  await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS * 2);
  expect(changed).toHaveBeenCalledTimes(1);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});
