import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@/lib/desktop/core";
import { useSettingsStore } from "./settings-store";
import { usePiSetupStore } from "./pi-setup-store";

beforeEach(() => {
  useSettingsStore.setState({
    piBinaryPath: "",
    piConfigDirectory: "",
    piBinaryPaths: null,
    piConfigDirectories: null,
  });
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "check_pi_status")
      return { installed: true, version: "1.2.0" };
    if (command === "list_pi_models")
      return [
        { id: "model", provider: "test", name: "Model", reasoning: true },
      ];
    return undefined;
  });
});
afterEach(() => useSettingsStore.getState().setProviderEnabled("pi", false));

describe("Pi setup", () => {
  it("does not probe an opted-out installation", async () => {
    useSettingsStore.getState().setProviderEnabled("pi", false);
    vi.mocked(invoke).mockClear();
    await usePiSetupStore.getState().checkStatus();
    await usePiSetupStore.getState().refreshModels();
    expect(invoke).not.toHaveBeenCalled();
  });
  it("discovers configured models after enabling Pi", async () => {
    useSettingsStore.getState().setDefaultPiModel("default");
    useSettingsStore.getState().setProviderEnabled("pi", true);
    await vi.waitFor(() =>
      expect(usePiSetupStore.getState().modelsStatus).toBe("ready"),
    );
    expect(usePiSetupStore.getState().models[0].provider).toBe("test");
    expect(usePiSetupStore.getState().version).toBe("1.2.0");
    expect(useSettingsStore.getState().defaultPiModel).toBe('["test","model"]');
  });
  it("explains how to configure an installation without available models", async () => {
    vi.mocked(invoke).mockImplementation(async (command) =>
      command === "check_pi_status" ? { installed: true } : [],
    );
    useSettingsStore.getState().setProviderEnabled("pi", true);
    await vi.waitFor(() =>
      expect(usePiSetupStore.getState().modelsStatus).toBe("error"),
    );
    expect(usePiSetupStore.getState().modelsError).toContain(
      "Configure Pi in your terminal",
    );
  });
  it("ignores model discovery that finishes after Pi is disabled", async () => {
    let resolve!: (models: unknown) => void;
    vi.mocked(invoke).mockImplementation(async (command) =>
      command === "check_pi_status"
        ? { installed: true }
        : new Promise((done) => {
            resolve = done;
          }),
    );
    useSettingsStore.getState().setProviderEnabled("pi", true);
    await vi.waitFor(() =>
      expect(usePiSetupStore.getState().modelsStatus).toBe("loading"),
    );
    useSettingsStore.getState().setProviderEnabled("pi", false);
    resolve([{ id: "model", provider: "test" }]);
    await new Promise((done) => setTimeout(done, 0));
    expect(usePiSetupStore.getState().status).toBe("disabled");
    expect(usePiSetupStore.getState().models).toEqual([]);
  });
  it("uses selected paths and ignores stale discovery across configuration switches", async () => {
    let resolveOld!: (models: unknown) => void;
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "check_pi_status") {
        const config = args?.piConfig as {
          binaryPath: string;
          configDirectory: string;
        };
        return {
          installed: true,
          version: "1.2.0",
          binary_path: config.binaryPath || "/auto/bin/pi",
          config_directory: config.configDirectory || "/auto/config",
        };
      }
      if (command === "list_pi_models") {
        const config = args?.piConfig as { configDirectory: string };
        if (config.configDirectory !== "/config two")
          return new Promise((done) => {
            resolveOld = done;
          });
        return [
          { id: "new", provider: "selected", name: "New", reasoning: true },
        ];
      }
    });
    useSettingsStore.getState().setProviderEnabled("pi", true);
    await vi.waitFor(() => expect(resolveOld).toBeDefined());
    useSettingsStore.setState({
      piBinaryPath: "/custom bin/pi",
      piConfigDirectory: "/config two",
    });
    await vi.waitFor(() =>
      expect(usePiSetupStore.getState().models[0]?.id).toBe("new"),
    );
    expect(invoke).toHaveBeenCalledWith("list_pi_models", {
      piConfig: {
        binaryPath: "/custom bin/pi",
        configDirectory: "/config two",
      },
    });
    expect(useSettingsStore.getState().defaultPiModel).toBe(
      '["selected","new"]',
    );
    resolveOld([{ id: "old", provider: "stale" }]);
    await new Promise((done) => setTimeout(done, 0));
    expect(usePiSetupStore.getState().models[0].id).toBe("new");
    expect(usePiSetupStore.getState().configDirectory).toBe("/config two");
  });
  it("ignores a stale version result and restores automatic paths", async () => {
    let resolveOld!: (status: unknown) => void;
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      const config = args?.piConfig as { binaryPath: string };
      if (command === "check_pi_status" && config.binaryPath === "/slow/pi") {
        return new Promise((done) => {
          resolveOld = done;
        });
      }
      if (command === "check_pi_status")
        return {
          installed: true,
          version: "1.2.0",
          binary_path: "/auto/pi",
          config_directory: "/home/.pi/agent",
        };
      return [
        { id: "auto", provider: "auto", name: "Automatic", reasoning: false },
      ];
    });
    useSettingsStore.getState().setPiBinaryPath("/slow/pi");
    useSettingsStore.getState().setProviderEnabled("pi", true);
    await vi.waitFor(() => expect(resolveOld).toBeDefined());
    useSettingsStore.getState().setPiBinaryPath("");
    await vi.waitFor(() =>
      expect(usePiSetupStore.getState().modelsStatus).toBe("ready"),
    );
    resolveOld({ installed: false, error: "Old error" });
    await new Promise((done) => setTimeout(done, 0));
    expect(usePiSetupStore.getState().status).toBe("ready");
    expect(usePiSetupStore.getState().binaryPath).toBe("/auto/pi");
    expect(usePiSetupStore.getState().error).toBeNull();
  });
  it("does not redetect choices after the last entry is removed", async () => {
    useSettingsStore.getState().setPiBinaryPath("/saved/pi");
    useSettingsStore.getState().setPiConfigDirectory("/saved/config");
    useSettingsStore.getState().setProviderEnabled("pi", true);
    await vi.waitFor(() =>
      expect(usePiSetupStore.getState().status).toBe("ready"),
    );
    useSettingsStore.getState().removePiBinaryPath("/saved/pi");
    vi.mocked(invoke).mockClear();
    await usePiSetupStore.getState().checkStatus();
    await usePiSetupStore.getState().refreshModels();
    expect(invoke).not.toHaveBeenCalled();
    expect(usePiSetupStore.getState().version).toBeNull();
    expect(usePiSetupStore.getState().models).toEqual([]);
    expect(usePiSetupStore.getState().error).toContain("Add a Pi installation");
  });
});
