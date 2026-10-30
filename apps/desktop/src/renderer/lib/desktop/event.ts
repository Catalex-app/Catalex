import { browserHarness } from "./bridge";

export type UnlistenFn = () => void;
export interface Event<T> {
  event: string;
  id: number;
  payload: T;
}

let nextListenerId = 1;

export async function listen<T>(
  event: string,
  callback: (event: Event<T>) => void,
): Promise<UnlistenFn> {
  if (window.catalex) {
    const id = nextListenerId++;
    return window.catalex.listen(event, (payload) =>
      callback({ event, id, payload: payload as T }),
    );
  }
  const harness = browserHarness();
  if (!harness?.transformCallback) return () => {};
  const handler = harness.transformCallback((payload) =>
    callback(payload as Event<T>),
  );
  const eventId = await harness.invoke("plugin:event|listen", {
    event,
    target: { kind: "Any" },
    handler,
  });
  return () => {
    harness.unregisterCallback?.(handler);
    void harness.invoke("plugin:event|unlisten", { event, eventId });
  };
}

export async function emit(event: string, payload?: unknown): Promise<void> {
  if (window.catalex) return window.catalex.emit(event, payload);
  await browserHarness()?.invoke("plugin:event|emit", { event, payload });
}
