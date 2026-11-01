import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useUpdater } from "./use-updater";
import { useUpdaterStore } from "@/stores/updater-store";
import { useSettingsStore } from "@/stores/settings-store";
import { check, UpdateUnavailableError } from "@/lib/desktop/updater";
import { open } from "@/lib/desktop/shell";
import { relaunch } from "@/lib/desktop/process";
vi.mock("@/lib/desktop/updater", () => ({
  check: vi.fn(),
  UpdateUnavailableError: class extends Error {},
}));
vi.mock("@/lib/desktop/process", () => ({ relaunch: vi.fn() }));
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
async function renderUpdater({ startCheck = true } = {}) {
  if (startCheck) void useUpdaterStore.getState().checkForUpdate(false);
  const result = {
    current: undefined as unknown as ReturnType<typeof useUpdater>,
  };
  function Probe() {
    result.current = useUpdater();
    return null;
  }
  root = createRoot(document.createElement("div"));
  await act(async () => root!.render(createElement(Probe)));
  return { result };
}
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
});
beforeEach(() => {
  vi.clearAllMocks();
  useUpdaterStore.setState({
    status: { state: "idle" },
    update: null,
    checking: false,
    expiresAt: 0,
    generation: 0,
    revision: -1,
  });
  useSettingsStore.setState({ skippedUpdateVersions: [] });
});
it("observes the startup check and opens manual releases without installing or restarting", async () => {
  vi.mocked(check).mockResolvedValue({
    mode: "manual",
    version: "0.1.1-beta",
    releaseUrl:
      "https://github.com/Catalex-app/Catalex/releases/tag/v0.1.1-beta",
  });
  const { result } = await renderUpdater();
  await vi.waitFor(() =>
    expect(result.current.status).toMatchObject({
      state: "available",
      mode: "manual",
      version: "0.1.1-beta",
    }),
  );
  expect(check).toHaveBeenCalledWith(false);
  await act(() => result.current.installUpdate());
  expect(open).toHaveBeenCalledWith(
    "https://github.com/Catalex-app/Catalex/releases/tag/v0.1.1-beta",
  );
  expect(result.current.status.state).toBe("available");
  expect(relaunch).not.toHaveBeenCalled();
});
it("supports manual checks, reports unavailable/offline states, and permits retry", async () => {
  const { result } = await renderUpdater({ startCheck: false });
  expect(check).not.toHaveBeenCalled();
  vi.mocked(check).mockRejectedValueOnce(
    new UpdateUnavailableError("Releases unavailable"),
  );
  await act(() => result.current.checkForUpdate());
  expect(result.current.status).toEqual({
    state: "unavailable",
    message: "Releases unavailable",
  });
  vi.mocked(check).mockRejectedValueOnce(new Error("Check your connection"));
  await act(() => result.current.checkForUpdate());
  expect(result.current.status).toEqual({
    state: "error",
    message: "Check your connection",
  });
  vi.mocked(check).mockResolvedValueOnce(null);
  await act(() => result.current.checkForUpdate());
  expect(result.current.status.state).toBe("up-to-date");
  expect(check).toHaveBeenLastCalledWith(true);
});
it("ignores an older check that finishes after a newer check", async () => {
  let resolveFirst!: (value: null) => void;
  vi.mocked(check).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveFirst = resolve;
      }),
  );
  const { result } = await renderUpdater();
  vi.mocked(check).mockResolvedValueOnce({
    mode: "manual",
    version: "0.1.1-beta",
    releaseUrl:
      "https://github.com/Catalex-app/Catalex/releases/tag/v0.1.1-beta",
  });
  await act(() => result.current.checkForUpdate());
  await act(async () => resolveFirst(null));
  expect(result.current.status).toMatchObject({
    state: "available",
    version: "0.1.1-beta",
  });
});

