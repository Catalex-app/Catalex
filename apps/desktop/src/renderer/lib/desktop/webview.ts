import { hostInvoke } from "./bridge";
import { listen, type Event, type UnlistenFn } from "./event";

type Position = { x: number; y: number };
export type DragDropEvent =
  | {
      type: "enter" | "drop";
      paths: string[];
      files?: File[];
      position: Position;
    }
  | { type: "over"; position: Position }
  | { type: "leave" };

async function onDragDropEvent(
  callback: (event: Event<DragDropEvent>) => void | Promise<void>,
): Promise<UnlistenFn> {
  if (!window.catalex) {
    const stops = await Promise.all(
      ["enter", "over", "leave", "drop"].map((type) =>
        listen<Omit<DragDropEvent, "type">>(`tauri://drag-${type}`, (event) => {
          void callback({
            ...event,
            payload: { ...event.payload, type } as DragDropEvent,
          });
        }),
      ),
    );
    return () => {
      for (const stop of stops) stop();
    };
  }

  let depth = 0;
  const send = (payload: DragDropEvent) => {
    void callback({ event: "desktop:drag-drop", id: 0, payload });
  };
  const position = (event: DragEvent): Position => ({
    x: event.clientX * window.devicePixelRatio,
    y: event.clientY * window.devicePixelRatio,
  });
  const isFileDrag = (event: DragEvent) =>
    event.dataTransfer?.types.includes("Files");
  const enter = (event: DragEvent) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    if (depth++ === 0)
      send({ type: "enter", paths: [], position: position(event) });
  };
  const over = (event: DragEvent) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    send({ type: "over", position: position(event) });
  };
  const leave = (event: DragEvent) => {
    if (!isFileDrag(event)) return;
    depth = Math.max(0, depth - 1);
    if (depth === 0) send({ type: "leave" });
  };
  const drop = (event: DragEvent) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    depth = 0;
    const paths: string[] = [];
    const files: File[] = [];
    for (const file of Array.from(event.dataTransfer?.files ?? [])) {
      const path = window.catalex!.getPathForFile(file);
      if (path) paths.push(path);
      else files.push(file);
    }
    send({ type: "drop", paths, files, position: position(event) });
  };
  window.addEventListener("dragenter", enter);
  window.addEventListener("dragover", over);
  window.addEventListener("dragleave", leave);
  window.addEventListener("drop", drop);
  return () => {
    window.removeEventListener("dragenter", enter);
    window.removeEventListener("dragover", over);
    window.removeEventListener("dragleave", leave);
    window.removeEventListener("drop", drop);
  };
}

const currentWebview = {
  setZoom: (scaleFactor: number) =>
    hostInvoke<void>(
      "desktop:webview:setZoom",
      { scaleFactor },
      "plugin:webview|set_webview_zoom",
      { value: scaleFactor },
    ),
  onDragDropEvent,
};

export function getCurrentWebview() {
  return currentWebview;
}
