import {
  getSynctexSourceMap,
  type SynctexSourceMap,
} from "@/lib/latex-compiler";
import type { PdfReadingAnchor } from "./pdf-reading-anchor";

type Sample = { source: number; pdf: PdfReadingAnchor };
export type PdfMapSpan = {
  from: PdfReadingAnchor;
  to: PdfReadingAnchor;
  fraction: number;
};
const normalize = (file: string) =>
  file.replace(/\\/g, "/").replace(/^\.\//, "");
const pdfOrder = (a: PdfReadingAnchor, b: PdfReadingAnchor) =>
  a.page - b.page || a.pdfY - b.pdfY;

function upperBound<T>(items: T[], value: number, key: (item: T) => number) {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (key(items[mid]) <= value) low = mid + 1;
    else high = mid;
  }
  return low;
}

export async function indexPdfSourceMap(map: SynctexSourceMap) {
  const rows = new Map<string, Map<number, PdfReadingAnchor[]>>();
  for (let i = 0; i < map.boxes.length; i++) {
    const box = map.boxes[i];
    if (!(box.page > 0 && Number.isFinite(box.y))) continue;
    for (const source of box.sources) {
      const file = map.inputs[source.tag];
      if (!file || source.line < 1) continue;
      const key = normalize(file);
      let lines = rows.get(key);
      if (!lines) rows.set(key, (lines = new Map()));
      let points = lines.get(source.line);
      if (!points) lines.set(source.line, (points = []));
      points.push({
        page: box.page,
        pdfX: box.x + box.width / 2,
        pdfY: box.y + box.height / 2,
      });
    }
    // Large maps are indexed once without monopolizing the renderer event loop.
    if (i > 0 && i % 4096 === 0)
      await new Promise((resolve) => setTimeout(resolve, 0));
  }
  const files = new Map<
    string,
    { source: Sample[]; pages: Map<number, Sample[]> }
  >();
  for (const [file, lines] of rows) {
    const source: Sample[] = [];
    const pages = new Map<number, Sample[]>();
    for (const [line, points] of lines) {
      points.sort(pdfOrder);
      const unique = points.filter(
        (point, i) =>
          i === 0 ||
          point.page !== points[i - 1].page ||
          Math.abs(point.pdfY - points[i - 1].pdfY) > 0.5,
      );
      for (let i = 0; i < unique.length; i++) {
        const sample = {
          source: line + (i + 0.5) / unique.length,
          pdf: unique[i],
        };
        source.push(sample);
        const page = pages.get(sample.pdf.page) ?? [];
        page.push(sample);
        pages.set(sample.pdf.page, page);
      }
    }
    source.sort((a, b) => a.source - b.source);
    for (const page of pages.values())
      page.sort((a, b) => a.pdf.pdfY - b.pdf.pdfY || a.pdf.pdfX - b.pdf.pdfX);
    files.set(file, { source, pages });
  }
  return {
    forward(file: string, coordinate: number): PdfMapSpan | null {
      const points = files.get(normalize(file))?.source;
      if (!points?.length) return null;
      const at = upperBound(points, coordinate, (sample) => sample.source);
      const from = points[Math.max(0, at - 1)];
      const to = points[Math.min(points.length - 1, at)];
      if (
        coordinate < from.source - 1 ||
        coordinate > to.source + 1 ||
        to.source - from.source > 200 ||
        pdfOrder(from.pdf, to.pdf) > 0
      )
        return null;
      return {
        from: from.pdf,
        to: to.pdf,
        fraction:
          to.source === from.source
            ? 0
            : Math.max(
                0,
                Math.min(
                  1,
                  (coordinate - from.source) / (to.source - from.source),
                ),
              ),
      };
    },
    inverse(file: string, point: PdfReadingAnchor): number | null {
      const points = files.get(normalize(file))?.pages.get(point.page);
      if (!points?.length) return null;
      const at = upperBound(points, point.pdfY, (sample) => sample.pdf.pdfY);
      const from = points[Math.max(0, at - 1)];
      const to = points[Math.min(points.length - 1, at)];
      if (to.source < from.source || to.source - from.source > 200) return null;
      const distance = to.pdf.pdfY - from.pdf.pdfY;
      const fraction =
        distance <= 0
          ? 0
          : Math.max(0, Math.min(1, (point.pdfY - from.pdf.pdfY) / distance));
      return from.source + (to.source - from.source) * fraction;
    },
  };
}

/** Shared lazy load for comments and scrolling, owned by one compiled revision. */
export function createCompiledPdfMap(projectRoot: string) {
  let raw: ReturnType<typeof getSynctexSourceMap> | null = null;
  let pending: Promise<Awaited<
    ReturnType<typeof indexPdfSourceMap>
  > | null> | null = null;
  let ready: Awaited<ReturnType<typeof indexPdfSourceMap>> | null = null;
  const load = () => (raw ??= getSynctexSourceMap(projectRoot));
  return {
    load,
    get index() {
      return ready;
    },
    prepare() {
      return (pending ??= load().then(async (map) => {
        ready = map ? await indexPdfSourceMap(map) : null;
        return ready;
      }));
    },
  };
}
