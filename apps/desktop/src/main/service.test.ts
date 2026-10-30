import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  ChildProcessWithoutNullStreams,
  SpawnOptions,
} from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NativeService } from "./service";

const spawned = vi.hoisted(() => ({
  fixture: "",
  children: [] as ChildProcessWithoutNullStreams[],
}));

// Exercise real child pipes on every OS. Only replace the fixture's executable
// invocation with Node; NativeService still owns the process and its protocol.
vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return {
    ...original,
    spawn: (executable: string, args: string[], options: SpawnOptions) => {
      const child = original.spawn(
        executable === spawned.fixture ? process.execPath : executable,
        executable === spawned.fixture ? [spawned.fixture] : args,
        options,
      ) as ChildProcessWithoutNullStreams;
      spawned.children.push(child);
      return child;
    },
  };
});

const fixtureSource = `
const fs = require("node:fs");
const lines = require("node:readline").createInterface({ input: process.stdin });
let stallShutdown = false;
function send(message) { process.stdout.write(JSON.stringify(message) + "\\n"); }
lines.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.command === "stall-shutdown") stallShutdown = true;
  if (request.command === "hold") return;
  if (request.command === "compile_latex") {
    const bytes = Buffer.from([37,80,68,70,45,0,10,255]);
    if (request.binaryResponse) {
      send({id:request.id,binaryLength:bytes.length});
      process.stdout.write(bytes.subarray(0,3));
      process.stdout.write(bytes.subarray(3));
    } else send({id:request.id,result:[...bytes]});
    return;
  }
  if (request.command === "crash") process.exit(7);
  if (request.command === "invalid") { process.stdout.write("not-json\\n"); return; }
  if (request.command === "bad-envelope") { send({ id: request.id }); return; }
  if (request.command === "error") {
    send({ id: request.id, error: { message: "Compilation failed", diagnostics: [{ severity: "error", line: 3 }] } });
    return;
  }
  if (request.command === "event") {
    send({ windowId: request.windowId, event: "__channel:12", payload: request.args });
  }
  const reply = () => send({ id: request.id, result: { windowId: request.windowId, command: request.command, args: request.args } });
  if (request.command === "slow") setTimeout(reply, 30);
  else reply();
});
lines.on("close", () => {
  if (stallShutdown) { setInterval(() => {}, 1000); return; }
  fs.writeFileSync(process.env.CATALEX_TEST_CLOSE_MARKER, "closed");
  process.exit(0);
});
`;

