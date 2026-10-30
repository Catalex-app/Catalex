import { APP_NAMESPACE } from "../branding";
import { contextBridge, ipcRenderer, webUtils } from "electron";

const windowId =
  process.argv
    .find((value) => value.startsWith("--catalex-window="))
    ?.split("=")[1] ?? "main";

const subscriptions = new Map<string, Set<(payload: unknown) => void>>();
ipcRenderer.on(
  "desktop:event",
  (_event, message: { event: string; payload: unknown }) => {
    for (const callback of subscriptions.get(message.event) ?? [])
      callback(message.payload);
  },
);

contextBridge.exposeInMainWorld(APP_NAMESPACE, {
  windowId,
  platform: process.platform,
  invoke: (command: string, args?: unknown) =>
    ipcRenderer.invoke("desktop:invoke", command, args ?? {}),
  listen: (event: string, callback: (payload: unknown) => void) => {
    let callbacks = subscriptions.get(event);
    if (!callbacks) {
      callbacks = new Set();
      subscriptions.set(event, callbacks);
    }
    callbacks.add(callback);
    return () => {
      callbacks.delete(callback);
      if (callbacks.size === 0) subscriptions.delete(event);
    };
  },
  emit: (event: string, payload?: unknown) =>
    ipcRenderer.invoke("desktop:emit", event, payload),
  getPathForFile: (file: File) => {
    const filePath = webUtils.getPathForFile(file);
    if (filePath) ipcRenderer.send("desktop:grant-file", filePath);
    return filePath;
  },
});
