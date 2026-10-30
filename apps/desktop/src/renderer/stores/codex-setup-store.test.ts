import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@/lib/desktop/core";
import { useCodexSetupStore, type CodexModelInfo } from "./codex-setup-store";

const model: CodexModelInfo = {
  model: "gpt-6-astra",
  display_name: "GPT-6 Astra",
  description: "Available model",
  supported_reasoning_efforts: [{ value: "high", description: "High" }],
  default_reasoning_effort: "high",
  is_default: true,
};

describe("Codex model discovery", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    useCodexSetupStore.setState({
      models: [],
      modelsStatus: "idle",
      modelsError: null,
    });
  });

  it("reports the underlying error and clears stale models", async () => {
    useCodexSetupStore.setState({ models: [model], modelsStatus: "ready" });
    vi.mocked(invoke).mockRejectedValueOnce(
      "Codex did not discover Catalex's built-in skill.",
    );
    await useCodexSetupStore.getState().refreshModels();
    expect(useCodexSetupStore.getState()).toMatchObject({
      models: [],
      modelsStatus: "error",
      modelsError: "Codex did not discover Catalex's built-in skill.",
    });
  });

  it.each([
    { models: [] },
    { models: [{ ...model, supported_reasoning_efforts: [] }] },
  ])("reports an empty usable catalog as an error: $models", async ({
    models,
  }) => {
    vi.mocked(invoke).mockResolvedValueOnce(models);
    await useCodexSetupStore.getState().refreshModels();
    expect(useCodexSetupStore.getState()).toMatchObject({
      models: [],
      modelsStatus: "error",
      modelsError: "Codex returned no available models.",
    });
  });

  it("retries successfully without retaining an old error", async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error("Discovery failed"));
    await useCodexSetupStore.getState().refreshModels();
    vi.mocked(invoke).mockResolvedValueOnce([model]);
    await useCodexSetupStore.getState().refreshModels();
    expect(useCodexSetupStore.getState()).toMatchObject({
      models: [model],
      modelsStatus: "ready",
      modelsError: null,
    });
  });
});
