import { getCurrentWebview } from "@/lib/desktop/webview";

const APP_ZOOM_CHANGED_EVENT = "catalex-app-zoom-changed";

export const APP_ZOOM_STORAGE_KEY = "catalex-app-zoom";
export const LOCAL_ZOOM_SHORTCUTS_ATTR = "data-local-zoom-shortcuts";
export const DEFAULT_APP_ZOOM = 1;
export const MIN_APP_ZOOM = 0.5;
export const MAX_APP_ZOOM = 3;
export const APP_ZOOM_STEP = 0.1;

export type AppZoomAction = "in" | "out" | "reset";

type ZoomShortcutEvent = Pick<
  KeyboardEvent,
  "altKey" | "code" | "ctrlKey" | "key" | "metaKey"
>;

function roundZoom(value: number): number {
  return Math.round(value * 100) / 100;
}

export function clampAppZoom(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_APP_ZOOM;
  return roundZoom(Math.min(MAX_APP_ZOOM, Math.max(MIN_APP_ZOOM, value)));
}

export function readStoredAppZoom(): number {
  const raw = window.localStorage.getItem(APP_ZOOM_STORAGE_KEY);
  if (raw === null) return DEFAULT_APP_ZOOM;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_APP_ZOOM;

  return clampAppZoom(parsed);
}

async function applyAppZoom(value: number): Promise<number> {
  const zoom = clampAppZoom(value);
  await getCurrentWebview().setZoom(zoom);
  // Native macOS buttons keep their size when the renderer is zoomed.
  if (navigator.userAgent.includes("Macintosh")) {
    document.documentElement.style.setProperty(
      "--traffic-light-width",
      `${72 / zoom}px`,
    );
    window.dispatchEvent(new Event("resize"));
  }
  return zoom;
}

export async function persistAppZoom(value: number): Promise<number> {
  const zoom = await applyAppZoom(value);
  window.localStorage.setItem(APP_ZOOM_STORAGE_KEY, zoom.toString());
  window.dispatchEvent(new Event(APP_ZOOM_CHANGED_EVENT));
  return zoom;
}

export function subscribeAppZoom(callback: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === APP_ZOOM_STORAGE_KEY || event.key === null) callback();
  };
  window.addEventListener(APP_ZOOM_CHANGED_EVENT, callback);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(APP_ZOOM_CHANGED_EVENT, callback);
    window.removeEventListener("storage", onStorage);
  };
}

let listeningForZoomChanges = false;

export function initializeAppZoom(): Promise<number> {
  if (!listeningForZoomChanges) {
    listeningForZoomChanges = true;
    window.addEventListener("storage", (event) => {
      if (event.key === APP_ZOOM_STORAGE_KEY || event.key === null) {
        void applyAppZoom(readStoredAppZoom()).catch(console.error);
      }
    });
  }
  return applyAppZoom(readStoredAppZoom());
}

export function zoomInApp(): Promise<number> {
  const percent = Math.round(readStoredAppZoom() * 100);
  return persistAppZoom((Math.floor(percent / 10) + 1) * APP_ZOOM_STEP);
}

export function zoomOutApp(): Promise<number> {
  const percent = Math.round(readStoredAppZoom() * 100);
  return persistAppZoom((Math.ceil(percent / 10) - 1) * APP_ZOOM_STEP);
}

export function resetAppZoom(): Promise<number> {
  return persistAppZoom(DEFAULT_APP_ZOOM);
}

export function getAppZoomAction(
  event: ZoomShortcutEvent,
): AppZoomAction | null {
  if (!(event.metaKey || event.ctrlKey) || event.altKey) {
    return null;
  }

  if (
    event.key === "+" ||
    event.key === "=" ||
    event.code === "Equal" ||
    event.code === "NumpadAdd"
  ) {
    return "in";
  }

  if (
    event.key === "-" ||
    event.key === "_" ||
    event.code === "Minus" ||
    event.code === "NumpadSubtract"
  ) {
    return "out";
  }

  if (
    event.key === "0" ||
    event.code === "Digit0" ||
    event.code === "Numpad0"
  ) {
    return "reset";
  }

  return null;
}

export function shouldHandleAppZoomShortcut(
  target: EventTarget | null,
): boolean {
  if (!(target instanceof Element)) return true;
  return !target.closest(
    `[${LOCAL_ZOOM_SHORTCUTS_ATTR}], [data-shortcut-action]`,
  );
}
