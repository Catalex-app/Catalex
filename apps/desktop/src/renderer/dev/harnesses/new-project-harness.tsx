import { ProjectPicker } from "@/components/project-picker";
import { useClaudeSetupStore } from "@/stores/claude-setup-store";
import { useCodexSetupStore } from "@/stores/codex-setup-store";

declare global {
  interface Window {
    __newProjectHarness?: {
      openedUrls: string[];
      openFolderCount: number;
    };
  }
}

function ensureNewProjectHarnessMocks() {
  if (typeof window === "undefined") return;

  const win = window as Window & {
    __TAURI_INTERNALS__?: {
      invoke?: (
        cmd: string,
        args?: Record<string, unknown>,
        options?: unknown,
      ) => Promise<unknown>;
    };
  };
  if (win.__newProjectHarness) return;

  useClaudeSetupStore.setState({ status: "ready", version: "test" });
  useCodexSetupStore.setState({ status: "ready", version: "test" });
  const existing = win.__TAURI_INTERNALS__ ?? {};
  const existingInvoke = existing.invoke;
  const openedUrls: string[] = [];

  win.__newProjectHarness = { openedUrls, openFolderCount: 0 };
  win.__TAURI_INTERNALS__ = {
    ...existing,
    invoke: async (cmd, args, options) => {
      if (cmd === "plugin:dialog|open") {
        win.__newProjectHarness!.openFolderCount++;
        return null;
      }
      if (cmd === "plugin:shell|open") {
        const path = args?.path;
        if (typeof path === "string") {
          openedUrls.push(path);
        }
        return null;
      }
      return (await existingInvoke?.(cmd, args, options)) ?? null;
    },
  };
}

export function NewProjectHarness() {
  ensureNewProjectHarnessMocks();
  return <ProjectPicker />;
}
