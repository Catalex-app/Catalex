import { ASSET_PROTOCOL } from "../../../branding";
import { PRODUCT_NAME } from "../../../branding";
import { browserHarness, invokeBridge } from "./bridge";

export { isDesktop } from "./bridge";

let nextChannelId = 1;

/** A request-scoped stream, currently used for compiler diagnostics. */
export class Channel<T> {
  readonly id = nextChannelId++;
  onmessage: (message: T) => void;
  private unlisten?: () => void;

  constructor(onmessage: (message: T) => void = () => {}) {
    this.onmessage = onmessage;
    this.unlisten = window.catalex?.listen(
      `__channel:${this.id}`,
      (payload) => {
        this.onmessage(payload as T);
      },
    );
  }

  dispose() {
    this.unlisten?.();
    this.unlisten = undefined;
  }
}

function serialize(value: unknown): unknown {
  if (value instanceof Channel) return { __channel: value.id };
  if (Array.isArray(value)) return value.map(serialize);
  if (
    value &&
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, serialize(item)]),
    );
  }
  return value;
}

export function invoke<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  if (window.catalex) {
    return invokeBridge<T>(
      command,
      serialize(args) as Record<string, unknown> | undefined,
    );
  }
  const harness = browserHarness();
  if (harness) return harness.invoke(command, args) as Promise<T>;
  return Promise.reject(
    new Error("This action requires the " + PRODUCT_NAME + " desktop app."),
  );
}

export function convertFileSrc(path: string): string {
  if (!window.catalex) {
    const convert = browserHarness()?.convertFileSrc;
    if (convert) return convert(path);
  }
  return `${ASSET_PROTOCOL}://local/${encodeURIComponent(path)}`;
}
