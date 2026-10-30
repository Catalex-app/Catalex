export type ClaudeEffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

export interface ClaudeModelInfo {
  value: string;
  displayName: string;
  description: string;
  resolvedModel?: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: ClaudeEffortLevel[];
}

export function sortClaudeModels(models: ClaudeModelInfo[]): ClaudeModelInfo[] {
  const families = ["fable", "opus", "sonnet", "haiku"];
  const rank = (model: ClaudeModelInfo) => {
    if (model.value === "default") return -1;
    if (["best", "opusplan"].includes(model.value)) return families.length;
    const name =
      `${model.value} ${model.resolvedModel ?? ""} ${model.displayName}`.toLowerCase();
    const family = name.match(
      /(?:^|[-/.\s])(fable|opus|sonnet|haiku)(?=$|[-[.\s])/,
    )?.[1];
    return family ? families.indexOf(family) : families.length;
  };
  // Stable within each family, preserving the CLI's order of versions and others.
  return [...models].sort((left, right) => rank(left) - rank(right));
}

export function normalizeClaudeModelId(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const model = value.trim();
  return model.toLowerCase() === "opusplan" ? "opus" : model;
}

export function findClaudeModel(
  models: ClaudeModelInfo[],
  value: string | null,
) {
  return (
    models.find((model) => model.value === value) ??
    models.find((model) => model.resolvedModel === value)
  );
}

export function formatClaudeModelName(id: string): string {
  const match = id.match(
    /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?((?:-\d{8})?)(\[1m\])?$/i,
  );
  if (match) {
    const [, family, major, minor, date, context] = match;
    return `${family[0].toUpperCase()}${family.slice(1)} ${major}${minor ? `.${minor}` : ""}${date ? ` (${date.slice(1)})` : ""}${context ? " (1M)" : ""}`;
  }
  return /^[a-z]+$/i.test(id) ? `${id[0].toUpperCase()}${id.slice(1)}` : id;
}

export function claudeModelLabel(
  value: string | null,
  models: ClaudeModelInfo[] = [],
): string {
  if (!value) return "Claude";
  const model = findClaudeModel(models, value);
  const selectionId = model?.value ?? value;
  const wireId = model?.resolvedModel || model?.value || value;
  if (wireId.startsWith("claude-") || model?.resolvedModel) {
    const resolved = formatClaudeModelName(wireId);
    if (selectionId === "default") return `Default (${resolved})`;
    return ["best", "opusplan"].includes(selectionId)
      ? `${resolved} (${selectionId})`
      : resolved;
  }
  // Older CLIs provide the version in the description, without resolvedModel.
  // Use that display information without inventing a wire ID from it.
  const versionLabel = model?.description.match(
    /^(?:Claude\s+)?([A-Za-z]+\s+\d+(?:\.\d+)*)(?:\s|[·(]|$)/,
  )?.[1];
  if (versionLabel) {
    if (selectionId === "default") return `Default (${versionLabel})`;
    return `${versionLabel}${["best", "opusplan"].includes(selectionId) ? ` (${selectionId})` : ""}`;
  }
  if (selectionId === "default") return "Default";
  return (
    model?.displayName.replace(/^Claude\s+/i, "") ||
    formatClaudeModelName(value)
  );
}

export function claudeModelEfforts(
  model: ClaudeModelInfo | undefined,
): ClaudeEffortLevel[] {
  if (model?.supportsEffort === false) return [];
  return (
    model?.supportedEffortLevels ??
    (model?.supportsEffort ? ["low", "medium", "high"] : [])
  );
}
