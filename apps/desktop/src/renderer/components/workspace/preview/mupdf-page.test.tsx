import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PdfCanvasCache } from "./pdf-canvas-cache";
import { MupdfPage } from "./mupdf-page";

const mocks = vi.hoisted(() => ({
  client: {
    drawPage: vi.fn(),
    drawPageRegion: vi.fn(),
    getPageLinks: vi.fn(),
    getPageText: vi.fn(),
  },
}));

vi.mock("@/lib/mupdf/mupdf-client", () => ({
  getMupdfClient: () => mocks.client,
  getMupdfClientRevision: () => 0,
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function pixels(width = 1, height = 1) {
  return { width, height, close: vi.fn() };
}

describe("MupdfPage", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    mocks.client.drawPage.mockImplementation(async () => pixels());
    mocks.client.getPageText.mockResolvedValue({ blocks: [] });
    mocks.client.getPageLinks.mockResolvedValue([
      {
        x: 10,
        y: 20,
        w: 30,
        h: 40,
        href: "https://example.com",
        isExternal: true,
      },
    ]);

    HTMLCanvasElement.prototype.getContext = vi.fn(
      () =>
        ({
          drawImage: vi.fn(),
          getImageData: vi.fn(() => ({
            data: new Uint8ClampedArray([255, 255, 255, 255]),
          })),
        }) as unknown as CanvasRenderingContext2D,
    ) as unknown as HTMLCanvasElement["getContext"];
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    document.body.replaceChildren();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("labels link overlays without adding hidden text to the PDF page", async () => {
    act(() => {
      root.render(
        <MupdfPage
          canvasCache={new PdfCanvasCache()}
          docId={1}
          pageIndex={0}
          scale={1}
          pageWidth={100}
          pageHeight={200}
          isVisible={true}
        />,
      );
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });

    const link = container.querySelector(".mupdf-link-layer a");
    expect(link?.getAttribute("aria-label")).toBe("Link");
    expect(link?.textContent).toBe("");
    expect(link?.querySelector(".sr-only")).toBeNull();
  });
  async function renderPage(
    cache: PdfCanvasCache,
    visible = true,
    scale = 1,
    retainText = false,
    docId = 1,
    renderScale = scale,
    renderPaused = false,
  ) {
    await act(async () => {
      root.render(
        <MupdfPage
          canvasCache={cache}
          docId={docId}
          pageIndex={0}
          scale={scale}
          renderScale={renderScale}
          renderPaused={renderPaused}
          pageWidth={100}
          pageHeight={200}
          isVisible={visible}
          retainText={retainText}
        />,
      );
    });
    return container.querySelector("canvas")!;
  }

  it("closes the transferred bitmap after drawing", async () => {
    const cache = new PdfCanvasCache();
    const first = pixels();
    mocks.client.drawPage.mockResolvedValueOnce(first);
    const canvas = await renderPage(cache);
    expect(canvas.width).toBe(1);
    expect(first.close).toHaveBeenCalledOnce();
  });

  it("resizes existing pixels without drawing again until the final raster scale", async () => {
    const cache = new PdfCanvasCache();
    await renderPage(cache);
    for (const displayScale of [1.2, 1.6, 2])
      await renderPage(cache, true, displayScale, false, 1, 1);
    expect(
      container.querySelector<HTMLElement>(".mupdf-page")!.style.width,
    ).toBe("200px");
    expect(mocks.client.drawPage).toHaveBeenCalledTimes(1);
    await renderPage(cache, true, 2, false, 1, 2);
    expect(mocks.client.drawPage).toHaveBeenCalledTimes(2);
    expect(mocks.client.drawPage).toHaveBeenLastCalledWith(
      1,
      0,
      144,
      expect.any(AbortSignal),
    );
  });

  it("bounds Retina page pixels and reuses them when higher display zoom is saturated", async () => {
    const originalRatio = window.devicePixelRatio;
    Object.defineProperty(window, "devicePixelRatio", {
      configurable: true,
      value: 2,
    });
    const cache = new PdfCanvasCache();
    try {
      for (const scale of [10, 12]) {
        await act(async () => {
          root.render(
            <MupdfPage
              canvasCache={cache}
              docId={1}
              pageIndex={0}
              scale={scale}
              pageWidth={612}
              pageHeight={792}
              isVisible
            />,
          );
          await vi.advanceTimersByTimeAsync(150);
        });
      }
      expect(mocks.client.drawPage).toHaveBeenCalledTimes(1);
      const dpi = mocks.client.drawPage.mock.calls[0][2];
      expect(612 * 792 * (dpi / 72) ** 2).toBeLessThanOrEqual(33_554_432 + 1);
      expect(
        container.querySelector<HTMLElement>(".mupdf-page")!.style.width,
      ).toBe("7344px");
    } finally {
      Object.defineProperty(window, "devicePixelRatio", {
        configurable: true,
        value: originalRatio,
      });
    }
  });

  it("reuses cached pixels on return and rerenders after eviction without changing layout", async () => {
    const cache = new PdfCanvasCache(4);
    const canvas = await renderPage(cache);
    await renderPage(cache, false);
    await renderPage(cache);
    expect(mocks.client.drawPage).toHaveBeenCalledTimes(1);
    await renderPage(cache, false);
    const other = document.createElement("canvas");
    other.width = other.height = 1;
    cache.store(
      other,
      () => true,
      () => {},
    );
    expect(canvas.width).toBe(0);
    expect(canvas.style.width).toBe("100px");
    expect(
      container.querySelector(".mupdf-page")?.getAttribute("data-page-number"),
    ).toBe("1");
    await renderPage(cache);
    expect(mocks.client.drawPage).toHaveBeenCalledTimes(2);
    expect(canvas.width).toBe(1);
  });

  it("discards a worker result arriving after the page leaves the buffer", async () => {
    let finish!: (value: ReturnType<typeof pixels>) => void;
    mocks.client.drawPage.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const cache = new PdfCanvasCache();
    const canvas = await renderPage(cache);
    await renderPage(cache, false);
    const latePixels = pixels(100, 200);
    await act(async () => {
      finish(latePixels);
    });
    expect(canvas.width).toBe(0);
    expect(latePixels.close).toHaveBeenCalledOnce();
    await renderPage(cache);
    expect(canvas.width).toBe(1);
  });

  it("closes a late bitmap and preserves retained text independently of pixel cancellation", async () => {
    let finish!: (bitmap: ImageBitmap) => void;
    mocks.client.drawPage.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const cache = new PdfCanvasCache();
    const canvas = await renderPage(cache);
    await renderPage(cache, false, 1, true);
    const close = vi.fn();
    await act(async () => {
      finish({ close } as unknown as ImageBitmap);
      await vi.advanceTimersByTimeAsync(150);
    });
    expect(close).toHaveBeenCalledOnce();
    expect(canvas.width).toBe(0);
    expect(container.querySelector(".mupdf-text-layer")).not.toBeNull();
    expect(container.querySelector(".mupdf-link-layer a")).not.toBeNull();
  });

  it("invalidates old zoom pixels and releases allocations on unmount", async () => {
    const cache = new PdfCanvasCache();
    const canvas = await renderPage(cache);
    await renderPage(cache, false, 2);
    expect(canvas.width).toBe(0);
    await renderPage(cache, true, 2);
    expect(mocks.client.drawPage).toHaveBeenLastCalledWith(
      1,
      0,
      144,
      expect.any(AbortSignal),
    );
    await act(async () => root.render(null));
    expect(canvas.width).toBe(0);
    expect(canvas.height).toBe(0);
  });
  it("clears failed replacement pixels and retries on return", async () => {
    const cache = new PdfCanvasCache();
    const canvas = await renderPage(cache);
    const close = vi.fn();
    mocks.client.drawPage.mockResolvedValueOnce({
      close,
    } as unknown as ImageBitmap);
    vi.mocked(canvas.getContext).mockReturnValueOnce({
      drawImage: () => {
        throw new Error("draw failed");
      },
    } as unknown as CanvasRenderingContext2D);
    await renderPage(cache, true, 2);
    expect(canvas.width).toBe(0);
    expect(close).toHaveBeenCalledOnce();
    await renderPage(cache, false, 2);
    await renderPage(cache, true, 2);
    expect(canvas.width).toBe(1);
    expect(mocks.client.drawPage).toHaveBeenCalledTimes(3);
  });

  it("forces a fresh draw after background canvas loss", async () => {
    const cache = new PdfCanvasCache();
    const canvas = await renderPage(cache);
    canvas.width = 0;
    await act(async () => {
      window.dispatchEvent(new Event("app-visibility-restored"));
    });
    expect(mocks.client.drawPage).toHaveBeenCalledTimes(2);
    expect(canvas.width).toBe(1);
  });
  it("recovers background pixel loss once panel motion finishes", async () => {
    const cache = new PdfCanvasCache();
    const canvas = await renderPage(cache);
    await renderPage(cache, true, 1, false, 1, 1, true);
    canvas.width = 0;
    await act(async () => {
      window.dispatchEvent(new Event("app-visibility-restored"));
    });
    expect(mocks.client.drawPage).toHaveBeenCalledOnce();
    await renderPage(cache);
    expect(mocks.client.drawPage).toHaveBeenCalledTimes(2);
    expect(canvas.width).toBe(1);
  });
  it("rejects a late bitmap after document replacement", async () => {
    let finish!: (bitmap: ImageBitmap) => void;
    mocks.client.drawPage.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const cache = new PdfCanvasCache();
    const canvas = await renderPage(cache);
    await renderPage(cache, true, 1, false, 2);
    const close = vi.fn();
    await act(async () => {
      finish({ close } as unknown as ImageBitmap);
    });
    expect(close).toHaveBeenCalledOnce();
    expect(canvas.width).toBe(1);
    await renderPage(cache, false, 1, false, 2);
    await renderPage(cache, true, 1, false, 2);
    expect(mocks.client.drawPage).toHaveBeenCalledTimes(2);
    expect(mocks.client.drawPage).toHaveBeenLastCalledWith(
      2,
      0,
      72,
      expect.any(AbortSignal),
    );
  });
  it("redraws cached pixels lost while the page was offscreen", async () => {
    const cache = new PdfCanvasCache();
    const canvas = await renderPage(cache);
    await renderPage(cache, false);
    await act(async () => {
      window.dispatchEvent(new Event("app-visibility-restored"));
    });
    vi.mocked(canvas.getContext).mockReturnValueOnce({
      getImageData: () => ({ data: new Uint8ClampedArray(16) }),
    } as unknown as CanvasRenderingContext2D);
    await renderPage(cache);
    expect(mocks.client.drawPage).toHaveBeenCalledTimes(2);
  });

  it("reuses visible pixels through motion without GPU readbacks, but validates offscreen returns", async () => {
    const cache = new PdfCanvasCache();
    const canvas = await renderPage(cache);
    const readback = vi.fn(() => ({
      data: new Uint8ClampedArray([255, 255, 255, 255]),
    }));
    vi.mocked(canvas.getContext).mockReturnValue({
      getImageData: readback,
    } as unknown as CanvasRenderingContext2D);

    for (let n = 0; n < 3; n++) {
      await renderPage(cache, true, 1.5, false, 1, 1, true);
      await renderPage(cache);
    }
    expect(readback).not.toHaveBeenCalled();
    expect(mocks.client.drawPage).toHaveBeenCalledOnce();
    expect(canvas.width).toBe(1);

    await renderPage(cache, false);
    await renderPage(cache);
    expect(readback).toHaveBeenCalledOnce();
    expect(mocks.client.drawPage).toHaveBeenCalledOnce();
  });

  it("recovers when checking cached pixels throws", async () => {
    const cache = new PdfCanvasCache();
    const canvas = await renderPage(cache);
    await renderPage(cache, false);
    vi.mocked(canvas.getContext).mockReturnValueOnce({
      getImageData: () => {
        throw new Error("context lost");
      },
    } as unknown as CanvasRenderingContext2D);
    await renderPage(cache);
    expect(mocks.client.drawPage).toHaveBeenCalledTimes(2);
    expect(canvas.width).toBe(1);
  });
  it("keeps cached pixels when zoom is reversed before a new render finishes", async () => {
    const cache = new PdfCanvasCache();
    const canvas = await renderPage(cache);
    let finish!: (value: ReturnType<typeof pixels>) => void;
    mocks.client.drawPage.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    await renderPage(cache, true, 2);
    await renderPage(cache, true, 1);
    await act(async () => {
      finish(pixels(2, 2));
    });
    expect(canvas.width).toBe(1);
    expect(canvas.height).toBe(1);
    expect(mocks.client.drawPage).toHaveBeenCalledTimes(2);
  });

  it("cancels pending base renders during motion and keeps existing pixels until settling", async () => {
    const cache = new PdfCanvasCache();
    const canvas = await renderPage(cache);
    let finish!: (value: ReturnType<typeof pixels>) => void;
    mocks.client.drawPage.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    await renderPage(cache, true, 2);
    const signal = mocks.client.drawPage.mock.calls[1][3] as AbortSignal;
    expect(signal.aborted).toBe(false);
    await renderPage(cache, true, 3, false, 1, 3, true);
    expect(signal.aborted).toBe(true);
    const latePixels = pixels(2, 2);
    await act(async () => finish(latePixels));
    expect(latePixels.close).toHaveBeenCalledOnce();
    expect(canvas.width).toBe(1);
    expect(canvas.style.width).toBe("300px");
    expect(mocks.client.drawPage).toHaveBeenCalledTimes(2);
    await renderPage(cache, true, 3);
    expect(mocks.client.drawPage).toHaveBeenLastCalledWith(
      1,
      0,
      216,
      expect.any(AbortSignal),
    );
  });

  it("cancels base jobs on leaving the viewport and unmounting", async () => {
    mocks.client.drawPage.mockImplementation(() => new Promise(() => {}));
    const cache = new PdfCanvasCache();
    await renderPage(cache);
    const first = mocks.client.drawPage.mock.calls[0][3] as AbortSignal;
    await renderPage(cache, false);
    expect(first.aborted).toBe(true);
    await renderPage(cache);
    const second = mocks.client.drawPage.mock.calls[1][3] as AbortSignal;
    await act(async () => root.render(null));
    expect(second.aborted).toBe(true);
  });

  describe("high zoom detail canvas", () => {
    let pan: number;
    let cache: PdfCanvasCache;
    const viewportRef = { current: null as HTMLDivElement | null };
    beforeEach(() => {
      pan = 0;
      cache = new PdfCanvasCache();
      viewportRef.current = container;
      Object.defineProperties(container, {
        clientWidth: { value: 800 },
        clientHeight: { value: 600 },
      });
      vi.spyOn(
        HTMLElement.prototype,
        "getBoundingClientRect",
      ).mockImplementation(function (this: HTMLElement) {
        const rect =
          this === container
            ? { x: 0, y: 0, width: 800, height: 600 }
            : { x: -pan, y: 0, width: 612 * 12, height: 792 * 12 };
        return {
          ...rect,
          left: rect.x,
          top: rect.y,
          right: rect.x + rect.width,
          bottom: rect.y + rect.height,
          toJSON() {},
        };
      });
      vi.stubGlobal(
        "ResizeObserver",
        class {
          observe() {}
          disconnect() {}
        },
      );
      mocks.client.drawPageRegion.mockImplementation(
        async (_doc, _page, region) => pixels(region.width, region.height),
      );
    });
    afterEach(() => vi.unstubAllGlobals());
    async function renderLarge(docId = 1, renderDetails = true) {
      await act(async () =>
        root.render(
          <MupdfPage
            canvasCache={cache}
            viewportRef={viewportRef}
            docId={docId}
            pageIndex={0}
            scale={12}
            pageWidth={612}
            pageHeight={792}
            isVisible
            renderDetails={renderDetails}
          />,
        ),
      );
      return container.querySelector<HTMLCanvasElement>(
        "[data-pdf-detail-canvas]",
      )!;
    }
    async function settle() {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(150);
      });
    }
    async function scrollTo(x: number) {
      pan = x;
      await act(async () => container.dispatchEvent(new Event("scroll")));
      await settle();
    }
    it("keeps the base bitmap underneath and reuses detail pixels during a small pan", async () => {
      const detail = await renderLarge();
      await settle();
      expect(detail.width).toBeGreaterThan(800);
      expect(detail.dataset.pdfRenderedScale).toBe("12");
      expect(detail.style.pointerEvents).toBe("");
      expect(detail.className).toContain("pointer-events-none");
      expect(
        container.querySelector<HTMLCanvasElement>("[data-pdf-page-canvas]")!
          .width,
      ).toBe(1);
      expect(mocks.client.drawPageRegion).toHaveBeenCalledOnce();
      await scrollTo(50);
      expect(mocks.client.drawPageRegion).toHaveBeenCalledOnce();
      await scrollTo(1000);
      expect(mocks.client.drawPageRegion).toHaveBeenCalledTimes(2);
      expect(parseFloat(detail.style.left)).toBeGreaterThan(0);
      await renderLarge(1, false);
      expect(detail.width).toBe(0);
    });
    it("discards a superseded pan result while preserving the newest detail pixels", async () => {
      const detail = await renderLarge();
      await settle();
      let finish!: (value: ReturnType<typeof pixels>) => void;
      mocks.client.drawPageRegion.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      await scrollTo(1000);
      const signal = mocks.client.drawPageRegion.mock
        .calls[1][3] as AbortSignal;
      await scrollTo(2000);
      expect(signal.aborted).toBe(true);
      const currentLeft = detail.style.left;
      const latePixels = pixels(2, 2);
      await act(async () => finish(latePixels));
      expect(latePixels.close).toHaveBeenCalledOnce();
      expect(detail.style.left).toBe(currentLeft);
      expect(detail.width).toBeGreaterThan(800);
    });
    it("closes a late bitmap after replacing the document and releases detail on unmount", async () => {
      const detail = await renderLarge();
      let finish!: (value: ImageBitmap) => void;
      mocks.client.drawPageRegion.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      await settle();
      await renderLarge(2);
      await settle();
      const close = vi.fn();
      const width = detail.width;
      await act(async () => finish({ close } as unknown as ImageBitmap));
      expect(close).toHaveBeenCalledOnce();
      expect(detail.width).toBe(width);
      expect(mocks.client.drawPageRegion).toHaveBeenLastCalledWith(
        2,
        0,
        expect.any(Object),
        expect.any(AbortSignal),
      );
      await act(async () => root.render(null));
      expect(detail.width).toBe(0);
      expect(detail.height).toBe(0);
    });
  });
});
