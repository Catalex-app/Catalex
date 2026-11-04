import { create, useStore, type StoreApi } from "zustand";
import type { DocumentState } from "@/stores/document-store";
import type { PdfSource } from "./mupdf/pdf-source";
import type { WorkspaceMode } from "./ui-theme";

export type PanelWindowKind = "editor" | "preview" | "chat";
export interface PanelWindowSession {
  kind: PanelWindowKind;
  mode: WorkspaceMode;
  fileId: string;
  chatId?: string;
  projectRoot: string;
  document: StoreApi<DocumentState>;
  stores: Record<string, unknown>;
  pdf: (rootFileId: string) => PdfSource | undefined;
  compilation: (
    projectDir: string,
    source: PdfSource | null,
  ) => import("./latex-compiler").PublishedCompilation | undefined;
  compile: (
    options: import("./workspace-compile").CompileOptions,
  ) => Promise<void>;
  stopCompilation: () => Promise<void>;
  flush?: () => Promise<void>;
  close?: () => Promise<void>;
  window: Window | null;
  browserHarness?: import("./desktop/bridge").BrowserHarness;
}

/** Keep an open chat view alive even when it is not selected in the owner. */
export function isChatPanelOpen(chatId: string): boolean {
  if (typeof window === "undefined") return false;
  return [...(window.__catalexPanelSessions?.values() ?? [])].some(
    (session) =>
      session.kind === "chat" &&
      session.chatId === chatId &&
      !!session.window &&
      !session.window.closed,
  );
}

declare global {
  interface Window {
    __catalexPanelSessions?: Map<string, PanelWindowSession>;
  }
}

/** Only same-origin child windows explicitly opened by the workspace can attach. */
export function getPanelWindowSession(): PanelWindowSession | undefined {
  if (typeof window === "undefined") return;
  const token = new URLSearchParams(window.location.search).get("panel-window");
  if (!token || !window.opener) return;
  try {
    if (window.opener.location.origin !== window.location.origin) return;
    return window.opener.__catalexPanelSessions?.get(token);
  } catch {
    return;
  }
}

/** Actions run in the owner, so there is one agent/session/persistence runtime. */
export function createPanelStore(name: string): typeof create {
  const parent = getPanelWindowSession()?.stores[name] as
    | StoreApi<unknown>
    | undefined;
  if (!parent) return create;
  const subscriptions = new Set<() => void>();
  const api = {
    ...parent,
    subscribe: (listener: (state: unknown, previous: unknown) => void) => {
      const stop = parent.subscribe(listener);
      subscriptions.add(stop);
      return () => {
        subscriptions.delete(stop);
        stop();
      };
    },
  };
  window.addEventListener(
    "unload",
    () => {
      for (const stop of subscriptions) stop();
      subscriptions.clear();
    },
    { once: true },
  );
  const shared = Object.assign(
    (selector?: (state: unknown) => unknown) =>
      useStore(api, selector ?? ((state) => state)),
    api,
  );
  // Support both Zustand create(initializer) and create<State>()(initializer).
  // The child never invokes the initializer or starts a second persist runtime.
  const initialize = (initializer?: unknown): unknown =>
    initializer ? shared : initialize;
  return initialize as typeof create;
}

export async function flushPanelWindows() {
  for (const session of window.__catalexPanelSessions?.values() ?? [])
    if (session.window && !session.window.closed) await session.flush?.();
}