function available(version = "0.1.1-beta") {
  return {
    mode: "manual" as const,
    version,
    releaseUrl: `https://github.com/Catalex-app/Catalex/releases/tag/v${version}`,
  };
}
it("remembers a skipped version after remount and settings rehydration", async () => {
  vi.mocked(check).mockResolvedValue(available());
  const first = await renderUpdater();
  await act(async () => first.result.current.skipUpdate());
  expect(first.result.current.status).toEqual({
    state: "skipped",
    version: "0.1.1-beta",
  });
  const saved = localStorage.getItem("catalex-settings")!;
  expect(JSON.parse(saved).state.skippedUpdateVersions).toEqual(["0.1.1-beta"]);
  await act(async () => root!.unmount());
  root = undefined;
  useSettingsStore.setState({ skippedUpdateVersions: [] });
  localStorage.setItem("catalex-settings", saved);
  await useSettingsStore.persist.rehydrate();
  const second = await renderUpdater();
  expect(second.result.current.status).toEqual({
    state: "skipped",
    version: "0.1.1-beta",
  });
  expect(open).not.toHaveBeenCalled();
  await act(() => second.result.current.openRelease());
  expect(open).toHaveBeenCalledWith(
    "https://github.com/Catalex-app/Catalex/releases/tag/v0.1.1-beta",
  );
  expect(second.result.current.status.state).toBe("skipped");
  expect(useSettingsStore.getState().skippedUpdateVersions).toEqual([
    "0.1.1-beta",
  ]);
});
it("keeps per-version skips across consumers and explicit checks while offering newer versions", async () => {
  vi.mocked(check).mockResolvedValue(available());
  let first!: ReturnType<typeof useUpdater>;
  let second!: ReturnType<typeof useUpdater>;
  function Probe() {
    first = useUpdater();
    second = useUpdater();
    return null;
  }
  root = createRoot(document.createElement("div"));
  await act(async () => root!.render(createElement(Probe)));
  expect(check).not.toHaveBeenCalled();
  await act(() => useUpdaterStore.getState().checkForUpdate(false));
  await act(async () => first.skipUpdate());
  expect(first.status.state).toBe("skipped");
  expect(second.status.state).toBe("skipped");
  await act(() => first.checkForUpdate());
  expect(first.status.state).toBe("skipped");
  expect(second.status.state).toBe("skipped");
  await act(async () => first.skipUpdate());
  expect(first.status.state).toBe("skipped");
  vi.mocked(check).mockResolvedValue(available("0.1.2-beta"));
  await act(() => second.checkForUpdate());
  expect(second.status).toMatchObject({
    state: "available",
    version: "0.1.2-beta",
  });
  await act(async () => second.skipUpdate());
  expect(useSettingsStore.getState().skippedUpdateVersions).toEqual([
    "0.1.1-beta",
    "0.1.2-beta",
  ]);
  vi.mocked(check).mockResolvedValue(available());
  await act(() => first.checkForUpdate());
  expect(first.status).toEqual({ state: "skipped", version: "0.1.1-beta" });
  vi.mocked(check).mockResolvedValue(available("0.1.3-beta"));
  await act(() => first.checkForUpdate());
  expect(first.status).toMatchObject({
    state: "available",
    version: "0.1.3-beta",
  });
});

it("retains a detected update on remount, shares fresh results, and keeps its notice during rechecks", async () => {
  vi.mocked(check).mockResolvedValue(available());
  const first = await renderUpdater();
  expect(first.result.current.notice.state).toBe("available");
  await act(async () => root!.unmount());
  root = undefined;
  const second = await renderUpdater();
  expect(second.result.current.notice.state).toBe("available");
  expect(check).toHaveBeenCalledTimes(1);
  let finish!: (value: ReturnType<typeof available>) => void;
  vi.mocked(check).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  let request!: Promise<void>;
  await act(async () => {
    request = second.result.current.checkForUpdate();
  });
  expect(second.result.current.checking).toBe(true);
  expect(second.result.current.notice.state).toBe("available");
  await act(async () => {
    finish(available());
    await request;
  });
  expect(second.result.current.notice.state).toBe("available");
  vi.mocked(check).mockRejectedValueOnce(new Error("Offline"));
  await act(() => second.result.current.checkForUpdate());
  expect(second.result.current.status.state).toBe("error");
  expect(second.result.current.notice.state).toBe("available");
});
it("continues a pending startup check across view remounts", async () => {
  let finish!: (value: ReturnType<typeof available>) => void;
  vi.mocked(check).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await renderUpdater();
  await act(async () => root!.unmount());
  root = undefined;
  const second = await renderUpdater();
  expect(check).toHaveBeenCalledTimes(1);
  await act(async () => {
    finish(available());
  });
  expect(second.result.current.notice).toMatchObject({
    state: "available",
    version: "0.1.1-beta",
  });
});

it("never checks merely because views mount and ignores older host snapshots", async () => {
  const { result } = await renderUpdater({ startCheck: false });
  expect(check).not.toHaveBeenCalled();
  await act(async () =>
    useUpdaterStore.getState().acceptSnapshot({
      revision: 2,
      status: "ready",
      checking: false,
      update: available(),
    }),
  );
  await act(async () =>
    useUpdaterStore.getState().acceptSnapshot({
      revision: 1,
      status: "idle",
      checking: true,
      update: null,
    }),
  );
  expect(result.current.notice).toMatchObject({
    state: "available",
    version: "0.1.1-beta",
  });
  expect(result.current.checking).toBe(false);
  await act(async () => root!.unmount());
  root = undefined;
  const next = await renderUpdater({ startCheck: false });
  expect(next.result.current.notice.state).toBe("available");
  expect(check).not.toHaveBeenCalled();
});
