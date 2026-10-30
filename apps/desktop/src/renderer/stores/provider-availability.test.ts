import { afterEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@/lib/desktop/core";
import { useSettingsStore } from "./settings-store";
import { useClaudeSetupStore } from "./claude-setup-store";
import { useCodexSetupStore } from "./codex-setup-store";

const providers = [
  ["claude", useClaudeSetupStore],
  ["codex", useCodexSetupStore],
] as const;
afterEach(() => {
  vi.mocked(invoke).mockResolvedValue({ installed: false });
  useSettingsStore.setState({
    enabledProviders: { claude: true, codex: true, pi: false },
  });
});
describe("provider availability preferences", () => {
  it.each(
    providers,
  )("%s skips checks and model discovery when disabled", async (provider, store) => {
    useSettingsStore.getState().setProviderEnabled(provider, false);
    vi.mocked(invoke).mockClear();
    await store.getState().checkStatus();
    await store.getState().refreshModels();
    expect(invoke).not.toHaveBeenCalled();
    expect(store.getState().status).toBe("disabled");
  });
  it.each(
    providers,
  )("%s ignores a check completing after disable", async (provider, store) => {
    let resolve!: (result: unknown) => void;
    vi.mocked(invoke).mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const pending = store.getState().checkStatus();
    useSettingsStore.getState().setProviderEnabled(provider, false);
    resolve({ installed: true, authenticated: true, missing_git: true });
    await pending;
    expect(store.getState().status).toBe("disabled");
  });
  it("allows both providers off and persists the preference", () => {
    useSettingsStore.getState().setProviderEnabled("claude", false);
    useSettingsStore.getState().setProviderEnabled("codex", false);
    expect(
      JSON.parse(localStorage.getItem("catalex-settings")!).state
        .enabledProviders,
    ).toEqual({ claude: false, codex: false, pi: false });
  });
});
