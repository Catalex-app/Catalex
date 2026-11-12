import {
  app,
  BrowserWindow,
  Menu,
  type MenuItemConstructorOptions,
} from "electron";
import { PRODUCT_NAME } from "../branding";
import type {
  ApplicationMenuState,
  MenuAction,
  MenuEntry,
  MenuPlacement,
} from "../application-menu";

// Settings store bindings use physical key codes; Electron accelerators use key names.
export function menuAccelerator(
  binding: string | null | undefined,
): string | undefined {
  if (!binding) return undefined;
  const keys: Record<string, string> = {
    Mod: "CommandOrControl",
    Meta: "Command",
    Ctrl: "Control",
    Alt: "Alt",
    Shift: "Shift",
    Comma: ",",
    Period: ".",
    Slash: "/",
    Semicolon: ";",
    Quote: "'",
    BracketLeft: "[",
    BracketRight: "]",
    Backslash: "\\",
    Backquote: "`",
    Minus: "-",
    Equal: "Plus",
    Space: "Space",
    ArrowUp: "Up",
    ArrowDown: "Down",
    ArrowLeft: "Left",
    ArrowRight: "Right",
  };
  const parts = binding.split("+");
  const converted = parts.map(
    (part) =>
      keys[part] ??
      (/^(Key[A-Z]|Digit[0-9])$/.test(part)
        ? part.replace(/^(Key|Digit)/, "")
        : /^(F([1-9]|1[0-9]|2[0-4])|Enter|Tab|Escape|Backspace|Delete|Home|End|PageUp|PageDown|Insert)$/.test(
              part,
            )
          ? part
          : undefined),
  );
  return converted.every(Boolean) ? converted.join("+") : undefined;
}

export function buildApplicationMenu(
  state: ApplicationMenuState | undefined,
  dispatch: (action: MenuAction) => void,
  mac = process.platform === "darwin",
  checkingForUpdates = false,
): MenuItemConstructorOptions[] {
  const separator: MenuItemConstructorOptions = { type: "separator" };
  const accelerator = (id: string, fallback?: string | null) =>
    menuAccelerator(
      state && Object.hasOwn(state.shortcuts, id)
        ? state.shortcuts[id]
        : Object.values(state?.shortcuts ?? {}).includes(fallback ?? "")
          ? undefined
          : fallback,
    );
  const native = (
    id: string,
    label: string,
    shortcut?: string,
  ): MenuItemConstructorOptions => ({
    id,
    label,
    accelerator: accelerator(id, shortcut),
    click: () => dispatch({ command: id }),
  });
  const project = (entry: MenuEntry): MenuItemConstructorOptions => ({
    id: entry.id,
    label: entry.label,
    enabled: entry.enabled,
    type: entry.type,
    checked: entry.checked,
    accelerator: accelerator(entry.id, entry.shortcut),
    submenu: entry.children?.map(project),
    click: () => dispatch({ command: entry.id, key: entry.key }),
  });
  const group = (
    name: MenuPlacement["group"],
  ): MenuItemConstructorOptions[] => {
    const entries = (state?.items ?? [])
      .filter((entry) => entry.menu.group === name)
      .sort(
        (a, b) =>
          a.menu.section - b.menu.section ||
          a.menu.order - b.menu.order ||
          a.id.localeCompare(b.id),
      );
    const result: MenuItemConstructorOptions[] = [];
    let section: number | undefined;
    let submenus = new Map<string, MenuItemConstructorOptions[]>();
    for (const entry of entries) {
      if (section !== entry.menu.section) {
        if (result.length) result.push(separator);
        section = entry.menu.section;
        submenus = new Map();
      }
      if (entry.menu.submenu) {
        let submenu = submenus.get(entry.menu.submenu);
        if (!submenu) {
          submenu = [];
          submenus.set(entry.menu.submenu, submenu);
          result.push({ label: entry.menu.submenu, submenu });
        }
        submenu.push(project(entry));
      } else result.push(project(entry));
    }
    return result;
  };
  const file = group("File"),
    edit = group("Edit"),
    format = group("Format"),
    view = group("View");
  const settings = native("open-settings", "Settings…", "Mod+Comma");
  const updates: MenuItemConstructorOptions = {
    id: "check-for-updates",
    label: checkingForUpdates ? "Checking for Updates…" : "Check for Updates…",
    enabled: !checkingForUpdates,
    click: () => dispatch({ command: "check-for-updates" }),
  };
  return [
    ...(mac
      ? [
          {
            label: PRODUCT_NAME,
            submenu: [
              { role: "about" },
              updates,
              settings,
              separator,
              { role: "services" },
              separator,
              { role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              separator,
              { role: "quit" },
            ],
          } as MenuItemConstructorOptions,
        ]
      : []),
    {
      label: "File",
      submenu: [
        native("new-window", "New Window", "Mod+Shift+KeyN"),
        ...file,
        separator,
        { role: "close" },
        ...(!mac
          ? [
              separator,
              settings,
              { role: "quit" } as MenuItemConstructorOptions,
            ]
          : []),
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        separator,
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "pasteAndMatchStyle" },
        { role: "delete" },
        { role: "selectAll" },
        ...(edit.length ? [separator, ...edit] : []),
        ...(mac
          ? [
              separator,
              {
                label: "Speech",
                submenu: [{ role: "startSpeaking" }, { role: "stopSpeaking" }],
              } as MenuItemConstructorOptions,
            ]
          : []),
      ],
    },
    ...(format.length ? [{ label: "Format", submenu: format }] : []),
    {
      label: "View",
      submenu: [
        ...view,
        ...(view.length ? [separator] : []),
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
  ];
}

export function installApplicationMenu(
  dispatch: (win: BrowserWindow | null, action: MenuAction) => void,
) {
  const states = new Map<number, ApplicationMenuState>();
  let activeWindow: BrowserWindow | null = null;
  let shortcuts: ApplicationMenuState["shortcuts"] = {};
  let checkingForUpdates = false;
  // Opening a native menu can temporarily leave no BrowserWindow focused.
  const targetWindow = () =>
    BrowserWindow.getFocusedWindow() ??
    (activeWindow && !activeWindow.isDestroyed() ? activeWindow : null);
  const refresh = () => {
    const win = targetWindow();
    Menu.setApplicationMenu(
      Menu.buildFromTemplate(
        buildApplicationMenu(
          win
            ? states.get(win.id)
            : { items: [], shortcuts, recordingShortcut: false },
          (action) => dispatch(targetWindow(), action),
          process.platform === "darwin",
          checkingForUpdates,
        ),
      ),
    );
  };
  app.on("browser-window-focus", (_event, win) => {
    activeWindow = win;
    refresh();
  });
  refresh();
  return {
    setUpdateChecking(checking: boolean) {
      checkingForUpdates = checking;
      const item =
        Menu.getApplicationMenu()?.getMenuItemById("check-for-updates");
      if (item) {
        item.label = checking ? "Checking for Updates…" : "Check for Updates…";
        item.enabled = !checking;
      }
    },
    update(win: BrowserWindow, state: ApplicationMenuState) {
      states.set(win.id, state);
      shortcuts = state.shortcuts;
      if (!targetWindow()) activeWindow = win;
      if (targetWindow() === win) refresh();
    },
    remove(win: BrowserWindow) {
      states.delete(win.id);
      refresh();
    },
  };
}
