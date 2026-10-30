import { getVersion } from "@/lib/desktop/app";

export const FALLBACK_APP_VERSION = __APP_VERSION__;

export async function resolveAppVersion(): Promise<string> {
  try {
    return await getVersion();
  } catch {
    return FALLBACK_APP_VERSION;
  }
}
