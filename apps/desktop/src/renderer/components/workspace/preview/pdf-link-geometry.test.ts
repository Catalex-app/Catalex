import { describe, expect, it } from "vitest";
import type { StructuredTextData } from "@/lib/mupdf/types";
import { alignPdfLinkToText } from "./pdf-link-geometry";

const text = {
  blocks: [
    { type: "text", lines: [{ bbox: { x: 10, y: 20, w: 200, h: 12 } }] },
  ],
} as StructuredTextData;
const link = { x: 20, y: 22, w: 40, h: 8, href: "#page=2", isExternal: false };

describe("alignPdfLinkToText", () => {
  it("aligns different annotation heights to the same text line", () => {
    expect(alignPdfLinkToText(link, text)).toEqual({ ...link, y: 20, h: 12 });
    expect(alignPdfLinkToText({ ...link, y: 18, h: 16 }, text)).toEqual({
      ...link,
      y: 20,
      h: 12,
    });
  });
  it("preserves image links and links without text geometry", () => {
    const imageLink = { ...link, x: 400 };
    expect(alignPdfLinkToText(imageLink, text)).toEqual(imageLink);
    expect(alignPdfLinkToText(link, null)).toEqual(link);
  });
});
