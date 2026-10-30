import { afterEach, expect, it, vi } from "vitest";
import { hostInvoke } from "@/lib/desktop/bridge";
import { getCurrentWindow } from "@/lib/desktop/window";
import type { DesktopBridge } from "@/lib/desktop/bridge";

vi.mock("@/lib/desktop/bridge", () => ({
  hostInvoke: vi.fn(async () => undefined),
}));

afterEach(() => {
  delete window.catalex;
  vi.clearAllMocks();
});

it("keeps the live close handler when an earlier async subscription is disposed", async () => {
  window.catalex = {} as DesktopBridge;
  // React StrictMode mounts the next effect before the disposed effect's
  // asynchronous registration finishes. Its late cleanup must not bypass saves.
  const [stopEarlier, stopCurrent] = await Promise.all([
    getCurrentWindow().onCloseRequested(() => {}),
    getCurrentWindow().onCloseRequested(() => {}),
  ]);
  try {
    vi.mocked(hostInvoke).mockClear();
    stopEarlier();
    expect(hostInvoke).not.toHaveBeenCalled();
    stopEarlier(); // Cleanup is idempotent.
    expect(hostInvoke).not.toHaveBeenCalled();
  } finally {
    stopCurrent();
  }
  expect(hostInvoke).toHaveBeenCalledExactlyOnceWith(
    "desktop:window:setCloseHandler",
    { enabled: false },
  );
});
