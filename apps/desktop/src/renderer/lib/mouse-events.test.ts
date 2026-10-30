import { afterEach, describe, expect, it, vi } from "vitest";
import { installMouseBoundary } from "./mouse-events";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("mouse boundary", () => {
  it("blocks non-primary presses before document capture and target handlers", () => {
    const button = document.createElement("button");
    document.body.append(button);
    const handler = vi.fn();
    document.addEventListener("pointerdown", handler, true);
    cleanups.push(() =>
      document.removeEventListener("pointerdown", handler, true),
    );
    button.addEventListener("mousedown", handler);
    cleanups.push(installMouseBoundary());
    for (const type of [
      "pointerdown",
      "mousedown",
      "pointerup",
      "mouseup",
      "click",
      "dblclick",
      "auxclick",
    ]) {
      for (const buttonNumber of [1, 2, 3, 4]) {
        const event = new MouseEvent(type, {
          button: buttonNumber,
          bubbles: true,
          cancelable: true,
        });
        button.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(true);
      }
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it("preserves primary input, keyboard activation, and separate context menus", () => {
    const button = document.createElement("button");
    document.body.append(button);
    cleanups.push(installMouseBoundary());
    for (const [type, buttonNumber] of [
      ["pointerdown", 0],
      ["mousedown", 0],
      ["click", 0],
      ["contextmenu", 2],
      ["keydown", 0],
    ] as const) {
      const handler = vi.fn();
      button.addEventListener(type, handler, { once: true });
      const event = new MouseEvent(type, {
        button: buttonNumber,
        bubbles: true,
        cancelable: true,
      });
      button.dispatchEvent(event);
      expect(handler).toHaveBeenCalledOnce();
      expect(event.defaultPrevented).toBe(false);
    }
  });

  it("allows middle auxclick only on tab actions and links, including their children", () => {
    document.body.innerHTML =
      '<button data-middle-click-tab><span>Tab</span></button><a href="https://example.com"><span>Link</span></a><button>Ordinary</button>';
    cleanups.push(installMouseBoundary());
    for (const target of document.querySelectorAll("span")) {
      const handler = vi.fn();
      target.addEventListener("auxclick", handler);
      const event = new MouseEvent("auxclick", {
        button: 1,
        bubbles: true,
        cancelable: true,
      });
      target.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
      expect(handler).toHaveBeenCalledOnce();
      const sideClick = new MouseEvent("auxclick", {
        button: 3,
        bubbles: true,
        cancelable: true,
      });
      target.dispatchEvent(sideClick);
      expect(sideClick.defaultPrevented).toBe(true);
      expect(handler).toHaveBeenCalledOnce();
    }
  });

  it("treats macOS Control-click as context input without suppressing keyboard shortcuts", () => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    cleanups.push(installMouseBoundary());
    const down = new MouseEvent("mousedown", {
      button: 0,
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    document.body.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    const key = new KeyboardEvent("keydown", {
      key: "a",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    document.body.dispatchEvent(key);
    expect(key.defaultPrevented).toBe(false);
  });

  it("installs and removes the boundary in an iframe's owning window", () => {
    const frame = document.createElement("iframe");
    document.body.append(frame);
    const doc = frame.contentDocument!;
    const remove = installMouseBoundary(doc);
    const event = () =>
      new MouseEvent("mousedown", {
        button: 1,
        bubbles: true,
        cancelable: true,
      });
    const before = event();
    doc.body.dispatchEvent(before);
    expect(before.defaultPrevented).toBe(true);
    remove();
    const after = event();
    doc.body.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(false);
  });
});
