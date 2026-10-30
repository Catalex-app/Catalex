import { describe, expect, it } from "vitest";
import {
  formatKeyboardShortcut,
  getKeyboardShortcutActionForEvent,
  keyboardShortcutFromEvent,
  matchesKeyboardShortcut,
  normalizeKeyboardShortcut,
  normalizeKeyboardShortcutOverrides,
  resolveKeyboardShortcut,
  validateKeyboardShortcut,
} from "@/lib/keyboard-shortcuts";

describe("keyboard shortcuts", () => {
  it("normalizes bindings and ignores unknown persisted actions", () => {
    expect(normalizeKeyboardShortcut("Shift+Mod+s")).toBe("Mod+Shift+KeyS");
    expect(
      normalizeKeyboardShortcutOverrides({
        "save-file": "Shift+Mod+s",
        "zoom-in": null,
        unknown: "Mod+KeyU",
      }),
    ).toEqual({
      "save-file": "Mod+Shift+KeyS",
      "zoom-in": null,
    });
  });

  it("captures the platform primary modifier and formats it conventionally", () => {
    const macEvent = new KeyboardEvent("keydown", {
      code: "KeyK",
      key: "k",
      metaKey: true,
      shiftKey: true,
    });
    const windowsEvent = new KeyboardEvent("keydown", {
      code: "KeyK",
      ctrlKey: true,
      key: "k",
      shiftKey: true,
    });

    expect(keyboardShortcutFromEvent(macEvent, true)).toBe("Mod+Shift+KeyK");
    expect(keyboardShortcutFromEvent(windowsEvent, false)).toBe(
      "Mod+Shift+KeyK",
    );
    expect(formatKeyboardShortcut("Mod+Shift+KeyK", true)).toBe("⌘⇧K");
    expect(formatKeyboardShortcut("Mod+Shift+KeyK", false)).toBe(
      "Ctrl+Shift+K",
    );
  });

  it("matches defaults, custom bindings, plus, and numpad zoom keys", () => {
    expect(
      getKeyboardShortcutActionForEvent(
        new KeyboardEvent("keydown", {
          code: "KeyS",
          ctrlKey: true,
          key: "s",
        }),
        {},
      ),
    ).toBe("save-file");

    const overrides = { "save-file": "Mod+Shift+KeyK" } as const;
    expect(resolveKeyboardShortcut(overrides, "save-file")).toBe(
      "Mod+Shift+KeyK",
    );
    expect(
      matchesKeyboardShortcut(
        new KeyboardEvent("keydown", {
          code: "KeyK",
          ctrlKey: true,
          key: "k",
          shiftKey: true,
        }),
        overrides["save-file"],
        false,
      ),
    ).toBe(true);
    expect(
      matchesKeyboardShortcut(
        new KeyboardEvent("keydown", {
          code: "Equal",
          ctrlKey: true,
          key: "+",
          shiftKey: true,
        }),
        "Mod+Equal",
        false,
      ),
    ).toBe(true);
    expect(
      matchesKeyboardShortcut(
        new KeyboardEvent("keydown", {
          code: "NumpadSubtract",
          ctrlKey: true,
          key: "-",
        }),
        "Mod+Minus",
        false,
      ),
    ).toBe(true);
  });

  it("requires a safe command modifier and protects editing shortcuts", () => {
    expect(validateKeyboardShortcut("KeyK")).toMatch(/Include/);
    expect(validateKeyboardShortcut("Shift+KeyK")).toMatch(/Include/);
    expect(validateKeyboardShortcut("Mod+KeyX")).toMatch(/reserved/);
    expect(validateKeyboardShortcut("Mod+Shift+KeyX")).toBeNull();
    expect(validateKeyboardShortcut("F12")).toBeNull();
  });
});
