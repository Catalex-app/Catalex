import { invoke } from "@/lib/desktop/core";
import { createPanelStore } from "@/lib/panel-window-runtime";
import { useSettingsStore } from "./settings-store";

interface SetupState {
  status: "disabled" | "checking" | "not-installed" | "error" | "ready";
  error: string | null;
  models: Array<{ value: string; label: string }>;
  options: Array<{
    category: string;
    currentValue: string;
    options: Array<{
      value: string;
      name: string;
      description?: string;
    }>;
  }>;
  setOptions: (options: SetupState["options"]) => void;
  checkStatus: () => Promise<void>;
  refreshModels: () => Promise<void>;
}

let generation = 0;
let detectedPath: string | undefined;
export const useAntigravitySetupStore = createPanelStore(
  "antigravity",
)<SetupState>((set, get) => ({
  status: "disabled",
  error: null,
  models: [],
  options: [],
  setOptions: (options) => set({ options }),
  refreshModels: async () => {
    detectedPath = undefined;
    await get().checkStatus();
  },
  checkStatus: async () => {
    const { enabledProviders, antigravityBinaryPath: binaryPath } =
      useSettingsStore.getState();
    if (!enabledProviders.antigravity) {
      generation++;
      detectedPath = undefined;
      set({
        status: "disabled",
        error: null,
        options: [],
        models: [],
      });
      return;
    }
    if (
      detectedPath === binaryPath &&
      ["ready", "checking"].includes(get().status)
    )
      return;
    const request = ++generation;
    detectedPath = binaryPath;
    const current = () =>
      request === generation &&
      useSettingsStore.getState().enabledProviders.antigravity &&
      useSettingsStore.getState().antigravityBinaryPath === binaryPath;
    set({ status: "checking", error: null, models: [], options: [] });
    try {
      const result = await invoke<{
        installed: boolean;
        models: SetupState["models"];
      }>("check_antigravity_status", { binaryPath });
      if (current())
        set({
          status: result.installed ? "ready" : "not-installed",
          models: result.models ?? [],
        });
    } catch (error) {
      if (current())
        set({
          status: "error",
          error: String(error),
          options: [],
        });
    }
  },
}));
