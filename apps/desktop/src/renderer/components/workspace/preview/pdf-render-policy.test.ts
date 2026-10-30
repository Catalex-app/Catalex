import { describe, expect, it } from "vitest";
import {
  pdfPageObserverRootMargin,
  pdfPageRenderKey,
} from "./pdf-render-policy";

describe("PDF render policy", () => {
  it("keys pages by document id so a recompiled PDF remounts stale page state", () => {
    expect(pdfPageRenderKey(12, 0)).toBe("12:0");
    expect(pdfPageRenderKey(13, 0)).not.toBe(pdfPageRenderKey(12, 0));
  });

  it("keeps eager page rendering near the viewport", () => {
    expect(pdfPageObserverRootMargin(800)).toBe("800px 0px");
  });
});
