import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts";
import { useSettingsStore } from "@/stores/settings-store";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  documentState: {
    setIsSaving: vi.fn(),
    saveCurrentFile: vi.fn(() => Promise.resolve()),
  },
}));

vi.mock("@/stores/document-store", () => ({
  useDocumentStore: {
    getState: vi.fn(() => mocks.documentState),
  },
}));

function Harness() {
  useKeyboardShortcuts();
  return null;
}

describe("useKeyboardShortcuts", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;
  let toggleCapture: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    useSettingsStore.setState({ keyboardShortcutOverrides: {} });
    toggleCapture = vi.fn();
    window.addEventListener("toggle-capture-mode", toggleCapture);

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(<Harness />);
    });
  });

  afterEach(() => {
    window.removeEventListener("toggle-capture-mode", toggleCapture);

    if (root) {
      act(() => {
        root?.unmount();
      });
    }
    container?.remove();
    root = null;
    container = null;
  });

  it("does not intercept the standard cut shortcut", () => {
    const event = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "x",
      metaKey: true,
    });

    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(toggleCapture).not.toHaveBeenCalled();
  });

  it("does not intercept the removed capture shortcut", () => {
    const event = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "X",
      ctrlKey: true,
      shiftKey: true,
    });

    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(toggleCapture).not.toHaveBeenCalled();
  });
});
