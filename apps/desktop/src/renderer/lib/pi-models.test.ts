import { describe, expect, it } from "vitest";
import {
  findPiModel,
  initialPiModelValue,
  piModelThinkingLevels,
  piModelValue,
  resolvePiThinkingLevel,
  type PiModelInfo,
} from "./pi-models";

const model: PiModelInfo = {
  id: "same-id",
  provider: "a",
  name: "Test",
  reasoning: true,
};
const restricted: PiModelInfo = {
  ...model,
  provider: "b",
  isDefault: true,
  thinkingLevelMap: {
    off: null,
    minimal: null,
    low: null,
    xhigh: "xhigh",
    max: "max",
  },
};

describe("Pi model thinking capabilities", () => {
  it("uses Pi's standard levels when a reasoning model has no overrides", () => {
    expect(piModelThinkingLevels(model)).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
    ]);
  });
  it("omits disabled levels and includes explicitly supported extended levels", () => {
    expect(piModelThinkingLevels(restricted)).toEqual([
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(
      piModelThinkingLevels({
        ...restricted,
        thinkingLevelMap: { xhigh: null, max: null },
      }),
    ).toEqual(["off", "minimal", "low", "medium", "high"]);
  });
  it("chooses a concrete initial model within scope and distinguishes providers", () => {
    expect(findPiModel([model, restricted], "default")).toBeUndefined();
    expect(initialPiModelValue([model, restricted])).toBe(
      piModelValue(restricted),
    );
    expect(initialPiModelValue([model])).toBe(piModelValue(model));
    expect(initialPiModelValue([])).toBe("");
    expect(findPiModel([model, restricted], piModelValue(model))).toBe(model);
  });
  it("preserves supported effort and clamps unsupported effort using Pi's ordering", () => {
    expect(resolvePiThinkingLevel(restricted, "max")).toBe("max");
    expect(resolvePiThinkingLevel(restricted, "low")).toBe("medium");
    expect(resolvePiThinkingLevel(model, "max")).toBe("high");
  });
  it("turns thinking off for non-reasoning models and leaves unknown models to Pi", () => {
    expect(
      resolvePiThinkingLevel({ ...restricted, reasoning: false }, "max"),
    ).toBe("off");
    expect(piModelThinkingLevels(undefined)).toEqual([]);
    expect(resolvePiThinkingLevel(undefined, "high")).toBeUndefined();
    expect(findPiModel([model], "default")).toBeUndefined();
  });
  it("uses Pi's off fallback when every level is disabled", () => {
    const disabled = {
      ...model,
      thinkingLevelMap: Object.fromEntries(
        ["off", "minimal", "low", "medium", "high", "xhigh", "max"].map(
          (level) => [level, null],
        ),
      ),
    };
    expect(piModelThinkingLevels(disabled)).toEqual([]);
    expect(resolvePiThinkingLevel(disabled, "high")).toBe("off");
  });
});
