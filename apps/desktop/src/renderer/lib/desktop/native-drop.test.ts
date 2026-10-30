import { describe, expect, it } from "vitest";
import {
  getElementFromNativeDropPosition,
  isNativeDropPointInsideElement,
} from "./native-drop";

describe("getElementFromNativeDropPosition", () => {
  it("prefers raw native coordinates when they hit inside the root", () => {
    const root = document.createElement("div");
    const rawChild = document.createElement("button");
    const scaledChild = document.createElement("button");
    root.append(rawChild, scaledChild);

    const hit = getElementFromNativeDropPosition(
      { x: 200, y: 100 },
      {
        root,
        pixelRatio: 2,
        elementFromPoint: (x, y) =>
          x === 200 && y === 100 ? rawChild : scaledChild,
      },
    );

    expect(hit).toBe(rawChild);
  });

  it("falls back to scaled coordinates when the raw hit misses the root", () => {
    const root = document.createElement("div");
    const outside = document.createElement("button");
    const scaledChild = document.createElement("button");
    root.appendChild(scaledChild);

    const hit = getElementFromNativeDropPosition(
      { x: 200, y: 100 },
      {
        root,
        pixelRatio: 2,
        elementFromPoint: (x, y) =>
          x === 200 && y === 100 ? outside : scaledChild,
      },
    );

    expect(hit).toBe(scaledChild);
  });
});

describe("isNativeDropPointInsideElement", () => {
  it("returns false when neither raw nor scaled coordinates hit the root", () => {
    const root = document.createElement("div");
    const outside = document.createElement("button");

    const result = isNativeDropPointInsideElement({ x: 10, y: 20 }, root, {
      pixelRatio: 2,
      elementFromPoint: () => outside,
    });

    expect(result).toBe(false);
  });
});
