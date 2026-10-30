export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface FontInfo {
  family: string;
  size: number;
  weight: string;
  style: string;
}

export interface StructuredTextChar {
  c: string;
  quad: number[];
  origin: { x: number; y: number };
}

export interface StructuredTextSpan {
  font: FontInfo;
  chars: StructuredTextChar[];
}

export interface StructuredTextLine {
  chars?: StructuredTextChar[];
  bbox: Rect;
  wmode: number;
  x: number;
  y: number;
  text: string;
  font: {
    name: string;
    family: string;
    size: number;
    weight: string;
    style: string;
  };
}

export interface StructuredTextBlock {
  type: "text";
  bbox: Rect;
  lines: StructuredTextLine[];
}

export interface StructuredTextData {
  blocks: StructuredTextBlock[];
}

export interface LinkData {
  x: number;
  y: number;
  w: number;
  h: number;
  href: string;
  isExternal: boolean;
}

export interface PageSize {
  width: number;
  height: number;
}

// Detail canvases have their own small allocation limit, independent of zoom.
export const MAX_PDF_DETAIL_PIXELS = 8 * 1024 * 1024;
export const MAX_PDF_DETAIL_SIDE = 8192;

/** Integer pixel bounds in the scaled page, whose top-left is (0, 0). */
export interface PageRasterRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
}

export type WorkerRequest = [string, number, unknown[]];
export type WorkerResponse =
  | ["RESULT", number, unknown]
  | ["ERROR", number, { name: string; message: string }]
  | ["INIT", number, string[]];
