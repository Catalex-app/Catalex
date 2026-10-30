import { PRODUCT_NAME } from "../../branding";
export type KeyboardShortcutActionId =
  | "save-file"
  | "new-window"
  | "open-settings"
  | "zoom-in"
  | "zoom-out"
  | "zoom-reset"
  | "toggle-debug-panel";

export type KeyboardShortcutGroup = "General" | "View" | "Developer";

export type KeyboardShortcutOverrides = Partial<
  Record<KeyboardShortcutActionId, string | null>
>;

export interface KeyboardShortcutAction {
  id: KeyboardShortcutActionId;
  label: string;
  description: string;
  group: KeyboardShortcutGroup;
  defaultBinding: string;
}

export const KEYBOARD_SHORTCUT_ACTIONS: readonly KeyboardShortcutAction[] = [
  {
    id: "save-file",
    label: "Save File",
    description: "Save the active document",
    group: "General",
    defaultBinding: "Mod+KeyS",
  },
  {
    id: "new-window",
    label: "New Window",
    description: "Open another " + PRODUCT_NAME + " window",
    group: "General",
    defaultBinding: "Mod+Shift+KeyN",
  },
  {
    id: "open-settings",
    label: "Open Settings",
    description: "Open the Settings window",
    group: "General",
    defaultBinding: "Mod+Comma",
  },
  {
    id: "zoom-in",
    label: "Zoom In",
    description: "Increase the app interface scale",
    group: "View",
    defaultBinding: "Mod+Equal",
  },
  {
    id: "zoom-out",
    label: "Zoom Out",
    description: "Decrease the app interface scale",
    group: "View",
    defaultBinding: "Mod+Minus",
  },
  {
    id: "zoom-reset",
    label: "Reset Zoom",
    description: "Restore the default interface scale",
    group: "View",
    defaultBinding: "Mod+Digit0",
  },
  {
    id: "toggle-debug-panel",
    label: "Toggle Debug Panel",
    description: "Show or hide developer diagnostics",
    group: "Developer",
    defaultBinding: "Mod+Shift+KeyD",
  },
];

export const KEYBOARD_SHORTCUT_GROUPS: readonly KeyboardShortcutGroup[] = [
  "General",
  "View",
  "Developer",
];

const ACTION_IDS = new Set<KeyboardShortcutActionId>(
  KEYBOARD_SHORTCUT_ACTIONS.map((action) => action.id),
);
const MODIFIER_ORDER = ["Mod", "Ctrl", "Alt", "Shift", "Meta"] as const;
const MODIFIER_CODES = new Set([
  "AltLeft",
  "AltRight",
  "ControlLeft",
  "ControlRight",
  "MetaLeft",
  "MetaRight",
  "ShiftLeft",
  "ShiftRight",
]);
const RESERVED_EDITING_SHORTCUTS = new Set([
  "Mod+KeyA",
  "Mod+KeyC",
  "Mod+KeyV",
  "Mod+KeyX",
  "Mod+KeyZ",
  "Mod+Shift+KeyZ",
  "Mod+KeyY",
]);

const KEY_LABELS: Record<string, string> = {
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  ArrowUp: "↑",
  Backquote: "`",
  Backslash: "\\",
  BracketLeft: "[",
  BracketRight: "]",
  Comma: ",",
  Delete: "Delete",
  End: "End",
  Enter: "Enter",
  Equal: "+",
  Escape: "Esc",
  Home: "Home",
  Insert: "Insert",
  Minus: "−",
  PageDown: "Page Down",
  PageUp: "Page Up",
  Period: ".",
  Quote: "'",
  Semicolon: ";",
  Slash: "/",
  Space: "Space",
  Tab: "Tab",
};

type ShortcutEvent = Pick<
  KeyboardEvent,
  "altKey" | "code" | "ctrlKey" | "key" | "metaKey" | "shiftKey"
>;

