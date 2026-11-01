import { hostInvoke } from "./bridge";
import type {
  ManualUpdate,
  UpdateCheckResult,
  UpdateSnapshot,
} from "../../../update-types";

export type DownloadEvent =
  | { event: "Started"; data: { contentLength?: number } }
  | { event: "Progress"; data: { chunkLength: number } }
  | { event: "Finished" };

interface AutomaticUpdate {
  mode: "automatic";
  version: string;
  releaseUrl: string;
  body?: string;
  downloadAndInstall(callback: (event: DownloadEvent) => void): Promise<void>;
}

// A signed installer adapter can use the same UI later. Current checks return
// manual releases only; a signature alone never enables automatic installation.
export type Update = ManualUpdate | AutomaticUpdate;
export class UpdateUnavailableError extends Error {}

export async function getUpdateState(): Promise<UpdateSnapshot> {
  return hostInvoke("desktop:updater:state");
}

export async function requestUpdateCheck(): Promise<UpdateSnapshot> {
  return hostInvoke("desktop:updater:check");
}

export async function check(force = false): Promise<Update | null> {
  if (window.catalex) {
    const state = await requestUpdateCheck();
    if (state.status === "unavailable")
      throw new UpdateUnavailableError(state.message);
    if (state.status === "error") throw new Error(state.message);
    return state.update;
  }
  const result = await hostInvoke<UpdateCheckResult>(
    "desktop:updater:check",
    { force },
    "desktop:updater:check",
  );
  if (result && "unavailable" in result)
    throw new UpdateUnavailableError(result.message);
  return result;
}
