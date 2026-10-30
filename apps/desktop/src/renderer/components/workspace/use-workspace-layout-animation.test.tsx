import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useWorkspaceLayoutAnimation } from "./use-workspace-layout-animation";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let motion: ReturnType<typeof useWorkspaceLayoutAnimation>;
let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;
let layout: number[];
let panes: HTMLDivElement[];
const onStart = vi.fn();
const onStop = vi.fn();
const onComplete = vi.fn();

beforeEach(() => {
  frames = new Map();
  nextFrame = 0;
  layout = [50, 50, 0, 0, 0];
  panes = Array.from({ length: 5 }, () => document.createElement("div"));
  const panels = panes.map((pane, index) => ({
    index,
    ref: { current: pane },
  }));
  const groupRef = {
    current: {
      getId: () => "test",
      getLayout: () => layout,
      setLayout: (next: number[]) => {
        layout = next;
      },
    },
  };
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  function Harness() {
    motion = useWorkspaceLayoutAnimation({
      groupRef,
      panels,
      onStart,
      onStop,
      onComplete,
    });
    return null;
  }
  act(() => root.render(<Harness />));
});

afterEach(() => {
  act(() => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function frame(time: number) {
  act(() => {
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(time);
  });
}

it("animates an additional pane with the same timing and preserves closing content until completion", () => {
  act(() => motion.applyOpacity(layout));
  const target = [50, 0, 0, 0, 50];
  act(() => motion.animate(layout, target));
  expect(panes[4].style.opacity).toBe("1");
  expect(panes[1].style.opacity).toBe("1");
  frame(0);
  frame(1000); // A stalled render must not jump straight to the destination.
  expect(layout[4]).toBeGreaterThan(0);
  expect(layout[4]).toBeLessThan(50);
  expect(motion.isAnimating).toBe(true);
  for (let time = 1032; time <= 1224; time += 32) frame(time);
  expect(layout).toEqual(target);
  expect(panes[1].style.opacity).toBe("0");
  expect(motion.isAnimatingRef.current).toBe(false);
  expect(motion.isAnimating).toBe(false);
  expect(onComplete).toHaveBeenCalledExactlyOnceWith(target);
});

it("cancels a superseded transition without completing its stale target", () => {
  const oldTarget = [0, 0, 0, 0, 100];
  act(() => motion.animate(layout, oldTarget));
  frame(0);
  frame(16);
  const newTarget = [0, 100, 0, 0, 0];
  act(() => motion.animate(layout, newTarget));
  expect(frames.size).toBe(1);
  for (let time = 32; time <= 288; time += 32) frame(time);
  expect(layout).toEqual(newTarget);
  expect(onComplete).toHaveBeenCalledExactlyOnceWith(newTarget);
});

it("settles near-equal layouts immediately and cancels pending frames on unmount", () => {
  const target = [50.1, 49.9, 0, 0, 0];
  act(() => motion.animate(layout, target));
  expect(layout).toEqual(target);
  expect(onStart).not.toHaveBeenCalled();
  expect(frames.size).toBe(0);
  act(() => motion.animate(layout, [0, 0, 0, 0, 100]));
  act(() => root.unmount());
  expect(frames.size).toBe(0);
  expect(onComplete).toHaveBeenCalledTimes(1);
});

it("keeps the active transition when a mode layout effect repeats its destination", () => {
  const target = [0, 50, 50, 0, 0];
  act(() => motion.animate(layout, target, 220));
  frame(0);
  frame(16);
  act(() => motion.animate(layout, target));
  expect(onStart).toHaveBeenCalledTimes(1);
  for (let time = 48; time <= 240; time += 32) frame(time);
  expect(layout).toEqual(target);
  expect(onComplete).toHaveBeenCalledExactlyOnceWith(target);
});
