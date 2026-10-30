import { expect, it, vi } from "vitest";
import {
  getActiveComment,
  setActiveComment,
  subscribeActiveComment,
} from "./active-comment";

it("preserves comment focus through layout controls, while outside clicks still dismiss it", () => {
  const host = document.createElement("div");
  host.innerHTML = `
    <div data-comment-layout-control><button><svg></svg></button></div>
    <button data-outside>Outside</button>
  `;
  document.body.append(host);
  const listener = vi.fn();
  const unsubscribe = subscribeActiveComment(listener);
  const pointerDown = (selector: string) =>
    host
      .querySelector(selector)!
      .dispatchEvent(new Event("pointerdown", { bubbles: true }));
  try {
    setActiveComment("focused");
    listener.mockClear();
    pointerDown("svg");
    expect(getActiveComment()).toBe("focused");
    expect(listener).not.toHaveBeenCalled();
    pointerDown("[data-outside]");
    expect(getActiveComment()).toBeNull();
    expect(listener).toHaveBeenCalledOnce();
  } finally {
    unsubscribe();
    setActiveComment(null);
    host.remove();
  }
});
