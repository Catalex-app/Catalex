export type UiThemeId = "modern" | "classic";
import type { WorkspaceMode } from "@/lib/workspace-mode";
export type { WorkspaceMode } from "@/lib/workspace-mode";

export const UI_THEMES: Array<{
  id: UiThemeId;
  label: string;
  description: string;
}> = [
  { id: "modern", label: "Modern", description: "Clean, flat surfaces." },
  {
    id: "classic",
    label: "Classic",
    description: "Soft gradients and inset controls.",
  },
];

export const WORKSPACE_MODES: Array<{ id: WorkspaceMode; label: string }> = [
  { id: "artisan", label: "Artisan" },
  { id: "duet", label: "Duet" },
];

export const DEFAULT_MODE_THEMES: Record<WorkspaceMode, UiThemeId> = {
  artisan: "classic",
  duet: "modern",
};

export function normalizeModeThemes(
  value: unknown,
): Record<WorkspaceMode, UiThemeId> {
  const result = { ...DEFAULT_MODE_THEMES };
  if (!value || typeof value !== "object" || Array.isArray(value))
    return result;

  const candidate = value as Record<string, unknown>;
  for (const { id } of WORKSPACE_MODES) {
    const theme =
      candidate[id] ?? candidate[id === "artisan" ? "pure" : "sidecar"];
    if (theme === "modern" || theme === "classic") result[id] = theme;
  }
  return result;
}
