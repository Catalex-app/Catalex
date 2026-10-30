import { expect, it } from "vitest";
import { canCloseSearchOnEscape } from "./search-escape";

it("does not let a handled menu Escape also dismiss the surrounding search", () => {
  const pane = document.createElement("div");
  const menu = document.createElement("div");
  menu.setAttribute("role", "menu");
  pane.append(menu);
  document.body.append(pane);
  let close = false;
  pane.addEventListener("keydown", (event) => {
    close = canCloseSearchOnEscape(event);
  });
  const keyEvent = new KeyboardEvent("keydown", {
    key: "Escape",
    bubbles: true,
    cancelable: true,
  });
  keyEvent.preventDefault();
  menu.dispatchEvent(keyEvent);
  expect(close).toBe(false);
  pane.remove();
});

it("allows search to close when a tooltip has only prevented default", () => {
  const keyEvent = new KeyboardEvent("keydown", {
    key: "Escape",
    cancelable: true,
  });
  keyEvent.preventDefault();
  expect(canCloseSearchOnEscape(keyEvent)).toBe(true);
});
