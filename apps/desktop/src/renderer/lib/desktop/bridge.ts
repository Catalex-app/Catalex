import { getPanelWindowSession } from "../panel-window-runtime";
import { PRODUCT_NAME } from "../../../branding";
export interface DesktopBridge {
  invoke<T>(
    command: string,
    args?: Record<string, unknown>,
  ): Promise<{ result?: T; error?: unknown }>;
  listen(event: string, callback: (payload: unknown) => void): () => void;
  emit(event: string, payload?: unknown): Promise<void>;
  windowId: string;
  platform: string;
  getPathForFile(file: File): string;
}

declare global {
  interface Window {
    catalex?: DesktopBridge;
  }
}

// Existing browser harnesses implement this in memory. Production Electron
// always uses the preload bridge and never accesses these test internals.
export interface BrowserHarness {
  invoke(
    command: string,
    args?: unknown,
    options?: Record<string, unknown>,
  ): Promise<unknown>;
  transformCallback?(callback: (event: unknown) => void): number;
  unregisterCallback?(id: number): void;
  convertFileSrc?(path: string): string;
}

export function browserHarness(): BrowserHarness | undefined {
  return (
    (window as Window & { __TAURI_INTERNALS__?: BrowserHarness })
      .__TAURI_INTERNALS__ ??
    (import.meta.env.DEV ? getPanelWindowSession()?.browserHarness : undefined)
  );
}

export function isDesktop(): boolean {
  return (
    typeof window !== "undefined" && !!(window.catalex || browserHarness())
  );
}

export async function invokeBridge<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  const response = await window.catalex!.invoke<T>(command, args);
  if ("error" in response) throw response.error;
  return response.result as T;
}

export function hostInvoke<T>(
  command: string,
  args?: Record<string, unknown>,
  browserCommand?: string,
  browserArgs = args,
): Promise<T> {
  if (window.catalex) return invokeBridge<T>(command, args);
  const harness = browserHarness();
  if (harness && browserCommand) {
    return harness.invoke(browserCommand, browserArgs) as Promise<T>;
  }
  return Promise.reject(
    new Error("This action requires the " + PRODUCT_NAME + " desktop app."),
  );
}
