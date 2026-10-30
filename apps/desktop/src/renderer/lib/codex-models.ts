export function formatCodexModelName(model: string): string {
  return model
    .split("-")
    .map((part) => {
      const lower = part.toLowerCase();
      if (lower === "gpt") return "GPT";
      if (/^\d+(?:\.\d+)?$/.test(part)) return part;
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join("-");
}

export function codexEffortLabel(level: string): string {
  if (level === "xhigh") return "Extra High";
  return level
    .split(/[-_]/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
