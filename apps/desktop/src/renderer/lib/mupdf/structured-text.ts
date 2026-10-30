import type { StructuredText, Rect as MupdfRect } from "mupdf";
import type {
  StructuredTextData,
  StructuredTextBlock,
  StructuredTextLine,
} from "./types";

const rect = (bounds: MupdfRect) => ({
  x: bounds[0],
  y: bounds[1],
  w: bounds[2] - bounds[0],
  h: bounds[3] - bounds[1],
});

// Use MuPDF's supported walker instead of assuming a particular JSON schema.
export function extractStructuredText(
  text: Pick<StructuredText, "walk">,
): StructuredTextData {
  const blocks: StructuredTextBlock[] = [];
  let block: StructuredTextBlock | null = null;
  let line: StructuredTextLine | null = null;
  text.walk({
    beginTextBlock(bounds) {
      block = { type: "text", bbox: rect(bounds), lines: [] };
      blocks.push(block);
    },
    beginLine(bounds, wmode) {
      line = {
        bbox: rect(bounds),
        wmode,
        x: bounds[0],
        y: bounds[3],
        text: "",
        chars: [],
        font: {
          name: "",
          family: "serif",
          size: 12,
          weight: "normal",
          style: "normal",
        },
      };
      block?.lines.push(line);
    },
    onChar(c, origin, font, size, quad) {
      if (!line) return;
      if (!line.text) {
        line.x = origin[0];
        line.y = origin[1];
        line.font = {
          name: font.getName(),
          family: font.isSerif() ? "serif" : "sans-serif",
          size,
          weight: font.isBold() ? "bold" : "normal",
          style: font.isItalic() ? "italic" : "normal",
        };
      }
      line.text += c;
      line.chars!.push({
        c,
        quad: [...quad],
        origin: { x: origin[0], y: origin[1] },
      });
    },
    endLine() {
      line = null;
    },
    endTextBlock() {
      block = null;
    },
  });
  return { blocks };
}
