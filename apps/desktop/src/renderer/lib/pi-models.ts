export interface PiModelInfo {
  id: string;
  provider: string;
  name: string;
  reasoning: boolean;
  contextWindow?: number;
  thinkingLevelMap?: Record<string, string | null | undefined>;
  isDefault?: boolean;
}

const PI_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

export function findPiModel(models: PiModelInfo[], value: string) {
  return models.find((model) => piModelValue(model) === value);
}

export function initialPiModelValue(models: PiModelInfo[]): string {
  const model = models.find((model) => model.isDefault) ?? models[0];
  return model ? piModelValue(model) : "";
}

/** Pi's getSupportedThinkingLevels rules, using its resolved model metadata. */
export function piModelThinkingLevels(
  model: PiModelInfo | undefined,
): string[] {
  if (!model) return [];
  if (!model.reasoning) return ["off"];
  return PI_THINKING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    return level === "xhigh" || level === "max" ? mapped !== undefined : true;
  });
}

/** Match Pi's clamp: next supported level, otherwise the highest lower level. */
export function resolvePiThinkingLevel(
  model: PiModelInfo | undefined,
  requested: string,
): string | undefined {
  if (!model) return undefined;
  const levels = piModelThinkingLevels(model);
  if (!levels.length) return "off";
  if (levels.includes(requested)) return requested;
  const index = PI_THINKING_LEVELS.indexOf(requested);
  if (index < 0) return levels[0];
  return (
    PI_THINKING_LEVELS.slice(index).find((level) => levels.includes(level)) ??
    levels[levels.length - 1]
  );
}

export function piModelValue(model: PiModelInfo): string {
  return JSON.stringify([model.provider, model.id]);
}

export function piModelLabel(
  value: string | null,
  models: PiModelInfo[] = [],
): string {
  const model = models.find((item) => piModelValue(item) === value);
  if (model) return `${model.name || model.id} · ${model.provider}`;
  if (!value || value === "default") return "Choose a model";
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === "string" &&
      typeof parsed[1] === "string"
    )
      return `${parsed[1]} · ${parsed[0]}`;
  } catch {
    /* Saved selections can predate model discovery. */
  }
  return value;
}
