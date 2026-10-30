import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopBridge } from "./bridge";
import { Channel, convertFileSrc, invoke } from "./core";
import { listen } from "./event";
import { stat, writeFile } from "./fs";
import { getCurrentWebview } from "./webview";
import { getCurrentWindow } from "./window";

vi.unmock("@/lib/desktop/core");
vi.unmock("@/lib/desktop/event");
vi.unmock("@/lib/desktop/fs");
vi.unmock("@/lib/desktop/webview");

describe("desktop preload boundary", () => {
  const listeners = new Map<string, (payload: unknown) => void>();
  const hostInvoke = vi.fn();
  let bridge: DesktopBridge;

  beforeEach(() => {
    listeners.clear();
    hostInvoke.mockReset().mockResolvedValue({ result: null });
    bridge = {
      invoke: hostInvoke,
      emit: vi.fn().mockResolvedValue(undefined),
      listen: (event, callback) => {
        listeners.set(event, callback);
        return () => {
          listeners.delete(event);
        };
      },
      windowId: "main",
      platform: "darwin",
      getPathForFile: vi.fn(),
    };
    window.catalex = bridge;
  });

  afterEach(() => {
    delete window.catalex;
  });

  it("preserves structured compiler errors across the preload boundary", async () => {
    const failure = {
      message: "Compilation failed",
      diagnostics: [
        { severity: "error", message: "Undefined command", line: 4 },
      ],
    };
    hostInvoke.mockResolvedValue({ error: failure });
    await expect(invoke("compile_latex")).rejects.toEqual(failure);
  });

  it("serializes diagnostics channels and releases their event subscriptions", async () => {
    const receive = vi.fn();
    const diagnostics = new Channel(receive);
    hostInvoke.mockImplementation(async (_command, args) => {
      listeners.get(`__channel:${args.diagnostics.__channel}`)?.([
        { message: "Warning" },
      ]);
      return { result: [37, 80, 68, 70] };
    });
    await expect(
      invoke("compile_latex", { projectDir: "/project", diagnostics }),
    ).resolves.toEqual([37, 80, 68, 70]);
    expect(hostInvoke).toHaveBeenCalledWith("compile_latex", {
      projectDir: "/project",
      diagnostics: { __channel: diagnostics.id },
    });
    expect(receive).toHaveBeenCalledWith([{ message: "Warning" }]);
    diagnostics.dispose();
    expect(listeners.size).toBe(0);
  });

  it("wraps native events with the renderer payload shape and unsubscribes", async () => {
    const callback = vi.fn();
    const stop = await listen("files-changed", callback);
    listeners.get("files-changed")?.({ paths: ["main.tex"] });
    expect(callback).toHaveBeenCalledWith({
      event: "files-changed",
      id: expect.any(Number),
      payload: { paths: ["main.tex"] },
    });
    stop();
    expect(listeners.size).toBe(0);
  });

  it("retains binary file writes and converts native modification times", async () => {
    const contents = new Uint8Array([0, 127, 255]);
    await writeFile("/project/figure.png", contents);
    expect(hostInvoke).toHaveBeenCalledWith("desktop:fs:writeFile", {
      path: "/project/figure.png",
      contents,
    });
    hostInvoke.mockResolvedValue({
      result: {
        size: 3,
        isFile: true,
        isDirectory: false,
        isSymlink: false,
        mtime: 1234,
      },
    });
    expect((await stat("/project/figure.png")).mtime?.getTime()).toBe(1234);
  });

  it("encodes reserved characters in local asset paths", () => {
    expect(convertFileSrc("/project/a #1/figure%.png")).toBe(
      "catalex-asset://local/%2Fproject%2Fa%20%231%2Ffigure%25.png",
    );
  });

  it("lets the app flush pending changes before approving a native close", async () => {
    const callback = vi.fn((event: { preventDefault(): void }) =>
      event.preventDefault(),
    );
    const stop = await getCurrentWindow().onCloseRequested(callback);
    expect(hostInvoke).toHaveBeenCalledWith("desktop:window:setCloseHandler", {
      enabled: true,
    });
    listeners.get("desktop:window:close-requested")?.(undefined);
    await Promise.resolve();
    expect(callback).toHaveBeenCalledOnce();
    expect(hostInvoke).not.toHaveBeenCalledWith(
      "desktop:window:close",
      undefined,
    );
    await getCurrentWindow().close();
    expect(hostInvoke).toHaveBeenCalledWith("desktop:window:close", undefined);
    stop();
    expect(listeners.size).toBe(0);
  });

  it("resolves native dropped files through preload and removes DOM listeners", async () => {
    const callback = vi.fn();
    const file = new File(["text"], "notes.txt");
    bridge.getPathForFile = vi.fn(() => "/project/notes.txt");
    const stop = await getCurrentWebview().onDragDropEvent(callback);
    const drop = new Event("drop", { cancelable: true });
    Object.defineProperties(drop, {
      dataTransfer: { value: { types: ["Files"], files: [file] } },
      clientX: { value: 20 },
      clientY: { value: 30 },
    });
    window.dispatchEvent(drop);
    expect(drop.defaultPrevented).toBe(true);
    expect(bridge.getPathForFile).toHaveBeenCalledWith(file);
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: {
          type: "drop",
          paths: ["/project/notes.txt"],
          files: [],
          position: {
            x: 20 * window.devicePixelRatio,
            y: 30 * window.devicePixelRatio,
          },
        },
      }),
    );
    stop();
    window.dispatchEvent(drop);
    expect(callback).toHaveBeenCalledOnce();
  });
  it("preserves pathless screenshots in drops", async () => {
    const callback = vi.fn();
    const file = new File(["image"], "image.png", { type: "image/png" });
    bridge.getPathForFile = vi.fn(() => "");
    const stop = await getCurrentWebview().onDragDropEvent(callback);
    const event = new Event("drop", { cancelable: true });
    Object.defineProperties(event, {
      dataTransfer: { value: { types: ["Files"], files: [file] } },
      clientX: { value: 20 },
      clientY: { value: 30 },
    });
    window.dispatchEvent(event);
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ paths: [], files: [file] }),
      }),
    );
    stop();
  });
});
