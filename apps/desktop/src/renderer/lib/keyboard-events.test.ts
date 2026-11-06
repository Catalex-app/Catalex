import { describe, expect, it, vi } from "vitest";
import { canHandleEscape, installImeKeyBoundary } from "./keyboard-events";

describe("expanded workspace Escape scopes", () => {
  it("lets editor popups handle Escape while keeping real modal dialogs protected", () => {
    const panel = document.createElement("div");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("data-expanded-workspace-panel", "Editor");
    const editor = document.createElement("div");
    const popup = document.createElement("button");
    panel.append(editor);
    document.body.append(panel, popup);
    vi.spyOn(panel, "getClientRects").mockReturnValue([
      {},
    ] as unknown as DOMRectList);
    const allowed: boolean[] = [];
    const check = (event: KeyboardEvent) =>
      allowed.push(canHandleEscape(event));
    document.addEventListener("keydown", check);
    try {
      const escapeEvent = () =>
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true });
      editor.dispatchEvent(escapeEvent());
      popup.dispatchEvent(escapeEvent());
      const modal = document.createElement("div");
      modal.setAttribute("role", "alertdialog");
      vi.spyOn(modal, "getClientRects").mockReturnValue([
        {},
      ] as unknown as DOMRectList);
      panel.append(modal);
      modal.dispatchEvent(escapeEvent());
      popup.dispatchEvent(escapeEvent());
      expect(allowed).toEqual([true, true, false, false]);
    } finally {
      document.removeEventListener("keydown", check);
      panel.remove();
      popup.remove();
    }
  });
});

describe("IME event boundary", () => {
  it("protects composition before popup capture handlers without preventing native behavior", () => {
    const remove = installImeKeyBoundary();
    const popup = vi.fn();
    document.addEventListener("keydown", popup, true);
    for (const key of ["Enter", "Escape"]) {
      for (const legacy of [false, true]) {
        const event = new KeyboardEvent("keydown", {
          key,
          isComposing: !legacy,
          keyCode: legacy ? 229 : 0,
          bubbles: true,
          cancelable: true,
        });
        document.body.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(false);
      }
    }
    expect(popup).not.toHaveBeenCalled();
    document.body.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    expect(popup).toHaveBeenCalledTimes(1);
    remove();
    document.removeEventListener("keydown", popup, true);
  });
});
