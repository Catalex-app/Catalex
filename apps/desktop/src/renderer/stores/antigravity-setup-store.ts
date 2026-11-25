import { invoke } from "@/lib/desktop/core";
import { createPanelStore } from "@/lib/panel-window-runtime";
import { useSettingsStore } from "./settings-store";

interface SetupState {
  status: "disabled" | "checking" | "error" | "ready";
  version: string | null;
  error: string | null;
  modelsStatus: "ready";
  modelsError: null;
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
export const useAntigravitySetupStore = createPanelStore(
  "antigravity",
)<SetupState>((set, get) => ({
  status: "disabled",
  version: null,
  error: null,
  modelsStatus: "ready",
  modelsError: null,
  options: [],
  setOptions: (options) => set({ options }),
  refreshModels: async () => get().checkStatus(),
  checkStatus: async () => {
    const request = ++generation;
    const { enabledProviders, antigravityBinaryPath: binaryPath } =
      useSettingsStore.getState();
    if (!enabledProviders.antigravity) {
      set({ status: "disabled", version: null, error: null, options: [] });
      return;
    }
    const current = () =>
      request === generation &&
      useSettingsStore.getState().enabledProviders.antigravity &&
      useSettingsStore.getState().antigravityBinaryPath === binaryPath;
    set({ status: "checking", error: null });
    try {
      const result = await invoke<{ version: string }>(
        "check_antigravity_status",
        { binaryPath },
      );
      if (current()) set({ status: "ready", version: result.version });
    } catch (error) {
      if (current())
        set({
          status: "error",
          version: null,
          error: String(error),
          options: [],
        });
    }
  },
}));
