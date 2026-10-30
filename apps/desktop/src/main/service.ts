import { PRODUCT_NAME } from "../branding";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { ServiceOutput } from "./service-output";

export interface ServiceEvent {
  windowId?: string;
  event: string;
  payload: unknown;
}

export type Reply = { result: unknown } | { error: unknown };

/** One domain service per app. A failed service never replays mutations. */
export class NativeService {
  private child: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private stopped = false;
  private closing?: Promise<void>;
  private pending = new Map<
    number,
    { windowId: string; resolve: (reply: Reply) => void; timer: NodeJS.Timeout }
  >();

  constructor(
    executable: string,
    env: NodeJS.ProcessEnv,
    onEvent: (event: ServiceEvent) => void,
    onFailure: (message: string) => void,
  ) {
    this.child = spawn(executable, [], {
      env,
      stdio: "pipe",
      windowsHide: true,
      // Terminal signals go through Electron so pending writes can flush first.
      detached: process.platform !== "win32",
    });
    this.child.stderr.on("data", (chunk) => process.stderr.write(chunk));
    const stopForFailure = (message: string) => {
      const unexpected = !this.stopped;
      this.stopped = true;
      this.fail(message);
      if (unexpected) onFailure(message);
    };
    const output = new ServiceOutput((message) => {
      try {
        if (!message || typeof message !== "object" || Array.isArray(message)) {
          throw new Error("Invalid protocol message");
        }
        if (
          typeof message.id === "number"
            ? !("result" in message || "error" in message)
            : typeof message.event !== "string"
        ) {
          throw new Error("Invalid protocol message");
        }
      } catch {
        stopForFailure("The native service sent an invalid response.");
        this.child.kill();
        return;
      }
      if (typeof message.id === "number") {
        const request = this.pending.get(message.id);
        if (!request) return;
        clearTimeout(request.timer);
        this.pending.delete(message.id);
        request.resolve(
          "error" in message
            ? { error: message.error }
            : { result: message.result },
        );
      } else {
        onEvent(message);
      }
    });
    this.child.stdout.on("data", (chunk: Buffer) => {
      if (this.stopped) return;
      try {
        output.push(chunk);
      } catch {
        stopForFailure("The native service sent an invalid response.");
        this.child.kill();
      }
    });
    this.child.once("error", (error) => {
      stopForFailure(error.message);
    });
    this.child.once("exit", (code, signal) => {
      const message = `Native service stopped (${signal ?? code ?? "unknown"}).`;
      stopForFailure(message);
    });
    this.child.stdin.on("error", (error) => {
      stopForFailure(error.message);
      this.child.kill();
    });
  }

  request(windowId: string, command: string, args: unknown): Promise<Reply> {
    if (this.stopped || !this.child.stdin.writable) {
      return Promise.resolve({
        error: "Native service is unavailable. Restart " + PRODUCT_NAME + ".",
      });
    }
    if (command === "__close_window") {
      for (const [id, request] of this.pending) {
        if (request.windowId !== windowId) continue;
        clearTimeout(request.timer);
        this.pending.delete(id);
        request.resolve({
          error: "The window closed before the native operation completed.",
        });
      }
    } else if (this.pending.size >= 256) {
      return Promise.resolve({ error: "Too many pending native operations." });
    }
    const id = this.nextId++;
    let serialized: string;
    try {
      serialized = `${JSON.stringify({ id, windowId, command, args, binaryResponse: command === "compile_latex" })}\n`;
    } catch {
      return Promise.resolve({
        error: "Native request contains values that cannot be serialized.",
      });
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ error: `Native operation ${command} timed out.` });
      }, 10 * 60_000);
      this.pending.set(id, { windowId, resolve, timer });
      this.child.stdin.write(serialized, (error) => {
        if (error) this.fail(error.message);
      });
    });
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.stopped = true;
    this.fail(PRODUCT_NAME + " is closing.");
    this.closing = new Promise((resolve) => {
      if (
        this.child.exitCode !== null ||
        this.child.signalCode !== null ||
        !this.child.pid
      ) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        this.child.kill("SIGKILL");
        resolve();
      }, 10_000);
      this.child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      this.child.stdin.end();
    });
    return this.closing;
  }

  private fail(message: string) {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.resolve({ error: message });
    }
    this.pending.clear();
  }
}
