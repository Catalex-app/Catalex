import { createPanelStore } from "@/lib/panel-window-runtime";
import { invoke } from "@/lib/desktop/core";
import { initialPiModelValue, type PiModelInfo } from "@/lib/pi-models";
import { useSettingsStore } from "./settings-store";

interface PiStatus {
  installed: boolean;
  version: string | null;
  binary_path: string | null;
  config_directory: string | null;
  error?: string | null;
}

interface PiSetupState {
  status: "disabled" | "checking" | "not-installed" | "ready" | "error";
  error: string | null;
  version: string | null;
  binaryPath: string | null;
  configDirectory: string | null;
  models: PiModelInfo[];
  modelsStatus: "idle" | "loading" | "ready" | "error";
  modelsError: string | null;
  checkStatus: () => Promise<void>;
  refreshModels: () => Promise<void>;
}

export function piConfigFromSettings(settings = useSettingsStore.getState()) {
  return {
    binaryPath: settings.piBinaryPath,
    configDirectory: settings.piConfigDirectory,
  };
}

// Every new setup check invalidates results from the previous configuration,
// including a switch away and back while an older request is still running.
let generation = 0;
let discovery: { generation: number; promise: Promise<PiModelInfo[]> } | null =
  null;
const current = (request: number) =>
  request === generation && useSettingsStore.getState().enabledProviders.pi;

const create = createPanelStore("pi");
export const usePiSetupStore = create<PiSetupState>((set, get) => ({
  status: "disabled",
  error: null,
  version: null,
  binaryPath: null,
  configDirectory: null,
  models: [],
  modelsStatus: "idle",
  modelsError: null,
  checkStatus: async () => {
    const request = ++generation;
    if (!useSettingsStore.getState().enabledProviders.pi) {
      set({ status: "disabled" });
      return;
    }
    const settings = useSettingsStore.getState();
    if (
      settings.piBinaryPaths?.length === 0 ||
      settings.piConfigDirectories?.length === 0
    ) {
      set({
        status: "not-installed",
        version: null,
        binaryPath: null,
        configDirectory: null,
        models: [],
        modelsStatus: "idle",
        modelsError: null,
        error:
          settings.piBinaryPaths?.length === 0
            ? "Add a Pi installation to continue."
            : "Add a Pi config folder to continue.",
      });
      return;
    }
    set({
      status: "checking",
      error: null,
      version: null,
      binaryPath: null,
      configDirectory: null,
      models: [],
      modelsStatus: "idle",
      modelsError: null,
    });
    try {
      const result = await invoke<PiStatus>("check_pi_status", {
        piConfig: piConfigFromSettings(),
      });
      if (!current(request)) return;
      const saved = useSettingsStore.getState();
      // Seed detected choices once. An empty saved list means the user removed
      // every entry, so verification must not silently add it back.
      const detected = {
        ...(saved.piBinaryPaths === null && result.binary_path
          ? {
              piBinaryPaths: [saved.piBinaryPath || result.binary_path],
              piBinaryPath: saved.piBinaryPath || result.binary_path,
            }
          : {}),
        ...(saved.piConfigDirectories === null && result.config_directory
          ? {
              piConfigDirectories: [
                saved.piConfigDirectory || result.config_directory,
              ],
              piConfigDirectory:
                saved.piConfigDirectory || result.config_directory,
            }
          : {}),
      };
      if (Object.keys(detected).length) useSettingsStore.setState(detected);
      if (!current(request)) return;
      set({
        binaryPath: result.binary_path,
        configDirectory: result.config_directory,
      });
      if (!result.installed || result.error) {
        set({
          status: result.installed ? "error" : "not-installed",
          error:
            result.error ?? "Install Pi in your terminal, then check again.",
          version: result.version,
        });
        return;
      }
      set({ status: "ready", version: result.version });
      await get().refreshModels();
    } catch (error) {
      if (!current(request)) return;
      set({
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },
  refreshModels: async () => {
    if (!useSettingsStore.getState().enabledProviders.pi) return;
    if (
      useSettingsStore.getState().piBinaryPaths?.length === 0 ||
      useSettingsStore.getState().piConfigDirectories?.length === 0
    )
      return;
    const request = generation;
    set({ modelsStatus: "loading", modelsError: null });
    try {
      if (discovery?.generation !== request) {
        const pending = {
          generation: request,
          promise: invoke<PiModelInfo[]>("list_pi_models", {
            piConfig: piConfigFromSettings(),
          }),
        };
        discovery = pending;
        void pending.promise
          .finally(() => {
            if (discovery === pending) discovery = null;
          })
          .catch(() => {});
      }
      const models = (await discovery.promise).filter(
        (model) => model.id?.trim() && model.provider?.trim(),
      );
      if (!current(request)) return;
      if (!models.length)
        throw new Error(
          "No Pi models available. Configure Pi in your terminal, then check again.",
        );
      const settings = useSettingsStore.getState();
      if (!settings.defaultPiModel || settings.defaultPiModel === "default") {
        settings.setDefaultPiModel(initialPiModelValue(models));
      }
      set({ models, modelsStatus: "ready" });
    } catch (error) {
      if (!current(request)) return;
      set({
        models: [],
        modelsStatus: "error",
        modelsError: error instanceof Error ? error.message : String(error),
      });
    }
  },
}));

const unsubscribe = useSettingsStore.subscribe((state, previous) => {
  const pathsChanged =
    state.piBinaryPath !== previous.piBinaryPath ||
    state.piConfigDirectory !== previous.piConfigDirectory;
  if (
    !pathsChanged &&
    state.enabledProviders.pi === previous.enabledProviders.pi
  )
    return;
  if (pathsChanged) state.setDefaultPiModel("");
  if (state.enabledProviders.pi) void usePiSetupStore.getState().checkStatus();
  else {
    ++generation;
    usePiSetupStore.setState({
      status: "disabled",
      version: null,
      binaryPath: null,
      configDirectory: null,
      models: [],
      modelsStatus: "idle",
      modelsError: null,
      error: null,
    });
  }
});
if (import.meta.hot) import.meta.hot.dispose(unsubscribe);
