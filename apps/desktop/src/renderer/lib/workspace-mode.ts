export type WorkspaceMode = "artisan" | "duet";
export type ChatLayout = "drawer" | "workspace";

export interface ProjectWorkspacePreferences {
  mode: WorkspaceMode;
  chatLayout: ChatLayout;
}

export const DEFAULT_WORKSPACE_PREFERENCES: ProjectWorkspacePreferences = {
  mode: "duet",
  chatLayout: "drawer",
};

export function normalizeWorkspacePreferences(
  value: unknown,
): ProjectWorkspacePreferences | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.mode !== "artisan" && candidate.mode !== "duet") return null;
  return {
    mode: candidate.mode,
    chatLayout: candidate.chatLayout === "workspace" ? "workspace" : "drawer",
  };
}

export function normalizeWorkspacePreferencesByProject(
  value: unknown,
  legacyModes?: unknown,
): Record<string, ProjectWorkspacePreferences> {
  const result: Record<string, ProjectWorkspacePreferences> = {};
  if (
    legacyModes &&
    typeof legacyModes === "object" &&
    !Array.isArray(legacyModes)
  ) {
    for (const [root, mode] of Object.entries(legacyModes)) {
      if (mode === "pure" || mode === "sidecar" || mode === "handoff") {
        result[root] = {
          mode: mode === "pure" ? "artisan" : "duet",
          chatLayout: mode === "handoff" ? "workspace" : "drawer",
        };
      }
    }
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [root, preference] of Object.entries(value)) {
      const normalized = normalizeWorkspacePreferences(preference);
      if (normalized) result[root] = normalized;
    }
  }
  return result;
}
