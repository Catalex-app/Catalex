import { codexEffortLabel } from "./codex-models";

const EFFORT_ORDER = ["low", "medium", "high", "xhigh", "default"] as const;
type Effort = (typeof EFFORT_ORDER)[number];
type Model = { value: string; label: string };
export type AntigravityModelGroup = Model & {
  baseId?: string;
  efforts: Array<{ level: Effort; id: string }>;
};

export function groupAntigravityModels(
  models: readonly Model[],
): AntigravityModelGroup[] {
  const groups = new Map<string, AntigravityModelGroup>();
  const options: AntigravityModelGroup[] = [];
  for (const model of models) {
    const match = /^(.*\S) \((Low|Medium|High|XHigh)\)$/.exec(model.label);
    if (!match) {
      options.push({
        ...model,
        efforts: [{ level: "default", id: model.value }],
      });
      continue;
    }
    const level = match[2].toLowerCase() as Effort;
    if (!model.value.endsWith(`-${level}`)) {
      options.push({ ...model, efforts: [] });
      continue;
    }
    const label = match[1];
    const baseId = model.value.slice(0, -level.length - 1);
    const key = JSON.stringify([label, baseId]);
    let group = groups.get(key);
    if (!group) {
      group = { value: model.value, label, baseId, efforts: [] };
      groups.set(key, group);
      options.push(group);
    }
    // Keep both IDs selectable if two entries claim the same level.
    if (group.efforts.some((effort) => effort.level === level)) {
      options.push({ ...model, efforts: [] });
      continue;
    }
    group.efforts.push({ level, id: model.value });
  }
  for (const group of groups.values()) {
    group.efforts.sort(
      (a, b) => EFFORT_ORDER.indexOf(a.level) - EFFORT_ORDER.indexOf(b.level),
    );
  }
  return options;
}

export function findAntigravityModel(
  groups: readonly AntigravityModelGroup[],
  id: string,
) {
  const group =
    groups.find(
      (group) =>
        group.value === id || group.efforts.some((effort) => effort.id === id),
    ) ?? groups.find((group) => group.baseId === id);
  return {
    group,
    effort: group?.efforts.find((effort) => effort.id === id)?.level,
  };
}

export function pickAntigravityModel(
  group: AntigravityModelGroup,
  effort?: string,
) {
  return (
    group.efforts.find((option) => option.level === effort)?.id ??
    group.efforts.find((option) => option.level === "medium")?.id ??
    group.efforts[0]?.id ??
    group.value
  );
}

export function selectAntigravityModel(
  groups: readonly AntigravityModelGroup[],
  value: string,
  effort?: string,
) {
  const group = groups.find((option) => option.value === value);
  return group && pickAntigravityModel(group, effort);
}

export function savedAntigravityModelLabel(id: string) {
  return `${id} (saved default)`;
}

export function antigravityHistoryModelLabel(
  groups: readonly AntigravityModelGroup[],
  id: string,
) {
  const { group, effort } = findAntigravityModel(groups, id);
  if (!group) return id;
  return effort && effort !== "default"
    ? `${group.label} · ${codexEffortLabel(effort)}`
    : group.label;
}

export function antigravityDropdowns(
  id: string,
  models: readonly Model[],
  onChange: (id: string) => void,
) {
  const groups = groupAntigravityModels(models);
  const { group, effort } = findAntigravityModel(groups, id);
  return {
    model: {
      value: group?.value ?? id,
      options:
        id && !group
          ? [{ value: id, label: savedAntigravityModelLabel(id) }, ...groups]
          : groups,
      disabled: !groups.length,
      placeholder: "CLI default",
      onChange: (value: string) => {
        const next = selectAntigravityModel(groups, value, effort);
        if (next) onChange(next);
      },
    },
    effort:
      group && effort
        ? {
            value: effort,
            options: group.efforts.map(({ level }) => ({
              value: level,
              label: codexEffortLabel(level),
            })),
            onChange: (level: string) =>
              onChange(pickAntigravityModel(group, level)),
          }
        : undefined,
  };
}
