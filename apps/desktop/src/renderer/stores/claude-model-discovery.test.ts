import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@/lib/desktop/core";
import { useClaudeSetupStore } from "./claude-setup-store";
import type { ClaudeModelInfo } from "@/lib/claude-models";

const model: ClaudeModelInfo = {
  value: "claude-fable-5[1m]",
  displayName: "Fable",
  description: "Fable 5 · Most capable",
};

describe("Claude model discovery", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    useClaudeSetupStore.setState({
      models: [],
      modelsStatus: "idle",
      modelsError: null,
    });
  });
  it("discovers models after authentication, including models without effort metadata", async () => {
    vi.mocked(invoke)
      .mockResolvedValueOnce({ installed: true, authenticated: true })
      .mockResolvedValueOnce([model]);
    await useClaudeSetupStore.getState().checkStatus();
    expect(invoke).toHaveBeenCalledWith("list_claude_models");
    expect(useClaudeSetupStore.getState()).toMatchObject({
      status: "ready",
      modelsStatus: "ready",
      models: [model],
    });
  });
  it("shares concurrent discoveries between mounted composers", async () => {
    let resolve!: (models: ClaudeModelInfo[]) => void;
    vi.mocked(invoke).mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const first = useClaudeSetupStore.getState().refreshModels();
    const second = useClaudeSetupStore.getState().refreshModels();
    expect(invoke).toHaveBeenCalledTimes(1);
    resolve([model]);
    await Promise.all([first, second]);
    expect(useClaudeSetupStore.getState().models).toEqual([model]);
  });
  it("clears stale models on failure and recovers on retry", async () => {
    useClaudeSetupStore.setState({ models: [model], modelsStatus: "ready" });
    vi.mocked(invoke).mockRejectedValueOnce("CLI unavailable");
    await useClaudeSetupStore.getState().refreshModels();
    expect(useClaudeSetupStore.getState()).toMatchObject({
      models: [],
      modelsStatus: "error",
      modelsError: "CLI unavailable",
    });
    vi.mocked(invoke).mockResolvedValueOnce([model]);
    await useClaudeSetupStore.getState().refreshModels();
    expect(useClaudeSetupStore.getState()).toMatchObject({
      models: [model],
      modelsStatus: "ready",
      modelsError: null,
    });
  });
  it("treats an empty catalogue as a recoverable error", async () => {
    vi.mocked(invoke).mockResolvedValueOnce([]);
    await useClaudeSetupStore.getState().refreshModels();
    expect(useClaudeSetupStore.getState().modelsStatus).toBe("error");
  });
});