describe("native service transport", () => {
  let directory: string;
  let service: NativeService;
  let closeMarker: string;
  const events = vi.fn();
  const failures = vi.fn();

  beforeEach(async () => {
    directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "catalex-service-test-"),
    );
    spawned.fixture = path.join(directory, "fixture.cjs");
    spawned.children = [];
    closeMarker = path.join(directory, "closed.txt");
    await fs.writeFile(spawned.fixture, fixtureSource);
    events.mockReset();
    failures.mockReset();
    service = new NativeService(
      spawned.fixture,
      { ...process.env, CATALEX_TEST_CLOSE_MARKER: closeMarker },
      events,
      failures,
    );
  });

  afterEach(async () => {
    vi.useRealTimers();
    await service.close();
    await Promise.all(
      spawned.children.map(async (child) => {
        if (child.exitCode !== null || child.signalCode !== null || !child.pid)
          return;
        const exited = once(child, "exit").catch(() => {});
        child.kill();
        await exited;
      }),
    );
    await fs.rm(directory, { recursive: true, force: true });
  });

  it("matches concurrent replies by request ID and keeps window identity", async () => {
    const slow = service.request("project-window", "slow", { source: "first" });
    const fast = service.request("settings", "echo", { source: "second" });
    await expect(fast).resolves.toEqual({
      result: {
        windowId: "settings",
        command: "echo",
        args: { source: "second" },
      },
    });
    await expect(slow).resolves.toEqual({
      result: {
        windowId: "project-window",
        command: "slow",
        args: { source: "first" },
      },
    });
    expect(failures).not.toHaveBeenCalled();
  });

  it("reports startup failure and refuses later requests without retrying", async () => {
    await service.close();
    service = new NativeService(
      path.join(directory, "missing-helper"),
      process.env,
      events,
      failures,
    );
    await expect(service.request("main", "echo", {})).resolves.toEqual({
      error: expect.stringContaining("ENOENT"),
    });
    await expect(service.request("main", "echo", {})).resolves.toEqual({
      error: expect.stringContaining("unavailable"),
    });
    expect(failures).toHaveBeenCalledOnce();
    expect(spawned.children).toHaveLength(2);
  });

  it("preserves structured errors and targeted streaming events", async () => {
    await expect(service.request("main", "error", {})).resolves.toEqual({
      error: {
        message: "Compilation failed",
        diagnostics: [{ severity: "error", line: 3 }],
      },
    });
    await service.request("second-window", "event", [{ message: "warning" }]);
    expect(events).toHaveBeenCalledWith({
      windowId: "second-window",
      event: "__channel:12",
      payload: [{ message: "warning" }],
    });
    expect(failures).not.toHaveBeenCalled();
  });

  it("settles a closed window's pending work without cancelling another window", async () => {
    const closingWindow = service.request("closing-window", "hold", {});
    const otherWindow = service.request("other-window", "slow", { keep: true });
    await service.request("closing-window", "__close_window", {});
    await expect(closingWindow).resolves.toEqual({
      error: expect.stringContaining("window closed"),
    });
    await expect(otherWindow).resolves.toEqual({
      result: {
        windowId: "other-window",
        command: "slow",
        args: { keep: true },
      },
    });
    expect(failures).not.toHaveBeenCalled();
  });

  it("settles all pending operations when the helper dies without replaying them", async () => {
    const pending = service.request("main", "hold", { mutation: true });
    const crash = service.request("main", "crash", {});
    for (const response of await Promise.all([pending, crash])) {
      expect(response).toEqual({ error: expect.stringContaining("stopped") });
    }
    await expect(service.request("main", "echo", {})).resolves.toEqual({
      error: expect.stringContaining("unavailable"),
    });
    expect(failures).toHaveBeenCalledOnce();
    expect(spawned.children).toHaveLength(1);
  });

  it.each([
    "invalid",
    "bad-envelope",
  ])("fails pending work instead of accepting %s protocol output", async (command) => {
    const pending = service.request("main", "hold", {});
    const malformed = service.request("main", command, {});
    for (const response of await Promise.all([pending, malformed])) {
      expect(response).toEqual({
        error: expect.stringContaining("invalid response"),
      });
    }
    await expect.poll(() => failures.mock.calls.length).toBe(1);
    await expect(service.request("main", "echo", {})).resolves.toEqual({
      error: expect.stringContaining("unavailable"),
    });
  });

  it("rejects unserializable requests without leaving pending operations or killing the helper", async () => {
    const args: Record<string, unknown> = {};
    args.circular = args;
    await expect(service.request("main", "echo", args)).resolves.toEqual({
      error: expect.stringContaining("serialized"),
    });
    await expect(service.request("main", "echo", {})).resolves.toMatchObject({
      result: { command: "echo" },
    });
    expect(failures).not.toHaveBeenCalled();
  });

  it("negotiates binary PDF replies without changing other requests", async () => {
    await expect(service.request("main", "compile_latex", {})).resolves.toEqual(
      { result: Buffer.from([37, 80, 68, 70, 45, 0, 10, 255]) },
    );
    await expect(service.request("main", "echo", {})).resolves.toMatchObject({
      result: { command: "echo" },
    });
  });

  it("closes stdin for native cleanup and settles pending requests on shutdown", async () => {
    await service.request("main", "echo", {});
    const pending = service.request("main", "hold", {});
    const closed = service.close();
    await expect(pending).resolves.toEqual({ error: "Catalex is closing." });
    await expect(service.request("main", "echo", {})).resolves.toEqual({
      error: expect.stringContaining("unavailable"),
    });
    await expect
      .poll(async () => fs.readFile(closeMarker, "utf8").catch(() => null))
      .toBe("closed");
    await closed;
    expect(spawned.children[0].exitCode).toBe(0);
    expect(failures).not.toHaveBeenCalled();
  });

  it("terminates a helper that never finishes shutdown within the grace period", async () => {
    await service.request("main", "stall-shutdown", {});
    vi.useFakeTimers();
    const exited = once(spawned.children[0], "exit");
    const closed = service.close();
    await vi.advanceTimersByTimeAsync(10_000);
    await closed;
    vi.useRealTimers();
    await exited;
    expect(spawned.children[0].signalCode).toBe("SIGKILL");
    expect(failures).not.toHaveBeenCalled();
  });
});
