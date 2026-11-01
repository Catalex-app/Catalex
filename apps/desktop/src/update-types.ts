export interface ManualUpdate {
  mode: "manual";
  version: string;
  body?: string;
  releaseUrl: string;
}

export type UpdateCheckResult =
  | ManualUpdate
  | { unavailable: true; message: string }
  | null;

export interface UpdateSnapshot {
  revision: number;
  status: "idle" | "ready" | "error" | "unavailable";
  update: ManualUpdate | null;
  checking: boolean;
  message?: string;
}
