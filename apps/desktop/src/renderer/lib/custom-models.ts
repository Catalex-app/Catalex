import {
  type ClaudeEffortLevel,
  type ClaudeModelInfo,
  findClaudeModel,
  formatClaudeModelName,
  sortClaudeModels,
} from "./claude-models";
import { formatCodexModelName } from "./codex-models";
import type { CodexModelInfo } from "@/stores/codex-setup-store";

export interface CustomModel {
  provider: "claude" | "codex";
  id: string;
  effort: string;
  displayName?: string;
}

export const CUSTOM_MODEL_EFFORTS = {
  claude: ["default", "low", "medium", "high", "xhigh", "max"],
  codex: ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"],
};

export function customModelIdError(id: string): string | null {
  if (!id.trim()) return "Enter a model ID.";
  if (
    id.trim().length > 200 ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*(?:\[1m\])?$/.test(id.trim())
  ) {
    return "Use a model ID without spaces, such as claude-opus-4-6 or gpt-5.4.";
  }
  if (id.trim().toLowerCase() === "opusplan")
    return "Use opus or an exact Claude model ID; plan-mode aliases are not supported.";
  return null;
}

export function normalizeCustomModels(value: unknown): CustomModel[] {
  if (!Array.isArray(value)) return [];
  const models: CustomModel[] = [];
  for (const item of value) {
    if (
      !item ||
      (item.provider !== "claude" && item.provider !== "codex") ||
      typeof item.id !== "string" ||
      customModelIdError(item.id)
    )
      continue;
    const provider: CustomModel["provider"] = item.provider;
    const id = item.id.trim();
    if (models.some((model) => model.provider === provider && model.id === id))
      continue;
    models.push({
      provider,
      id,
      ...(typeof item.displayName === "string" && item.displayName.trim()
        ? { displayName: item.displayName.trim() }
        : {}),
      effort: CUSTOM_MODEL_EFFORTS[provider].includes(item.effort)
        ? item.effort
        : provider === "claude"
          ? "default"
          : "medium",
    });
  }
  return models;
}

export function mergeClaudeModels(
  discovered: ClaudeModelInfo[],
  custom: CustomModel[],
): ClaudeModelInfo[] {
  return sortClaudeModels([
    ...discovered,
    ...custom
      .filter(
        (model) =>
          model.provider === "claude" && !findClaudeModel(discovered, model.id),
      )
      .map((model) => ({
        value: model.id,
        displayName: model.displayName || formatClaudeModelName(model.id),
        description: "Legacy model",
        supportedEffortLevels:
          model.effort === "default" ? [] : [model.effort as ClaudeEffortLevel],
      })),
  ]);
}

export function mergeCodexModels(
  discovered: CodexModelInfo[],
  custom: CustomModel[],
): CodexModelInfo[] {
  return [
    ...discovered,
    ...custom
      .filter(
        (model) =>
          model.provider === "codex" &&
          !discovered.some((known) => known.model === model.id),
      )
      .map((model) => ({
        model: model.id,
        display_name: model.displayName || formatCodexModelName(model.id),
        description: "Legacy model",
        // Custom IDs have no catalogue capabilities. Keep effort independently
        // configurable; the provider validates the requested model/effort pair.
        supported_reasoning_efforts: CUSTOM_MODEL_EFFORTS.codex.map(
          (value) => ({
            value,
            description: "Provider support depends on the legacy model",
          }),
        ),
        default_reasoning_effort: model.effort,
        is_default: false,
      })),
  ];
}

export function customModelDisplayName(
  model: Pick<CustomModel, "provider" | "id" | "displayName">,
): string {
  return (
    model.displayName ||
    (model.provider === "claude"
      ? formatClaudeModelName(model.id)
      : formatCodexModelName(model.id))
  );
}