function normalizeKeyCode(code: string): string | null {
  const trimmed = code.trim();
  if (!trimmed || MODIFIER_CODES.has(trimmed)) return null;
  if (/^[a-z]$/i.test(trimmed)) return `Key${trimmed.toUpperCase()}`;
  if (/^[0-9]$/.test(trimmed)) return `Digit${trimmed}`;
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(trimmed)) return null;
  return trimmed;
}

function keyCodeFromEvent(event: ShortcutEvent): string | null {
  const fromCode = normalizeKeyCode(event.code);
  if (fromCode) return fromCode;

  if (event.key.length === 1) {
    if (/^[a-z]$/i.test(event.key)) return `Key${event.key.toUpperCase()}`;
    if (/^[0-9]$/.test(event.key)) return `Digit${event.key}`;
  }

  const keyAliases: Record<string, string> = {
    ",": "Comma",
    ".": "Period",
    "/": "Slash",
    ";": "Semicolon",
    "'": "Quote",
    "[": "BracketLeft",
    "]": "BracketRight",
    "\\": "Backslash",
    "`": "Backquote",
    "-": "Minus",
    _: "Minus",
    "=": "Equal",
    "+": "Equal",
    " ": "Space",
  };
  return keyAliases[event.key] ?? normalizeKeyCode(event.key);
}

export function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mac|iPhone|iPad|iPod/.test(navigator.userAgent);
}

export function normalizeKeyboardShortcut(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const parts = value
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) return null;

  const modifiers = new Set<string>();
  let keyCode: string | null = null;
  for (const part of parts) {
    if ((MODIFIER_ORDER as readonly string[]).includes(part)) {
      modifiers.add(part);
      continue;
    }
    if (keyCode) return null;
    keyCode = normalizeKeyCode(part);
    if (!keyCode) return null;
  }
  if (!keyCode) return null;

  return [
    ...MODIFIER_ORDER.filter((modifier) => modifiers.has(modifier)),
    keyCode,
  ].join("+");
}

export function normalizeKeyboardShortcutOverrides(
  value: unknown,
): KeyboardShortcutOverrides {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};

  const result: KeyboardShortcutOverrides = {};
  for (const [id, binding] of Object.entries(value)) {
    if (!ACTION_IDS.has(id as KeyboardShortcutActionId)) continue;
    if (binding === null) {
      result[id as KeyboardShortcutActionId] = null;
      continue;
    }
    const normalized = normalizeKeyboardShortcut(binding);
    if (normalized) result[id as KeyboardShortcutActionId] = normalized;
  }
  return result;
}

export function getDefaultKeyboardShortcut(
  actionId: KeyboardShortcutActionId,
): string {
  return (
    KEYBOARD_SHORTCUT_ACTIONS.find((action) => action.id === actionId)
      ?.defaultBinding ?? ""
  );
}

export function resolveKeyboardShortcut(
  overrides: KeyboardShortcutOverrides,
  actionId: KeyboardShortcutActionId,
): string | null {
  if (Object.prototype.hasOwnProperty.call(overrides, actionId)) {
    return overrides[actionId] ?? null;
  }
  return getDefaultKeyboardShortcut(actionId);
}

export function keyboardShortcutFromEvent(
  event: ShortcutEvent,
  mac = isMacPlatform(),
): string | null {
  const keyCode = keyCodeFromEvent(event);
  if (!keyCode) return null;

  const parts: string[] = [];
  if ((mac && event.metaKey) || (!mac && event.ctrlKey)) parts.push("Mod");
  if (event.ctrlKey && (mac || !parts.includes("Mod"))) parts.push("Ctrl");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  if (event.metaKey && (!mac || !parts.includes("Mod"))) parts.push("Meta");
  parts.push(keyCode);
  return normalizeKeyboardShortcut(parts.join("+"));
}

