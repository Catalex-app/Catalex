import { describe, expect, it, vi } from "vitest";
import { getContextMenuCoordinator } from "./context-menu-coordinator";

function surface() {
  const doc = document.implementation.createHTMLDocument();
  const target = doc.createElement("button");
  doc.body.append(target);
  return { doc, target, coordinator: getContextMenuCoordinator(doc) };
}

describe("context-menu coordination", () => {
  it("shares admission and one guard until the active menu releases it", () => {
    const { doc, target, coordinator } = surface();
    const first = Symbol();
    const second = Symbol();
    const reachedTarget = vi.fn();
    target.addEventListener("contextmenu", reachedTarget);
    const click = () =>
      target.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
      );

    expect(getContextMenuCoordinator(doc)).toBe(coordinator);
    expect(coordinator.canOpen()).toBe(true);
    expect(coordinator.acquire(first)).toBe(true);
    expect(coordinator.acquire(first)).toBe(true);
    expect(coordinator.acquire(second)).toBe(false);
    expect(coordinator.canOpen()).toBe(false);
    expect(click()).toBe(false);
    expect(reachedTarget).not.toHaveBeenCalled();

    coordinator.release(second);
    expect(coordinator.canOpen()).toBe(false);
    coordinator.release(first);
    expect(coordinator.canOpen()).toBe(true);
    expect(click()).toBe(true);
    expect(reachedTarget).toHaveBeenCalledOnce();
  });

  it("does not let old cleanup release a newer menu", () => {
    const { coordinator } = surface();
    const first = Symbol();
    const second = Symbol();
    coordinator.acquire(first);
    coordinator.release(first);
    coordinator.acquire(second);
    coordinator.release(first);
    expect(coordinator.canOpen()).toBe(false);
    coordinator.release(second);
    expect(coordinator.canOpen()).toBe(true);
  });

  it("blocks secondary pointer events without blocking left clicks or Escape", () => {
    const { target, coordinator } = surface();
    const menu = Symbol();
    coordinator.acquire(menu);
    // MouseEvent supplies the button fields read by the pointerdown guard.
    expect(
      target.dispatchEvent(
        new MouseEvent("pointerdown", {
          bubbles: true,
          cancelable: true,
          button: 2,
        }),
      ),
    ).toBe(false);
    expect(
      target.dispatchEvent(
        new MouseEvent("pointerdown", {
          bubbles: true,
          cancelable: true,
          button: 0,
        }),
      ),
    ).toBe(true);
    expect(
      target.dispatchEvent(
        new MouseEvent("click", {
          bubbles: true,
          cancelable: true,
        }),
      ),
    ).toBe(true);
    expect(
      target.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key: "Escape",
        }),
      ),
    ).toBe(true);
    coordinator.release(menu);
  });

  it("keeps documents independent", () => {
    const first = surface();
    const second = surface();
    const menu = Symbol();
    first.coordinator.acquire(menu);
    expect(second.coordinator.canOpen()).toBe(true);
    expect(
      second.target.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
        }),
      ),
    ).toBe(true);
    first.coordinator.release(menu);
  });
  it("isolates the menu ancestor path and restores only its own inert changes", () => {
    const { doc, target, coordinator } = surface();
    const preserved = doc.createElement("div");
    preserved.inert = true;
    const portal = doc.createElement("div");
    const menu = doc.createElement("div");
    const sibling = doc.createElement("button");
    portal.append(menu, sibling);
    doc.body.append(preserved, portal);
    const id = Symbol();
    coordinator.acquire(id, menu);
    expect(target.inert).toBe(true);
    expect(sibling.inert).toBe(true);
    expect(portal.inert).not.toBe(true);
    expect(menu.inert).not.toBe(true);
    coordinator.release(id);
    expect(target.inert).toBe(false);
    expect(sibling.inert).toBe(false);
    expect(preserved.inert).toBe(true);
  });

  it("blocks background shortcuts but leaves Radix navigation intact", () => {
    const { target, coordinator } = surface();
    const id = Symbol();
    coordinator.acquire(id, target);
    target.addEventListener("keydown", coordinator.guardKeyboard);
    const key = (value: string, ctrlKey = false) =>
      target.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: value,
          ctrlKey,
          bubbles: true,
          cancelable: true,
        }),
      );
    expect(key("ArrowDown")).toBe(true);
    expect(key("Escape")).toBe(true);
    expect(key("Tab")).toBe(true);
    expect(key("a")).toBe(true);
    expect(key("n", true)).toBe(false);
    expect(key("Delete")).toBe(false);
    coordinator.release(id);
    expect(key("n", true)).toBe(true);
  });
});
