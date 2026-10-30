import { afterEach, expect, it, vi } from "vitest";
import {
  measurePdfSelection,
  pdfSelectionFragments,
} from "./pdf-selection-geometry";

afterEach(() => document.body.replaceChildren());

it("anchors multi-line SVG selections to glyphs, even when WebKit reports the page origin", () => {
  document.body.innerHTML = `<div><svg class="mupdf-text-layer"><text>abcd</text><text>efgh</text></svg></div>`;
  const viewport = document.body.firstElementChild as HTMLElement;
  const lines = [...viewport.querySelectorAll("text")];
  let scroll = 0;
  lines.forEach((line, index) => {
    Object.assign(line, {
      getNumberOfChars: () => 4,
      getComputedTextLength: () => 40,
      textLength: { baseVal: { value: 40 } },
      getBBox: () => ({ x: 0 }),
      getExtentOfChar: (char: number) => ({
        x: char * 10,
        y: index * 20,
        width: 10,
        height: 15,
      }),
      getScreenCTM: () => ({ a: 2, b: 0, c: 0, d: 2, e: 100, f: 300 - scroll }),
    });
  });
  const range = document.createRange();
  range.setStart(lines[0].firstChild!, 2);
  range.setEnd(lines[1].firstChild!, 2);
  const incorrectBrowserBounds = vi.fn(() => new DOMRect(0, 0, 600, 400));
  range.getBoundingClientRect = incorrectBrowserBounds;
  const getBounds = measurePdfSelection(range, viewport);
  expect(getBounds()).toMatchObject({
    left: 100,
    top: 300,
    right: 180,
    bottom: 370,
  });
  scroll = 80;
  expect(getBounds()).toMatchObject({ top: 220, bottom: 290 });
  expect(incorrectBrowserBounds).not.toHaveBeenCalled();
  viewport.remove();
  expect(getBounds()).toBeNull();
});

it("does not include a line when the selection ends at its first character", () => {
  document.body.innerHTML = `<div><svg class="mupdf-text-layer"><text>abcd</text><text>efgh</text></svg></div>`;
  const viewport = document.body.firstElementChild as HTMLElement;
  const lines = [...viewport.querySelectorAll("text")];
  lines.forEach((line, index) =>
    Object.assign(line, {
      getNumberOfChars: () => 4,
      getComputedTextLength: () => 40,
      textLength: { baseVal: { value: 40 } },
      getBBox: () => ({ x: 0 }),
      getExtentOfChar: (char: number) => ({
        x: char * 10,
        y: index * 20,
        width: 10,
        height: 15,
      }),
      getScreenCTM: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
    }),
  );
  const range = document.createRange();
  range.setStart(lines[0].firstChild!, 1);
  range.setEnd(lines[1].firstChild!, 0);
  expect(measurePdfSelection(range, viewport)()).toMatchObject({
    left: 10,
    top: 0,
    right: 40,
    bottom: 15,
  });
});

it("keeps separate text regions apart even when their baselines align", () => {
  document.body.innerHTML = `<div><svg><g class="mupdf-text-layer"><text>left</text><text>right</text></g></svg></div>`;
  const viewport = document.body.firstElementChild as HTMLElement;
  const lines = [...viewport.querySelectorAll("text")];
  lines.forEach((line, column) =>
    Object.assign(line, {
      getNumberOfChars: () => line.textContent!.length,
      getComputedTextLength: () => line.textContent!.length * 10,
      textLength: { baseVal: { value: 0 } },
      getExtentOfChar: (index: number) => ({
        x: column * 300 + index * 10,
        y: 0,
        width: 10,
        height: 15,
      }),
    }),
  );
  const range = document.createRange();
  range.setStart(lines[0].firstChild!, 0);
  range.setEnd(lines[1].firstChild!, 5);
  expect(pdfSelectionFragments(range, viewport)).toMatchObject([
    { left: 0, right: 40 },
    { left: 300, right: 350 },
  ]);
});