export function validateKeyboardShortcut(binding: string): string | null {
  const normalized = normalizeKeyboardShortcut(binding);
  if (!normalized) return "Press a key together with a modifier.";
  const parts = normalized.split("+");
  const keyCode = parts[parts.length - 1] ?? "";
  const hasCommandModifier = parts
    .slice(0, -1)
    .some((part) => part !== "Shift");
  if (!hasCommandModifier && !/^F(?:[1-9]|1[0-9]|2[0-4])$/.test(keyCode)) {
    return "Include Command, Control, or Option in the shortcut.";
  }
  if (RESERVED_EDITING_SHORTCUTS.has(normalized)) {
    return "That shortcut is reserved for standard text editing.";
  }
  return null;
}

function keyCodesMatch(expected: string, actual: string): boolean {
  if (expected === actual) return true;
  if (expected === "Equal" && actual === "NumpadAdd") return true;
  if (expected === "Minus" && actual === "NumpadSubtract") return true;
  if (expected === "Digit0" && actual === "Numpad0") return true;
  return false;
}

export function matchesKeyboardShortcut(
  event: ShortcutEvent,
  binding: string | null,
  mac = isMacPlatform(),
): boolean {
  if (!binding) return false;
  const normalized = normalizeKeyboardShortcut(binding);
  if (!normalized) return false;

  const parts = normalized.split("+");
  const expectedCode = parts[parts.length - 1] ?? "";
  const actualCode = keyCodeFromEvent(event);
  if (!actualCode || !keyCodesMatch(expectedCode, actualCode)) return false;

  const expectsMod = parts.includes("Mod");
  const expectsCtrl = parts.includes("Ctrl");
  const expectsAlt = parts.includes("Alt");
  const expectsShift = parts.includes("Shift");
  const expectsMeta = parts.includes("Meta");
  const actualMod = mac ? event.metaKey : event.ctrlKey;
  const actualCtrl = mac ? event.ctrlKey : false;
  const actualMeta = mac ? false : event.metaKey;
  const allowImplicitPlusShift = expectedCode === "Equal" && !expectsShift;

  return (
    actualMod === expectsMod &&
    actualCtrl === expectsCtrl &&
    event.altKey === expectsAlt &&
    (event.shiftKey === expectsShift ||
      (allowImplicitPlusShift && event.shiftKey)) &&
    actualMeta === expectsMeta
  );
}

export function getKeyboardShortcutActionForEvent(
  event: ShortcutEvent,
  overrides: KeyboardShortcutOverrides,
): KeyboardShortcutActionId | null {
  return (
    KEYBOARD_SHORTCUT_ACTIONS.find((action) =>
      matchesKeyboardShortcut(
        event,
        resolveKeyboardShortcut(overrides, action.id),
      ),
    )?.id ?? null
  );
}

function keyCodeLabel(code: string): string {
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  if (code.startsWith("Numpad")) return `Num ${code.slice(6)}`;
  return KEY_LABELS[code] ?? code.replace(/([a-z])([A-Z])/g, "$1 $2");
}

export function formatKeyboardShortcutParts(
  binding: string | null,
  mac = isMacPlatform(),
): string[] {
  if (!binding) return [];
  const normalized = normalizeKeyboardShortcut(binding);
  if (!normalized) return [];
  const parts = normalized.split("+");
  const keyCode = parts.pop() ?? "";
  const modifierLabels = parts.map((part) => {
    if (part === "Mod") return mac ? "⌘" : "Ctrl";
    if (part === "Ctrl") return mac ? "⌃" : "Ctrl";
    if (part === "Alt") return mac ? "⌥" : "Alt";
    if (part === "Shift") return mac ? "⇧" : "Shift";
    if (part === "Meta") return mac ? "⌘" : "Meta";
    return part;
  });
  return [...modifierLabels, keyCodeLabel(keyCode)];
}

export function formatKeyboardShortcut(
  binding: string | null,
  mac = isMacPlatform(),
): string {
  const parts = formatKeyboardShortcutParts(binding, mac);
  return mac ? parts.join("") : parts.join("+");
}
