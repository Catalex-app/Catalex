import { describe, expect, it, vi } from "vitest";
import type { MenuItemConstructorOptions } from "electron";
import {
  isApplicationMenuState,
  type ApplicationMenuState,
  type MenuEntry,
} from "../application-menu";
vi.mock("electron", () => ({ app: {}, BrowserWindow: {}, Menu: {} }));
import { buildApplicationMenu, menuAccelerator } from "./application-menu";
const flatten = (
  items: MenuItemConstructorOptions[],
): MenuItemConstructorOptions[] =>
  items.flatMap((item) => [
    item,
    ...flatten(Array.isArray(item.submenu) ? item.submenu : []),
  ]);
const entry = (overrides: Partial<MenuEntry> = {}): MenuEntry => ({
  id: "future",
  key: "owner/future",
  label: "Future action",
  enabled: true,
  menu: { group: "View", section: 0, order: 0 },
  ...overrides,
});
const state = (items: MenuEntry[]): ApplicationMenuState => ({
  items,
  shortcuts: {},
  recordingShortcut: false,
});

describe("native action projection", () => {
  it("validates optional context-menu shortcut ownership", () => {
    expect(
      isApplicationMenuState({ ...state([]), contextMenuOpen: true }),
    ).toBe(true);
    expect(
      isApplicationMenuState({ ...state([]), contextMenuOpen: false }),
    ).toBe(true);
    expect(
      isApplicationMenuState({ ...state([]), contextMenuOpen: "true" }),
    ).toBe(false);
    expect(isApplicationMenuState(state([]))).toBe(true);
  });

  it("discovers new actions without a native catalog and preserves labels, selection, availability and routing", () => {
    const dispatch = vi.fn();
    const items = flatten(
      buildApplicationMenu(
        state([entry({ label: "Table", type: "radio", checked: true })]),
        dispatch,
      ),
    );
    const item = items.find((item) => item.id === "future")!;
    expect(item).toMatchObject({
      label: "Table",
      type: "radio",
      checked: true,
      enabled: true,
    });
    (item.click as () => void)();
    expect(dispatch).toHaveBeenCalledWith({
      command: "future",
      key: "owner/future",
    });
    expect(
      flatten(buildApplicationMenu(state([]), dispatch)).some(
        (item) => item.id === "future",
      ),
    ).toBe(false);
  });
  it("groups and orders feature metadata, including submenus and dynamic children", () => {
    const items = flatten(
      buildApplicationMenu(
        state([
          entry({
            id: "second",
            menu: { group: "Edit", section: 0, order: 2, submenu: "Comments" },
          }),
          entry({
            id: "first",
            menu: { group: "Edit", section: 0, order: 1, submenu: "Comments" },
          }),
          entry({
            id: "recent",
            children: [entry({ id: "project", label: "Paper" })],
          }),
        ]),
        vi.fn(),
      ),
    );
    const submenu = items.find((item) => item.label === "Comments")!
      .submenu as MenuItemConstructorOptions[];
    expect(submenu.map((item) => item.id)).toEqual(["first", "second"]);
    expect(items.some((item) => item.label === "Paper")).toBe(true);
  });
  it("uses custom shortcuts, including removed bindings", () => {
    const current = {
      ...state([entry({ id: "save-file", shortcut: "Mod+KeyS" })]),
      shortcuts: { "save-file": "Mod+Shift+KeyS", "new-window": null },
    };
    const items = flatten(buildApplicationMenu(current, vi.fn(), true));
    expect(items.find((item) => item.id === "save-file")?.accelerator).toBe(
      "CommandOrControl+Shift+S",
    );
    expect(
      items.find((item) => item.id === "new-window")?.accelerator,
    ).toBeUndefined();
  });
  it("retains native shell actions without inventing document capabilities", () => {
    const items = flatten(buildApplicationMenu(undefined, vi.fn(), true, true));
    expect(items.find((item) => item.id === "new-window")).toBeDefined();
    expect(items.find((item) => item.id === "check-for-updates")).toMatchObject(
      { label: "Checking for Updates…", enabled: false },
    );
    expect(items.find((item) => item.id === "save-file")).toBeUndefined();
  });
  it("validates the generic IPC projection", () => {
    expect(isApplicationMenuState(state([entry()]))).toBe(true);
    expect(
      isApplicationMenuState(
        state([
          entry({ menu: { group: "Unknown" as "View", section: 0, order: 0 } }),
        ]),
      ),
    ).toBe(false);
    expect(
      isApplicationMenuState({
        items: [null],
        shortcuts: {},
        recordingShortcut: false,
      }),
    ).toBe(false);
  });
  it("converts supported bindings and rejects unrepresentable keys", () => {
    expect(menuAccelerator("Mod+Comma")).toBe("CommandOrControl+,");
    expect(menuAccelerator("Mod+Equal")).toBe("CommandOrControl+Plus");
    expect(menuAccelerator("Ctrl+Alt+ArrowLeft")).toBe("Control+Alt+Left");
    expect(menuAccelerator("Mod+UnknownKey")).toBeUndefined();
  });
});
