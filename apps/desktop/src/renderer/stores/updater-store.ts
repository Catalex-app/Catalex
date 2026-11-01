import { create } from "zustand";
import { useSettingsStore } from "./settings-store";
import {
  check,
  UpdateUnavailableError,
  type Update,
  getUpdateState,
  requestUpdateCheck,
} from "@/lib/desktop/updater";
import { open } from "@/lib/desktop/shell";
import { relaunch } from "@/lib/desktop/process";
import type { UpdateSnapshot } from "../../update-types";

export type UpdateStatus =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "up-to-date" }
  | { state: "skipped"; version: string }
  | { state: "unavailable"; message: string }
  | {
      state: "available";
      mode: Update["mode"];
      version: string;
      notes?: string;
    }
  | { state: "downloading"; percent: number }
  | { state: "installing" }
  | { state: "ready" }
  | { state: "error"; message: string };

interface UpdaterState {
  status: UpdateStatus;
  update: Update | null;
  checking: boolean;
  expiresAt: number;
  generation: number;
  revision: number;
  acceptSnapshot: (snapshot: UpdateSnapshot) => void;
  checkForUpdate: (force?: boolean) => Promise<void>;
  skipUpdate: () => void;
  openRelease: () => Promise<void>;
  installUpdate: () => Promise<void>;
}

// Renderer mirror of the main-process service. Views only observe this state.
export const useUpdaterStore = create<UpdaterState>((set, get) => ({
  status: { state: "idle" },
  update: null,
  checking: false,
  expiresAt: 0,
  generation: 0,
  revision: -1,
  acceptSnapshot(snapshot) {
    if (snapshot.revision < get().revision) return;
    const update = snapshot.update;
    const status: UpdateStatus =
      snapshot.status === "ready"
        ? update
          ? {
              state: "available",
              mode: update.mode,
              version: update.version,
              notes: update.body,
            }
          : { state: "up-to-date" }
        : snapshot.status === "idle"
          ? { state: snapshot.checking ? "checking" : "idle" }
          : {
              state: snapshot.status,
              message: snapshot.message ?? "Could not check for updates.",
            };
    set({
      status,
      update,
      checking: snapshot.checking,
      revision: snapshot.revision,
    });
  },
  async checkForUpdate(force = true) {
    const previous = get();
    if (["downloading", "installing", "ready"].includes(previous.status.state))
      return;
    if (window.catalex) {
      set({ checking: true });
      try {
        get().acceptSnapshot(await requestUpdateCheck());
      } catch (error) {
        set({
          checking: false,
          status: {
            state: "error",
            message: error instanceof Error ? error.message : String(error),
          },
        });
      }
      return;
    }
    // Browser fixtures simulate a host check; native scheduling belongs to main.
    if (!force && (previous.checking || Date.now() < previous.expiresAt))
      return;
    const generation = previous.generation + 1;
    set({
      checking: true,
      generation,
      ...(previous.status.state === "idle"
        ? { status: { state: "checking" } as UpdateStatus }
        : {}),
    });
    try {
      const update = await check(force);
      if (generation !== get().generation) return;
      set({
        update,
        checking: false,
        expiresAt: Date.now() + 5 * 60_000,
        status: update
          ? {
              state: "available",
              mode: update.mode,
              version: update.version,
              notes: update.body,
            }
          : { state: "up-to-date" },
      });
    } catch (error) {
      if (generation !== get().generation) return;
      set({
        checking: false,
        expiresAt: Date.now() + 60_000,
        status: {
          state:
            error instanceof UpdateUnavailableError ? "unavailable" : "error",
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  },
  skipUpdate() {
    const update = get().update;
    if (update) useSettingsStore.getState().skipUpdateVersion(update.version);
  },
  async openRelease() {
    const update = get().update;
    if (!update) return;
    try {
      await open(update.releaseUrl);
    } catch (error) {
      set({
        status: {
          state: "error",
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  },
  async installUpdate() {
    const update = get().update;
    if (!update) return;
    try {
      if (update.mode === "manual") {
        await open(update.releaseUrl);
        return;
      }
      let downloaded = 0;
      let contentLength = 0;
      await update.downloadAndInstall((event) => {
        switch (event.event) {
          case "Started":
            contentLength = event.data.contentLength ?? 0;
            set({ status: { state: "downloading", percent: 0 } });
            break;
          case "Progress":
            downloaded += event.data.chunkLength;
            if (contentLength > 0)
              set({
                status: {
                  state: "downloading",
                  percent: Math.round((downloaded / contentLength) * 100),
                },
              });
            break;
          case "Finished":
            set({ status: { state: "installing" } });
            break;
        }
      });
      set({ status: { state: "ready" } });
      setTimeout(() => relaunch(), 1500);
    } catch (error) {
      set({
        status: {
          state: "error",
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  },
}));

let connection: Promise<void> | undefined;
let unlisten: (() => void) | undefined;

/** Subscribe before reading so a result arriving during bootstrap cannot be lost. */
export function initializeUpdater(): Promise<void> {
  if (!window.catalex) return Promise.resolve();
  if (connection) return connection;
  unlisten = window.catalex.listen("desktop:updater:changed", (snapshot) => {
    useUpdaterStore.getState().acceptSnapshot(snapshot as UpdateSnapshot);
  });
  connection = getUpdateState()
    .then((snapshot) => {
      useUpdaterStore.getState().acceptSnapshot(snapshot);
    })
    .catch((error) => {
      useUpdaterStore.setState({
        checking: false,
        status: {
          state: "error",
          message: error instanceof Error ? error.message : String(error),
        },
      });
    });
  return connection;
}

if (import.meta.hot)
  import.meta.hot.dispose(() => {
    unlisten?.();
    connection = undefined;
  });
