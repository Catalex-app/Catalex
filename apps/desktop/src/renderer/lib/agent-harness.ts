import type { ChatProvider } from "@/stores/settings-store";
import { invoke } from "./desktop/core";

/** App-facing lifecycle names; each backend owns its native protocol. */
export const HARNESSES = {
  claude: { label: "Claude Code", compact: true },
  codex: { label: "Codex", compact: true },
  pi: { label: "Pi", compact: true },
} as const satisfies Record<ChatProvider, { label: string; compact: boolean }>;

export function normalizeProvider(value: unknown): ChatProvider {
  return value === "codex" || value === "pi" ? value : "claude";
}

export function harnessCommand(
  provider: ChatProvider,
  action: "execute" | "resume" | "cancel" | "dispose",
) {
  return action === "cancel"
    ? `cancel_${provider}_execution`
    : action === "dispose"
      ? `dispose_${provider}_session`
      : `${action}_${provider}_code`;
}

export async function disposeHarnesses(tabId: string) {
  await Promise.all(
    Object.keys(HARNESSES).map(async (provider) => {
      try {
        await invoke(harnessCommand(provider as ChatProvider, "dispose"), {
          tabId,
        });
      } catch {
        /* Continue disposing the remaining runtimes. */
      }
    }),
  );
}

export function restoreProviderState(
  ids: Record<string, string> | undefined,
  cursors: Record<string, number> | null | undefined,
  provider: ChatProvider,
  messageCount: number,
) {
  const providerSessionIds: Partial<Record<ChatProvider, string>> = {};
  const providerSyncCursors: Partial<Record<ChatProvider, number>> = {};
  for (const key of Object.keys(HARNESSES) as ChatProvider[]) {
    if (typeof ids?.[key] === "string") providerSessionIds[key] = ids[key];
    if (cursors != null) {
      const cursor = cursors[key];
      providerSyncCursors[key] = Number.isFinite(cursor)
        ? Math.max(0, Math.min(cursor, messageCount))
        : 0;
    }
  }
  if (cursors == null) providerSyncCursors[provider] = messageCount;
  return { providerSessionIds, providerSyncCursors };
}
