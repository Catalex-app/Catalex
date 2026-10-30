import { describe, expect, it } from "vitest";
import {
  customModelIdError,
  normalizeCustomModels,
  mergeClaudeModels,
  mergeCodexModels,
  type CustomModel,
} from "./custom-models";
import { claudeModelEfforts } from "./claude-models";
import {
  migrateSettingsState,
  useSettingsStore,
} from "@/stores/settings-store";

const custom: CustomModel[] = [
  { provider: "claude", id: "claude-opus-4-6", effort: "default" },
  { provider: "codex", id: "gpt-custom", effort: "high" },
];

describe("custom models", () => {
  it("retains verified display names in persisted models and model options", () => {
    const models = normalizeCustomModels([
      { ...custom[1], displayName: "  Legacy GPT  " },
    ]);
    expect(models[0].displayName).toBe("Legacy GPT");
    expect(mergeCodexModels([], models)[0].display_name).toBe("Legacy GPT");
  });
  it("validates IDs without restricting future models and deployment IDs", () => {
    for (const id of [
      "claude-opus-4-6",
      "claude-opus-4-6[1m]",
      "vendor/deployment_v2",
      "us.anthropic.claude-opus-4-6-v1:0",
      "gpt-custom",
      " model-v2 ",
    ])
      expect(customModelIdError(id)).toBeNull();
    for (const id of [
      "",
      "   ",
      "Opus 4.6",
      "--model",
      "model\nother",
      "model;cmd",
      "opusplan",
      "x".repeat(201),
    ])
      expect(customModelIdError(id)).not.toBeNull();
  });
  it("migrates old settings and normalizes stored entries without duplicating IDs", () => {
    expect(migrateSettingsState({}).customModels).toEqual([]);
    expect(
      normalizeCustomModels([
        null,
        { provider: "unknown", id: "test" },
        ...custom,
        { ...custom[0], id: " claude-opus-4-6 " },
        { provider: "claude", id: "valid-model", effort: "invalid" },
      ]),
    ).toEqual([
      ...custom,
      { provider: "claude", id: "valid-model", effort: "default" },
    ]);
  });
  it("preserves provider-discovered metadata and does not invent Claude effort support", () => {
    expect(claudeModelEfforts(mergeClaudeModels([], custom)[0])).toEqual([]);
    const discovered = {
      value: "opus",
      resolvedModel: "claude-opus-4-6",
      displayName: "Opus",
      description: "Discovered",
      supportedEffortLevels: ["high" as const],
    };
    expect(mergeClaudeModels([discovered], custom)).toEqual([discovered]);
    const codex = mergeCodexModels([], custom)[0];
    expect(codex.default_reasoning_effort).toBe("high");
    expect(
      mergeCodexModels([{ ...codex, description: "Discovered" }], custom),
    ).toHaveLength(1);
  });
  it("persists custom entries and only removes the requested provider's model", async () => {
    useSettingsStore.setState({ customModels: [] });
    for (const model of custom)
      useSettingsStore.getState().addCustomModel(model);
    useSettingsStore.getState().addCustomModel(custom[0]);
    const saved = JSON.parse(localStorage.getItem("catalex-settings")!);
    expect(saved.state.customModels).toEqual(custom);
    useSettingsStore.getState().removeCustomModel("claude", custom[0].id);
    expect(useSettingsStore.getState().customModels).toEqual([custom[1]]);
    await useSettingsStore.persist.rehydrate();
    expect(useSettingsStore.getState().customModels).toEqual([custom[1]]);
  });
});
