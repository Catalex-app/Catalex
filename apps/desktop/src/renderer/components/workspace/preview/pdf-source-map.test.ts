import { expect, it, vi } from "vitest";
import { getSynctexSourceMap } from "@/lib/latex-compiler";
import { createCompiledPdfMap, indexPdfSourceMap } from "./pdf-source-map";
import { createPdfAnchorInterpolator } from "./pdf-reading-anchor";
vi.mock("@/lib/latex-compiler", () => ({ getSynctexSourceMap: vi.fn() }));

it("interpolates wrapped source rows and keeps separate files and pages", async () => {
  const index = await indexPdfSourceMap({
    inputs: { 1: "./main.tex", 2: "chapter.tex" },
    boxes: [
      {
        page: 1,
        x: 0,
        y: 10,
        width: 100,
        height: 10,
        sources: [{ tag: 1, line: 1 }],
      },
      {
        page: 1,
        x: 0,
        y: 30,
        width: 100,
        height: 10,
        sources: [{ tag: 1, line: 1 }],
      },
      {
        page: 2,
        x: 0,
        y: 10,
        width: 100,
        height: 10,
        sources: [{ tag: 1, line: 2 }],
      },
      {
        page: 2,
        x: 0,
        y: 30,
        width: 100,
        height: 10,
        sources: [{ tag: 2, line: 1 }],
      },
    ],
  });
  expect(index.forward("main.tex", 1.5)).toMatchObject({
    from: { page: 1, pdfY: 15 },
    to: { page: 1, pdfY: 35 },
    fraction: 0.5,
  });
  expect(index.inverse("main.tex", { page: 1, pdfX: 50, pdfY: 25 })).toBe(1.5);
  expect(index.forward("main.tex", 2)).toMatchObject({
    from: { page: 1 },
    to: { page: 2 },
  });
  expect(
    index.inverse("chapter.tex", { page: 1, pdfX: 50, pdfY: 25 }),
  ).toBeNull();
  expect(index.forward("missing", 1)).toBeNull();
});

it("rejects backwards float mappings and large source gaps", async () => {
  const index = await indexPdfSourceMap({
    inputs: { 1: "main.tex" },
    boxes: [
      {
        page: 2,
        x: 0,
        y: 10,
        width: 10,
        height: 10,
        sources: [{ tag: 1, line: 1 }],
      },
      {
        page: 1,
        x: 0,
        y: 10,
        width: 10,
        height: 10,
        sources: [{ tag: 1, line: 2 }],
      },
      {
        page: 3,
        x: 0,
        y: 10,
        width: 10,
        height: 10,
        sources: [{ tag: 1, line: 1000 }],
      },
    ],
  });
  expect(index.forward("main.tex", 2)).toBeNull();
  expect(index.forward("main.tex", 500)).toBeNull();
});

it("shares a single lazy native load and refreshes with a new compiled owner", async () => {
  vi.mocked(getSynctexSourceMap)
    .mockReset()
    .mockResolvedValue({ inputs: {}, boxes: [] });
  const cache = createCompiledPdfMap("/project");
  expect(getSynctexSourceMap).not.toHaveBeenCalled();
  await Promise.all([cache.load(), cache.prepare(), cache.prepare()]);
  expect(getSynctexSourceMap).toHaveBeenCalledTimes(1);
  expect(cache.index).not.toBeNull();
  await createCompiledPdfMap("/project").prepare();
  expect(getSynctexSourceMap).toHaveBeenCalledTimes(2);
});

it("interpolates across differently sized pages and scaled page gaps", () => {
  const interpolate = createPdfAnchorInterpolator([
    { width: 100, height: 200 },
    { width: 100, height: 400 },
  ]);
  const from = { page: 1, pdfX: 50, pdfY: 190 };
  const to = { page: 2, pdfX: 50, pdfY: 100 };
  expect(interpolate(from, to, 0)).toEqual(from);
  expect(interpolate(from, to, 1)).toEqual(to);
  // Page 2 starts at 212 (200 + 12 gap); midpoint of 190 and 312 is 251.
  expect(interpolate(from, to, 0.5)).toEqual({ page: 2, pdfX: 50, pdfY: 39 });
});

it("indexes a large compiled map once; subsequent queries never rescan its boxes", async () => {
  const count = 50000;
  const boxes = Array.from({ length: count }, (_, i) => ({
    page: Math.floor(i / 50) + 1,
    x: 0,
    y: (i % 50) * 15,
    width: 100,
    height: 10,
    sources: [{ tag: 1, line: i + 1 }],
  }));
  const index = await indexPdfSourceMap({ inputs: { 1: "main.tex" }, boxes });
  Object.defineProperty(boxes, 0, {
    get: () => {
      throw new Error("mapping rescanned during scrolling");
    },
  });
  for (let line = 100; line < count; line += 31) {
    expect(index.forward("main.tex", line + 0.5)?.fraction).toBe(0);
    expect(
      index.inverse("main.tex", {
        page: Math.floor((line - 1) / 50) + 1,
        pdfX: 50,
        pdfY: ((line - 1) % 50) * 15 + 5,
      }),
    ).toBe(line + 0.5);
  }
});
