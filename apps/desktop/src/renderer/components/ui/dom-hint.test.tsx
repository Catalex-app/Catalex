import { expect, it, vi } from "vitest";
const root = vi.hoisted(() => ({ render: vi.fn(), unmount: vi.fn() }));
vi.mock("react-dom/client", () => ({ createRoot: () => root }));
import { destroyDomHint, renderDomHint } from "./dom-hint";

it("skips unchanged hint renders but still cancels pending disposal", async () => {
  root.render.mockClear();
  root.unmount.mockClear();
  const host = document.createElement("span");
  renderDomHint(host, "Agent", "Created by agent");
  destroyDomHint(host);
  renderDomHint(host, "Agent", "Created by agent");
  await Promise.resolve();
  expect(root.render).toHaveBeenCalledTimes(1);
  expect(root.unmount).not.toHaveBeenCalled();
  renderDomHint(host, "Updated model", "Created by agent");
  renderDomHint(host, "Updated model", "Updated attribution");
  expect(root.render).toHaveBeenCalledTimes(3);
  destroyDomHint(host);
  await Promise.resolve();
  expect(root.unmount).toHaveBeenCalledTimes(1);
  renderDomHint(host, "Updated model", "Updated attribution");
  expect(root.render).toHaveBeenCalledTimes(4);
  destroyDomHint(host);
  await Promise.resolve();
});
