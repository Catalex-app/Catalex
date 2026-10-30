import { describe, expect, it, vi } from "vitest";
import { PdfCanvasCache } from "./pdf-canvas-cache";

function page(cache: PdfCanvasCache, protectedPage = false) {
  const canvas = document.createElement("canvas");
  canvas.width = 10;
  canvas.height = 10;
  const release = vi.fn();
  const state = { protectedPage };
  cache.store(canvas, () => state.protectedPage, release);
  return { canvas, release, state };
}

describe("PDF canvas budget", () => {
  it("evicts the least recently visited offscreen canvas", () => {
    const cache = new PdfCanvasCache(800);
    const first = page(cache);
    const second = page(cache);
    cache.touch(first.canvas);
    page(cache, true);
    expect(second.release).toHaveBeenCalledOnce();
    expect(first.release).not.toHaveBeenCalled();
  });

  it("counts protected pixels and trims overflow once protection ends", () => {
    const cache = new PdfCanvasCache(400);
    const first = page(cache, true);
    const second = page(cache, true);
    expect(first.release).not.toHaveBeenCalled();
    expect(second.release).not.toHaveBeenCalled();
    first.state.protectedPage = false;
    cache.trim();
    expect(first.release).toHaveBeenCalledOnce();
    expect(second.release).not.toHaveBeenCalled();
  });

  it("accounts for replacement dimensions and removal without double counting", () => {
    const cache = new PdfCanvasCache(800);
    const first = page(cache, true);
    first.canvas.width = 20;
    cache.store(first.canvas, () => true, first.release);
    const second = page(cache);
    expect(second.release).toHaveBeenCalledOnce();
    cache.remove(first.canvas);
    cache.remove(first.canvas);
    expect(first.release).toHaveBeenCalledOnce();
    const third = page(cache);
    expect(third.release).not.toHaveBeenCalled();
  });
  it("keeps separate viewers independent", () => {
    const firstViewer = new PdfCanvasCache(400);
    const secondViewer = new PdfCanvasCache(400);
    const first = page(firstViewer);
    const second = page(secondViewer);
    page(firstViewer, true);
    expect(first.release).toHaveBeenCalledOnce();
    expect(second.release).not.toHaveBeenCalled();
  });
});
