import { useSettingsStore } from "./settings-store";
import { create } from "zustand";
import { invoke } from "@/lib/desktop/core";

interface CodexStatus {
  installed: boolean;
  authenticated: boolean;
  binary_path: string | null;
  version: string | null;
  account_label: string | null;
}

export interface CodexModelInfo {
  model: string;
  display_name: string;
  description: string;
  supported_reasoning_efforts: Array<{
    value: string;
    description: string;
  }>;
  default_reasoning_effort: string;
  is_default: boolean;
}

type SetupStatus =
  | "disabled"
  | "checking"
  | "not-installed"
  | "not-authenticated"
  | "ready"
  | "error";

type StepStatus = "pending" | "active" | "complete" | "error";

interface StepInfo {
  id: string;
  label: string;
  status: StepStatus;
}

interface CodexSetupState {
  status: SetupStatus;
  isLoggingIn: boolean;
  error: string | null;
  version: string | null;
  accountLabel: string | null;
  models: CodexModelInfo[];
  modelsStatus: "idle" | "loading" | "ready" | "error";
  modelsError: string | null;
  loginSteps: StepInfo[];
  checkStatus: () => Promise<void>;
  refreshModels: () => Promise<void>;
  login: () => Promise<void>;
  _advanceLoginStep: (stepId: string) => void;
  _failCurrentLoginStep: (error: string) => void;
  _finishLogin: (success: boolean) => void;
}

const LOGIN_STEPS: StepInfo[] = [
  { id: "opening-browser", label: "Opening browser", status: "pending" },
  { id: "waiting-auth", label: "Waiting for sign-in", status: "pending" },
  { id: "complete", label: "Authenticated", status: "pending" },
];

const STEP_ORDER_LOGIN = ["opening-browser", "waiting-auth", "complete"];

let modelDiscoveryRequest: Promise<CodexModelInfo[]> | null = null;

function discoverCodexModels(): Promise<CodexModelInfo[]> {
  if (!modelDiscoveryRequest) {
    modelDiscoveryRequest = invoke<CodexModelInfo[]>(
      "list_codex_models",
    ).finally(() => {
      modelDiscoveryRequest = null;
    });
  }
  return modelDiscoveryRequest;
}

function advanceSteps(steps: StepInfo[], targetId: string): StepInfo[] {
  const targetIdx = STEP_ORDER_LOGIN.indexOf(targetId);
  return steps.map((step) => {
    const thisIdx = STEP_ORDER_LOGIN.indexOf(step.id);
    if (thisIdx < targetIdx && step.status !== "error") {
      return { ...step, status: "complete" as const };
    }
    if (step.id === targetId) {
      return { ...step, status: "active" as const };
    }
    return step;
  });
}

export const useCodexSetupStore = create<CodexSetupState>((set, get) => ({
  status: "checking",
  isLoggingIn: false,
  error: null,
  version: null,
  accountLabel: null,
  models: [],
  modelsStatus: "idle",
  modelsError: null,
  loginSteps: [],

  checkStatus: async () => {
    if (!useSettingsStore.getState().enabledProviders.codex) {
      set({ status: "disabled" });
      return;
    }
    set({ status: "checking", error: null });
    try {
      const result = await invoke<CodexStatus>("check_codex_status");
      if (!useSettingsStore.getState().enabledProviders.codex) return;
      if (!result.installed) {
        set({ status: "not-installed", version: null, accountLabel: null });
        return;
      }
      if (!result.authenticated) {
        set({
          status: "not-authenticated",
          version: result.version,
          accountLabel: result.account_label,
        });
        return;
      }
      set({
        status: "ready",
        version: result.version,
        accountLabel: result.account_label,
      });
      await get().refreshModels();
    } catch (err: any) {
      if (!useSettingsStore.getState().enabledProviders.codex) return;
      set({
        status: "error",
        error: err?.message || String(err),
      });
    }
  },

  refreshModels: async () => {
    if (!useSettingsStore.getState().enabledProviders.codex) {
      set({ status: "disabled" });
      return;
    }
    set({ modelsStatus: "loading", modelsError: null });
    try {
      const models = (await discoverCodexModels()).filter(
        (model) =>
          Boolean(model.model?.trim()) &&
          model.supported_reasoning_efforts.length > 0,
      );
      if (!useSettingsStore.getState().enabledProviders.codex) return;
      if (models.length === 0) {
        throw new Error("Codex returned no available models.");
      }
      set({
        models,
        modelsStatus: "ready",
        modelsError: null,
      });
    } catch (err: any) {
      if (!useSettingsStore.getState().enabledProviders.codex) return;
      set({
        models: [],
        modelsStatus: "error",
        modelsError: err?.message || String(err),
      });
    }
  },

  login: async () => {
    if (!useSettingsStore.getState().enabledProviders.codex) {
      set({ status: "disabled" });
      return;
    }
    const initialSteps = LOGIN_STEPS.map((step, index) => ({
      ...step,
      status: (index === 0 ? "active" : "pending") as StepStatus,
    }));

    set({
      isLoggingIn: true,
      error: null,
      loginSteps: initialSteps,
    });

    try {
      await invoke("login_codex");
    } catch (err: any) {
      set({
        isLoggingIn: false,
        status: "error",
        error: err?.message || String(err),
      });
    }
  },

  _advanceLoginStep: (stepId) => {
    set((state) => ({
      loginSteps: advanceSteps(state.loginSteps, stepId),
    }));
  },

  _failCurrentLoginStep: (error) => {
    set((state) => ({
      loginSteps: state.loginSteps.map((step) =>
        step.status === "active" ? { ...step, status: "error" as const } : step,
      ),
      error,
    }));
  },

  _finishLogin: (success) => {
    if (success) {
      const store = get();
      store._advanceLoginStep("complete");
      setTimeout(() => {
        set((state) => ({
          isLoggingIn: false,
          loginSteps: state.loginSteps.map((step) => ({
            ...step,
            status: "complete" as const,
          })),
        }));
        get().checkStatus();
      }, 500);
    } else {
      const store = get();
      store._failCurrentLoginStep(
        "Authentication failed. If the browser didn't open, try `codex login` in your terminal.",
      );
      set({ isLoggingIn: false, status: "error" });
    }
  },
}));

const unsubscribeProviderSetting = useSettingsStore.subscribe(
  (state, previous) => {
    if (state.enabledProviders.codex === previous.enabledProviders.codex)
      return;
    if (state.enabledProviders.codex)
      void useCodexSetupStore.getState().checkStatus();
    else useCodexSetupStore.setState({ status: "disabled" });
  },
);

if (import.meta.hot) import.meta.hot.dispose(unsubscribeProviderSetting);
