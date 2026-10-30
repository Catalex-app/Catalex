export type DownloadEvent =
  | { event: "Started"; data: { contentLength?: number } }
  | { event: "Progress"; data: { chunkLength: number } }
  | { event: "Finished" };

export interface Update {
  version: string;
  body?: string;
  downloadAndInstall(callback: (event: DownloadEvent) => void): Promise<void>;
}

export class UpdateUnavailableError extends Error {}

export async function check(): Promise<Update | null> {
  const result = await hostInvoke<{
    unavailable: true;
    message: string;
  } | null>("desktop:updater:check");
  if (result?.unavailable) throw new UpdateUnavailableError(result.message);
  return null;
}
import { hostInvoke } from "./bridge";
