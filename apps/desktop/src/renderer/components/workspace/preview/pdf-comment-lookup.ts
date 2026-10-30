import {
  getSynctexSourceMap,
  type SynctexSourceMap,
} from "@/lib/latex-compiler";

export interface PdfCommentSourceBox {
  x: number;
  y: number;
  width: number;
  height: number;
  sources: Array<{ file: string; line: number }>;
}

// One lazy read per compiled PDF, shared by all pages. Unmounting a page must
// not cancel the load needed by other pages or poison the cache on remount.
export function createPdfCommentLookup(
  projectRoot: string,
  load = (): Promise<SynctexSourceMap | null> =>
    getSynctexSourceMap(projectRoot),
) {
  let pending: Promise<Map<number, PdfCommentSourceBox[]> | null> | null = null;
  return async (page: number, signal: AbortSignal) => {
    if (signal.aborted) return [];
    pending ??= load().then((map) => {
      if (!map) {
        pending = null;
        return null;
      }
      const pages = new Map<number, PdfCommentSourceBox[]>();
      for (const box of map.boxes) {
        const boxes = pages.get(box.page) ?? [];
        boxes.push({
          ...box,
          sources: box.sources.flatMap(({ tag, line }) => {
            const file = map.inputs[tag];
            return file ? [{ file, line }] : [];
          }),
        });
        pages.set(box.page, boxes);
      }
      return pages;
    });
    const pages = await pending;
    return signal.aborted ? [] : (pages?.get(page) ?? []);
  };
}
