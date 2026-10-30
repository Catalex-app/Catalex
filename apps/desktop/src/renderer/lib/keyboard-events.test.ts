import { describe, expect, it, vi } from "vitest";
import { installImeKeyBoundary } from "./keyboard-events";

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
