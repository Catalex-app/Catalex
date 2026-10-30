import { afterEach, expect, it, vi } from "vitest";
import {
  cancelNavigationScroll,
  isNavigationScrolling,
  scrollForNavigation,
} from "./navigation-scroll";

afterEach(() => vi.restoreAllMocks());

function harness(reduced = false) {
  const element = document.createElement("div");
  document.body.append(element);
  Object.defineProperties(element, {
    clientHeight: { value: 200 },
    scrollHeight: { value: 2200 },
    clientWidth: { value: 300 },
    scrollWidth: { value: 600 },
  });
  const frames = new Map<number, FrameRequestCallback>();
  let id = 0;
  vi.spyOn(window.performance, "now").mockReturnValue(0);
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((fn) => {
    frames.set(++id, fn);
    return id;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((key) => {
    frames.delete(key);
  });
  vi.stubGlobal("matchMedia", () => ({ matches: reduced }));
  const tick = (time: number) => {
    const pending = [...frames.values()];
    frames.clear();
    for (const frame of pending) frame(time);
  };
  return {
    element,
    frames,
    tick,
    destroy() {
      cancelNavigationScroll(element);
      element.remove();
      vi.unstubAllGlobals();
    },
  };
}

it("uses intermediate frames, clamps the target and finishes after a short duration", () => {
  const h = harness();
  try {
    scrollForNavigation(h.element, { top: 3000, left: 500 });
    expect(h.element.scrollTop).toBe(0);
    expect(isNavigationScrolling(h.element)).toBe(true);
    h.tick(60);
    expect(h.element.scrollTop).toBeGreaterThan(0);
    expect(h.element.scrollTop).toBeLessThan(2000);
    h.tick(180);
    expect(h.element.scrollTop).toBe(2000);
    expect(h.element.scrollLeft).toBe(300);
    expect(isNavigationScrolling(h.element)).toBe(false);
    expect(h.frames.size).toBe(0);
  } finally {
    h.destroy();
  }
});

it.each([
  "wheel",
  "touchstart",
  "pointerdown",
  "keydown",
])("yields immediately to %s", (event) => {
  const h = harness();
  try {
    scrollForNavigation(h.element, { top: 1000 });
    h.tick(60);
    const stopped = h.element.scrollTop;
    h.element.dispatchEvent(new Event(event));
    h.tick(180);
    expect(h.element.scrollTop).toBe(stopped);
    expect(isNavigationScrolling(h.element)).toBe(false);
  } finally {
    h.destroy();
  }
});

it("replaces stale navigation and adapts to virtualized editor geometry", () => {
  const h = harness();
  try {
    scrollForNavigation(h.element, { top: 1000 });
    h.tick(60);
    let target = 500;
    scrollForNavigation(h.element, () => ({ top: target }));
    expect(h.frames.size).toBe(1);
    target = 600;
    h.tick(180);
    expect(h.element.scrollTop).toBe(600);
    scrollForNavigation(h.element, { top: 1200 });
    h.element.remove();
    h.tick(180);
    expect(isNavigationScrolling(h.element)).toBe(false);
  } finally {
    h.destroy();
  }
});

it("respects reduced motion without scheduling frames", () => {
  const h = harness(true);
  try {
    scrollForNavigation(h.element, { top: 1000 });
    expect(h.element.scrollTop).toBe(1000);
    expect(h.frames.size).toBe(0);
    expect(isNavigationScrolling(h.element)).toBe(false);
  } finally {
    h.destroy();
  }
});
