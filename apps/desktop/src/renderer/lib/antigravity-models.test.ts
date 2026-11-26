import { describe, expect, it } from "vitest";
import {
  antigravityDropdowns,
  antigravityHistoryModelLabel,
  findAntigravityModel,
  groupAntigravityModels,
  pickAntigravityModel,
} from "./antigravity-models";

const catalog = `gemini-4-neon-high\tGemini 4 Neon (High)
gemini-4-neon-xhigh\tGemini 4 Neon (XHigh)
gemini-4-neon-medium\tGemini 4 Neon (Medium)
gemini-4-neon-low\tGemini 4 Neon (Low)
gemini-4-carbon-medium\tGemini 4 Carbon (Medium)
gemini-4-carbon-high\tGemini 4 Carbon (High)
gemini-4-carbon-low\tGemini 4 Carbon (Low)
gemini-4-argon-medium\tGemini 4 Argon (Medium)
gemini-4-argon-high\tGemini 4 Argon (High)
gemini-4-argon-low\tGemini 4 Argon (Low)
gemini-4-hydrogen-high\tGemini 4 Hydrogen (High)
gemini-4-hydrogen-xhigh\tGemini 4 Hydrogen (XHigh)
gemini-4-hydrogen-medium\tGemini 4 Hydrogen (Medium)
gemini-4-hydrogen-low\tGemini 4 Hydrogen (Low)
gemini-pro-orchestrator-neon\tOrchestrator (Neon)
gemini-pro-orchestrator\tOrchestrator (Carbon)
gemini-pro-orchestrator-argon\tOrchestrator (Argon)
gemini-3.8-flash-high\tGemini 3.8 Flash (High)
gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)
gemini-3.8-flash-low\tGemini 3.8 Flash (Low)
claude-opus-5-5-low\tClaude Opus 5.5 (Low)
claude-opus-5-5-medium\tClaude Opus 5.5 (Medium)
claude-opus-5-5-high\tClaude Opus 5.5 (High)
claude-sonnet-5-5-low\tClaude Sonnet 5.5 (Low)
claude-sonnet-5-5-medium\tClaude Sonnet 5.5 (Medium)
claude-sonnet-5-5-high\tClaude Sonnet 5.5 (High)
gpt-oss-120b-medium\tGPT-OSS 120B (Medium)`
  .split("\n")
  .map((row) => {
    const [value, label] = row.split("\t");
    return { value, label };
  });

describe("Antigravity model choices", () => {
  it("groups the 27-entry CLI catalog while keeping every full ID", () => {
    const groups = groupAntigravityModels(catalog);
    expect(groups).toHaveLength(11);
    expect(
      groups
        .flatMap(({ value, efforts }) =>
          efforts.length ? efforts.map(({ id }) => id) : [value],
        )
        .sort(),
    ).toEqual(catalog.map(({ value }) => value).sort());
    expect(findAntigravityModel(groups, "gemini-4-neon-xhigh").effort).toBe(
      "xhigh",
    );
    expect(
      groups
        .find(({ label }) => label === "Gemini 4 Neon")
        ?.efforts.map(({ level }) => level),
    ).toEqual(["low", "medium", "high", "xhigh"]);
    expect(
      groups.find(({ label }) => label === "GPT-OSS 120B")?.efforts,
    ).toEqual([{ level: "medium", id: "gpt-oss-120b-medium" }]);
    const orchestrators = catalog.filter(({ label }) =>
      label.startsWith("Orchestrator ("),
    );
    expect(orchestrators).toHaveLength(3);
    for (const model of orchestrators) {
      const { group, effort } = findAntigravityModel(groups, model.value);
      expect(effort).toBe("default");
      expect(group).toEqual({
        ...model,
        efforts: [{ level: "default", id: model.value }],
      });
      expect(pickAntigravityModel(group!, "high")).toBe(model.value);
    }
  });

  it("selects the requested effort, then Medium, then the first available", () => {
    const groups = groupAntigravityModels(catalog);
    const carbon = groups.find(({ label }) => label === "Gemini 4 Carbon")!;
    expect(pickAntigravityModel(carbon, "high")).toBe("gemini-4-carbon-high");
    expect(pickAntigravityModel(carbon, "xhigh")).toBe(
      "gemini-4-carbon-medium",
    );
    const [limited] = groupAntigravityModels([
      { value: "limited-high", label: "Limited (High)" },
      { value: "limited-low", label: "Limited (Low)" },
    ]);
    expect(pickAntigravityModel(limited, "xhigh")).toBe("limited-low");
    expect(findAntigravityModel(groups, "removed-high").group).toBeUndefined();
  });

  it("keeps equal labels with different ID stems separate", () => {
    const models = [
      { value: "a-high", label: "Example (High)" },
      { value: "a-low", label: "Example (Low)" },
      { value: "b-medium", label: "Example (Medium)" },
    ];
    const groups = groupAntigravityModels(models);
    expect(groups.map(({ efforts }) => efforts.map(({ id }) => id))).toEqual([
      ["a-low", "a-high"],
      ["b-medium"],
    ]);
    expect(findAntigravityModel(groups, "b")).toEqual({
      group: groups[1],
      effort: undefined,
    });
  });

  it("uses Default for fixed models and preserves mismatched IDs", () => {
    const options = [
      { value: "fixed", label: "Fixed (Preview)" },
      { value: "fixed-max", label: "Fixed (Max)" },
      { value: "odd-low", label: "Odd (High)" },
    ];
    const groups = groupAntigravityModels(options);
    expect(findAntigravityModel(groups, "fixed").effort).toBe("default");
    expect(pickAntigravityModel(groups[0], "medium")).toBe("fixed");
    expect(findAntigravityModel(groups, "fixed-max").effort).toBe("default");
    expect(findAntigravityModel(groups, "odd-low").group?.label).toBe(
      "Odd (High)",
    );
    expect(pickAntigravityModel(groups[2], "high")).toBe("odd-low");
  });

  it("labels known historical models and preserves unknown saved IDs", () => {
    const groups = groupAntigravityModels(catalog);
    expect(antigravityHistoryModelLabel(groups, "gemini-4-neon-high")).toBe(
      "Gemini 4 Neon · High",
    );
    expect(
      antigravityHistoryModelLabel(groups, "gemini-pro-orchestrator"),
    ).toBe("Orchestrator (Carbon)");
    expect(antigravityHistoryModelLabel(groups, "retired-model")).toBe(
      "retired-model",
    );
    const selected: string[] = [];
    const dropdowns = antigravityDropdowns("retired-model", catalog, (id) =>
      selected.push(id),
    );
    expect(dropdowns.model.value).toBe("retired-model");
    expect(dropdowns.model.options[0]).toEqual({
      value: "retired-model",
      label: "retired-model (saved default)",
    });
    dropdowns.model.onChange("retired-model");
    expect(selected).toEqual([]);
  });
});
