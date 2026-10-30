import type { LinkData, StructuredTextData } from "@/lib/mupdf/types";

/** Use text-line bounds for link decoration; preserve non-text link rectangles. */
export function alignPdfLinkToText(
  link: LinkData,
  text: StructuredTextData | null,
): LinkData {
  const lines = text?.blocks.flatMap((block) => block.lines) ?? [];
  const matches = lines.filter(({ bbox }) => {
    const horizontal =
      Math.min(link.x + link.w, bbox.x + bbox.w) - Math.max(link.x, bbox.x);
    const vertical =
      Math.min(link.y + link.h, bbox.y + bbox.h) - Math.max(link.y, bbox.y);
    return (
      horizontal > 0 && vertical > 0 && vertical >= Math.min(link.h, bbox.h) / 2
    );
  });
  if (!matches.length) return link;
  const top = Math.min(...matches.map((line) => line.bbox.y));
  const bottom = Math.max(...matches.map((line) => line.bbox.y + line.bbox.h));
  return { ...link, y: top, h: bottom - top };
}
