import { act, useRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { usePdfPinchZoom } from "./pdf-pinch-zoom";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("accumulates wheel deltas, respects limits, and cancels pending zoom when changing documents", async () => {
  vi.useFakeTimers();
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  const change = vi.fn();
  function Fixture({ id = 1, scale = 1, active = true }) {
    const container = useRef<HTMLDivElement>(null);
    const content = useRef<HTMLDivElement>(null);
    usePdfPinchZoom(container, content, scale, change, id, active);
    return (
      <div ref={container} data-container>
        <div ref={content} data-content>
          <div data-page-number="1" />
        </div>
      </div>
    );
  }
  const render = async (id = 1, scale = 1, active = true) =>
    act(async () =>
      root.render(<Fixture id={id} scale={scale} active={active} />),
    );
  const wheel = (deltaY: number, ctrlKey = true) => {
    const event = new WheelEvent("wheel", {
      ctrlKey,
      deltaY,
      cancelable: true,
    });
    act(() => {
      host.querySelector("[data-container]")!.dispatchEvent(event);
    });
    return event;
  };
  try {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      width: 600,
      height: 800,
    } as DOMRect);
    await render();
    expect(wheel(50, false).defaultPrevented).toBe(false);
    const frames = vi.spyOn(window, "requestAnimationFrame");
    wheel(-20);
    wheel(-20);
    expect(frames).toHaveBeenCalledTimes(1);
    expect(change).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });
    expect(change.mock.calls[0][0]).toBeCloseTo(Math.exp(0.2), 10);
    await render(1, Math.exp(0.2));
    wheel(-100000);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });
    expect(change).toHaveBeenLastCalledWith(12);
    await render(1, 12);
    wheel(100000);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });
    expect(change).toHaveBeenLastCalledWith(0.25);
    await render(1, 0.25);
    change.mockClear();
    wheel(-40);
    await render(2, 0.25);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(change).not.toHaveBeenCalled();
    expect(
      (host.querySelector("[data-content]") as HTMLElement).style.transform,
    ).toBe("");
    wheel(-40);
    await render(2, 0.25, false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(change).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
