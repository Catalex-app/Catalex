import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { Input } from "./input";
import { Textarea } from "./textarea";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe("shared input keyboard ownership", () => {
  for (const Component of [Input, Textarea]) {
    it(`${Component.name} leaves IME Enter/Escape native and skips application actions`, async () => {
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);
      const action = vi.fn();
      const parent = vi.fn();
      await act(async () =>
        root.render(
          <div onKeyDown={parent}>
            <Component onKeyDown={action} />
          </div>,
        ),
      );
      const input = host.querySelector("input, textarea")!;
      for (const key of ["Enter", "Escape"]) {
        const event = new KeyboardEvent("keydown", {
          key,
          isComposing: true,
          bubbles: true,
          cancelable: true,
        });
        input.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(false);
      }
      expect(action).not.toHaveBeenCalled();
      expect(parent).not.toHaveBeenCalled();
      await act(async () => root.unmount());
      host.remove();
    });
    it(`${Component.name} keeps control-specific actions and stops handled keys`, async () => {
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);
      const action = vi.fn((event) => event.preventDefault());
      const parent = vi.fn();
      await act(async () =>
        root.render(
          <div onKeyDown={parent}>
            <Component onKeyDown={action} />
          </div>,
        ),
      );
      host.querySelector("input, textarea")!.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          cancelable: true,
        }),
      );
      expect(action).toHaveBeenCalledTimes(1);
      expect(parent).not.toHaveBeenCalled();
      await act(async () => root.unmount());
      host.remove();
    });
  }
});
