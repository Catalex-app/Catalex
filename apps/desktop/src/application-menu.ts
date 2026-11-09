/** Serializable projection of app actions. Electron does not interpret feature state. */
export interface MenuPlacement {
  group: "File" | "Edit" | "Format" | "View";
  section: number;
  order: number;
  submenu?: string;
}

export interface MenuEntry {
  id: string;
  key: string;
  label: string;
  menu: MenuPlacement;
  enabled: boolean;
  checked?: boolean;
  type?: "normal" | "checkbox" | "radio";
  shortcut?: string | null;
  children?: MenuEntry[];
}

export interface ApplicationMenuState {
  items: MenuEntry[];
  shortcuts: Record<string, string | null>;
  recordingShortcut: boolean;
}

export interface MenuAction {
  command: string;
  key?: string;
}

export function isApplicationMenuState(
  value: unknown,
): value is ApplicationMenuState {
  if (!value || typeof value !== "object") return false;
  const state = value as ApplicationMenuState;
  const validEntry = (entry: MenuEntry, depth = 0): boolean =>
    !!entry &&
    depth < 3 &&
    typeof entry.id === "string" &&
    typeof entry.key === "string" &&
    typeof entry.label === "string" &&
    typeof entry.enabled === "boolean" &&
    !!entry.menu &&
    ["File", "Edit", "Format", "View"].includes(entry.menu.group) &&
    Number.isFinite(entry.menu.section) &&
    Number.isFinite(entry.menu.order) &&
    (entry.menu.submenu === undefined ||
      typeof entry.menu.submenu === "string") &&
    (entry.checked === undefined || typeof entry.checked === "boolean") &&
    (entry.type === undefined ||
      ["normal", "checkbox", "radio"].includes(entry.type)) &&
    (entry.shortcut == null || typeof entry.shortcut === "string") &&
    (entry.children === undefined ||
      (Array.isArray(entry.children) &&
        entry.children.length <= 200 &&
        entry.children.every((child) => validEntry(child, depth + 1))));
  return (
    typeof state.recordingShortcut === "boolean" &&
    Array.isArray(state.items) &&
    state.items.length <= 500 &&
    state.items.every((entry) => validEntry(entry)) &&
    !!state.shortcuts &&
    typeof state.shortcuts === "object" &&
    !Array.isArray(state.shortcuts) &&
    Object.values(state.shortcuts).every(
      (value) => value === null || typeof value === "string",
    )
  );
}
