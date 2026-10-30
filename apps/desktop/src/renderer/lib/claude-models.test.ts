import { describe, expect, it } from "vitest";
import {
  sortClaudeModels,
  claudeModelLabel,
  claudeModelEfforts,
  findClaudeModel,
  normalizeClaudeModelId,
  type ClaudeModelInfo,
} from "./claude-models";

describe("Claude model catalogue", () => {
  const models: ClaudeModelInfo[] = [
    {
      value: "opus",
      displayName: "Opus",
      description: "An older label: Opus 4.6",
      resolvedModel: "claude-opus-4-8",
    },
    {
      value: "sonnet",
      displayName: "Sonnet",
      description: "Sonnet 4.6 · Efficient for routine tasks",
    },
    {
      value: "claude-fable-5[1m]",
      displayName: "Fable",
      description: "Most capable",
      supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
    },
    {
      value: "future-model",
      displayName: "Claude Future Model",
      description: "No version reported",
    },
  ];

  it("orders Default first, then Fable, Opus, Sonnet, Haiku, and others", () => {
    const defaults = {
      value: "default",
      displayName: "Default",
      description: "Sonnet 4.6",
      resolvedModel: "claude-sonnet-4-6",
    };
    const haiku = {
      value: "haiku",
      displayName: "Haiku",
      description: "Haiku 4.5",
    };
    const unordered = [
      haiku,
      models[1],
      models[3],
      models[0],
      models[2],
      defaults,
    ];
    expect(sortClaudeModels(unordered).map((model) => model.value)).toEqual([
      "default",
      "claude-fable-5[1m]",
      "opus",
      "sonnet",
      "haiku",
      "future-model",
    ]);
    expect(unordered[0]).toBe(haiku);
  });

  it("prefers resolved IDs over stale human labels", () => {
    expect(claudeModelLabel("opus", models)).toBe("Opus 4.8");
    expect(findClaudeModel(models, "claude-opus-4-8")).toBe(models[0]);
    expect(
      claudeModelLabel("default", [{ ...models[0], value: "default" }]),
    ).toBe("Default (Opus 4.8)");
    expect(claudeModelLabel("default")).toBe("Default");
  });
  it("shows versions from older CLI descriptions without synthesizing model IDs", () => {
    expect(claudeModelLabel("sonnet", models)).toBe("Sonnet 4.6");
    expect(models[1].resolvedModel).toBeUndefined();
    expect(
      claudeModelLabel("default", [{ ...models[1], value: "default" }]),
    ).toBe("Default (Sonnet 4.6)");
  });
  it("shows Fable's explicit version and supported effort levels", () => {
    expect(claudeModelLabel(models[2].value, models)).toBe("Fable 5 (1M)");
    expect(claudeModelEfforts(models[2])).toContain("max");
    expect(claudeModelEfforts({ ...models[2], supportsEffort: false })).toEqual(
      [],
    );
    expect(claudeModelEfforts(models[1])).toEqual([]);
  });
  it("keeps unknown models usable without inventing versions", () => {
    expect(claudeModelLabel("future-model", models)).toBe("Future Model");
    expect(claudeModelLabel("vendor/deployment-v7", models)).toBe(
      "vendor/deployment-v7",
    );
  });
  it.each([
    "claude-fable-5[1m]",
    "claude-sonnet-4-5-20250929",
    "vendor/deployment-v7",
  ])("preserves the full saved ID %s", (id) => {
    expect(normalizeClaudeModelId(` ${id} `)).toBe(id);
  });
  it("retains the existing OpusPlan migration without collapsing versioned IDs", () => {
    expect(normalizeClaudeModelId("opusplan")).toBe("opus");
    expect(normalizeClaudeModelId(null)).toBeNull();
  });
});
