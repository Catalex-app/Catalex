import { expect, it } from "vitest";
import {
  alignPdfReadingAnchor,
  readPdfReadingAnchor,
} from "./pdf-reading-anchor";

it("reads and aligns a deep page with logarithmic geometry work", () => {
  const container = document.createElement("div");
  const content = document.createElement("div");
  content.setAttribute("data-pdf-scroll-content", "");
  container.append(content);
  Object.defineProperties(container, {
    clientWidth: { value: 100 },
    clientHeight: { value: 100 },
  });
  container.getBoundingClientRect = () => ({ top: 0, left: 0 }) as DOMRect;
  let reads = 0;
  const count = 10000;
  const focused = 8000;
  container.scrollTop = (focused - 1) * 132;
  for (let i = 0; i < count; i++) {
    const page = document.createElement("div");
    page.dataset.pageNumber = String(i + 1);
    page.getBoundingClientRect = () => {
      reads++;
      return {
        top: i * 132 - container.scrollTop,
        bottom: i * 132 + 100 - container.scrollTop,
        left: 0,
        width: 100,
        height: 100,
      } as DOMRect;
    };
    content.append(page);
  }
  const sizes = Array.from({ length: count }, () => ({
    width: 100,
    height: 100,
  }));
  expect(readPdfReadingAnchor(container, sizes)).toMatchObject({
    page: focused,
    pdfY: 50,
  });
  expect(reads).toBeLessThan(20);
  reads = 0;
  alignPdfReadingAnchor(container, sizes, {
    page: focused + 100,
    pdfX: 50,
    pdfY: 50,
  });
  expect(reads).toBe(1);
  expect(container.scrollTop).toBe((focused + 99) * 132);
});
