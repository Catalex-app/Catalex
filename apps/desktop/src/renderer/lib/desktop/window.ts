import { hostInvoke } from "./bridge";
import { listen, type UnlistenFn } from "./event";

interface CloseRequestedEvent {
  preventDefault(): void;
}

let closeHandlerCount = 0;

const currentWindow = {
  show: () =>
    hostInvoke<void>("desktop:window:show", undefined, "plugin:window|show"),
  close: () =>
    hostInvoke<void>("desktop:window:close", undefined, "plugin:window|close"),
  setTitle: (title: string) =>
    hostInvoke<void>(
      "desktop:window:setTitle",
      { title },
      "plugin:window|set_title",
    ),
  isFullscreen: () =>
    hostInvoke<boolean>(
      "desktop:window:isFullscreen",
      undefined,
      "plugin:window|is_fullscreen",
    ),

  async onResized(callback: () => void): Promise<UnlistenFn> {
    return listen(
      window.catalex ? "desktop:window:resized" : "tauri://resize",
      callback,
    );
  },

  async onCloseRequested(
    callback: (event: CloseRequestedEvent) => void | Promise<void>,
  ): Promise<UnlistenFn> {
    const unlisten = await listen(
      window.catalex
        ? "desktop:window:close-requested"
        : "tauri://close-requested",
      async () => {
        let prevented = false;
        await callback({
          preventDefault: () => {
            prevented = true;
          },
        });
        if (!prevented) await currentWindow.close();
      },
    );
    if (!window.catalex) return unlisten;
    closeHandlerCount++;
    try {
      await hostInvoke("desktop:window:setCloseHandler", { enabled: true });
    } catch (error) {
      closeHandlerCount--;
      unlisten();
      throw error;
    }
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      unlisten();
      // A disposed effect may finish registering after its replacement mounts.
      // Only the last subscriber can disable the native save-before-close gate.
      if (--closeHandlerCount === 0) {
        void hostInvoke("desktop:window:setCloseHandler", {
          enabled: false,
        }).catch(() => {});
      }
    };
  },
};

export function getCurrentWindow() {
  return currentWindow;
}
