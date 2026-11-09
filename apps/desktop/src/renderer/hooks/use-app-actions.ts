import { useId, useLayoutEffect } from "react";
import { toast } from "sonner";
import type {
  MenuAction,
  MenuEntry,
  MenuPlacement,
} from "../../application-menu";

/** The UI owns these actions; menu metadata opts an action into native exposure. */
export interface AppAction {
  id: string;
  label: string;
  run: () => unknown;
  enabled?: boolean;
  visible?: boolean;
  checked?: boolean;
  type?: MenuEntry["type"];
  shortcut?: string | null;
  menu?: MenuPlacement;
  children?: AppAction[];
}

type Target = "active" | "fallback" | "inactive";
const owners = new Map<
  string,
  { actions: readonly AppAction[]; target: Target }
>();
const subscribers = new Set<() => void>();
export function subscribeAppActions(listener: () => void) {
  subscribers.add(listener);
  return () => {
    subscribers.delete(listener);
  };
}
const changed = () => {
  for (const listener of subscribers) listener();
};

/** Registers definitions, never DOM buttons (which may be duplicated in overflow UI). */
export function useAppActions<T extends AppAction>(
  actions: readonly T[],
  target: Target = "active",
): readonly T[] {
  const owner = useId();
  // Callback identities need not rebuild the native menu, but dispatch always uses the latest callback.
  useLayoutEffect(() => {
    owners.set(owner, { actions, target });
    changed();
  });
  useLayoutEffect(
    () => () => {
      owners.delete(owner);
      changed();
    },
    [owner],
  );
  return actions;
}

export function useAppAction<T extends AppAction>(
  action: T,
  target: Target = "active",
): T {
  useAppActions([action], target);
  return action;
}

function resolveActions() {
  const candidates = new Map<
    string,
    { action: AppAction; key: string; target: Target }[]
  >();
  for (const [owner, { actions, target }] of owners) {
    for (const action of actions) {
      if (!action.menu || action.visible === false) continue;
      const entries = candidates.get(action.id) ?? [];
      entries.push({ action, key: `${owner}/${action.id}`, target });
      candidates.set(action.id, entries);
    }
  }
  return [...candidates.values()].map((entries) => {
    const active = entries.filter((entry) => entry.target === "active");
    const eligible = active.length
      ? active
      : entries.filter((entry) => entry.target === "fallback");
    // Ambiguous ownership must never depend on component mount order.
    const selected =
      eligible.length === 1
        ? eligible[0]
        : [...entries].sort((a, b) => a.key.localeCompare(b.key))[0];
    return {
      ...selected,
      enabled: eligible.length === 1 && selected.action.enabled !== false,
    };
  });
}

export function getAppMenuItems(): MenuEntry[] {
  const project = (
    action: AppAction,
    key: string,
    enabled: boolean,
    menu: MenuPlacement,
  ): MenuEntry => ({
    id: action.id,
    key,
    label: action.label,
    menu,
    enabled,
    checked: action.checked,
    type: action.type,
    shortcut: action.shortcut,
    children: action.children
      ?.filter((child) => child.visible !== false)
      .map((child) =>
        project(
          child,
          `${key}/${child.id}`,
          enabled && child.enabled !== false,
          child.menu ?? menu,
        ),
      ),
  });
  return resolveActions().map(({ action, key, enabled }) =>
    project(action, key, enabled, action.menu!),
  );
}

export async function runMenuAction(request: MenuAction) {
  const find = (action: AppAction, key: string): AppAction | undefined => {
    if (action.enabled === false || action.visible === false) return;
    if (key === request.key && action.id === request.command) return action;
    for (const child of action.children ?? []) {
      const match = find(child, `${key}/${child.id}`);
      if (match) return match;
    }
  };
  try {
    for (const entry of resolveActions()) {
      if (!entry.enabled) continue;
      const action = find(entry.action, entry.key);
      if (action) {
        await action.run();
        return;
      }
    }
  } catch (error) {
    toast.error(String(error instanceof Error ? error.message : error));
  }
}
