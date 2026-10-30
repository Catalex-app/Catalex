import {
  PDF_TEXT_GAP,
  normalizePdfCommentText as normalize,
  pdfCommentVisibleText,
  projectVisibleText,
} from "./pdf-comment-text";

export interface PdfCommentRange {
  from: number;
  to: number;
  line: number;
}

export type PdfCommentRangeMatch =
  | { status: "matched"; range: PdfCommentRange }
  | { status: "unmatched" | "ambiguous" };

export function findPdfCommentRange(
  source: string,
  selected: string,
  nearLine?: number,
  context?: { before: string; after: string },
): PdfCommentRange | null {
  const result = matchPdfCommentRange(source, selected, nearLine, context);
  return result.status === "matched" ? result.range : null;
}

interface PdfCommentCandidate {
  range: PdfCommentRange;
  contextScore: number;
  lineDistance: number;
  approximate: boolean;
}

// Endpoint mapping asks about many rendered lines from the same document.
// Retain only a small, bounded set of immutable source snapshots, never every
// edit made during a long-running session. Oversized documents remain uncached.
const sourceIndexes = new Map<string, ReturnType<typeof buildSourceIndex>>();
const MAX_INDEXED_SOURCE_LENGTH = 250_000;
function buildSourceIndex(source: string) {
  const projection = projectVisibleText(source);
  return {
    haystack: normalize(source),
    projection,
    visible: projection ? normalize(projection.text) : null,
  };
}
function sourceIndex(source: string) {
  const cached = sourceIndexes.get(source);
  if (cached) {
    sourceIndexes.delete(source);
    sourceIndexes.set(source, cached);
    return cached;
  }
  const index = buildSourceIndex(source);
  if (source.length <= MAX_INDEXED_SOURCE_LENGTH) {
    sourceIndexes.set(source, index);
    if (sourceIndexes.size > 2)
      sourceIndexes.delete(sourceIndexes.keys().next().value!);
  }
  return index;
}

/** Collect verified text spans; never substitute a whole source row. */
function pdfCommentCandidates(
  source: string,
  selected: string,
  nearLine?: number,
  context?: { before: string; after: string },
): PdfCommentCandidate[] {
  const needle = normalize(selected).value;
  if (needle.length < 2) return [];
  const { haystack, projection, visible } = sourceIndex(source);
  if (!projection || !visible) return [];
  const candidates: { from: number; to: number; line: number }[] = [];
  const add = (start: number, end: number) => {
    const from = haystack.offsets[start];
    const to = haystack.ends[end - 1];
    if (!projection.starts.includes(from) || !projection.ends.includes(to))
      return;
    const projected = normalize(
      pdfCommentVisibleText(source.slice(from, to)) ?? "",
    ).value;
    const pattern = projected
      .split(PDF_TEXT_GAP)
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join(".+?");
    if (!pattern || !new RegExp(`^${pattern}$`, "u").test(needle)) return;
    if (!candidates.some((c) => c.from === from && c.to === to))
      candidates.push({
        from,
        to,
        line: source.slice(0, from).split("\n").length,
      });
  };
  if (projection) {
    let index = visible.value.indexOf(needle);
    while (index >= 0) {
      const start = visible.offsets[index];
      const end = visible.ends[index + needle.length - 1] - 1;
      // Math is mapped as an atomic source span. A partial rendered equation
      // must not silently select the entire equation in the editor.
      const from = projection.starts[start];
      const to = projection.ends[end];
      if (
        !(start > 0 && projection.starts[start - 1] === from) &&
        !(end + 1 < projection.ends.length && projection.ends[end + 1] === to)
      ) {
        candidates.push({
          from,
          to,
          line: source.slice(0, from).split("\n").length,
        });
      }
      index = visible.value.indexOf(needle, index + 1);
    }
  }
  if (!candidates.length) {
    let index = haystack.value.indexOf(needle);
    while (index >= 0) {
      add(index, index + needle.length);
      index = haystack.value.indexOf(needle, index + 1);
    }
  }
  const approximate = !candidates.length;
  if (approximate && needle.length >= 9) {
    const prefix = needle.slice(0, 3);
    const suffix = needle.slice(-3);
    let start = visible.value.indexOf(prefix);
    while (start >= 0) {
      let end = visible.value.indexOf(suffix, start + 3);
      while (end >= 0 && end + 3 - start <= needle.length) {
        const span = visible.value.slice(start, end + 3);
        const parts = span.split(PDF_TEXT_GAP);
        const literalLength = parts.join("").length;
        // Small, bounded substitutions only. Both selection edges must be
        // literal text, and most of the selection must be verified prose.
        if (
          parts.length > 1 &&
          parts.length <= 4 &&
          parts.every((part) => part.length >= 3) &&
          literalLength >= Math.max(8, needle.length / 2)
        ) {
          const pattern = parts
            .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
            .join(".{1,64}?");
          const first = visible.offsets[start];
          const last = visible.ends[end + 2] - 1;
          const from = projection.starts[first];
          const to = projection.ends[last];
          const line = source.slice(0, from).split("\n").length;
          const lastLine = line + source.slice(from, to).split("\n").length - 1;
          if (
            !(first > 0 && projection.starts[first - 1] === from) &&
            !(
              last + 1 < projection.ends.length &&
              projection.ends[last + 1] === to
            ) &&
            new RegExp(`^${pattern}$`, "u").test(needle) &&
            (nearLine === undefined ||
              Math.max(line - nearLine, nearLine - lastLine, 0) <= 3)
          ) {
            candidates.push({ from, to, line });
          }
        }
        end = visible.value.indexOf(suffix, end + 1);
      }
      start = visible.value.indexOf(prefix, start + 1);
    }
  }
  const before = normalize(context?.before ?? "").value.slice(-64);
  const after = normalize(context?.after ?? "").value.slice(0, 64);
  return candidates.map((range) => {
    const start = projection.ends.findIndex((end) => end > range.from);
    let end = start;
    while (end < projection.starts.length && projection.starts[end] < range.to)
      end++;
    const prefix = normalize(
      projection.text.slice(Math.max(0, start - 256), start),
    ).value;
    const suffix = normalize(projection.text.slice(end, end + 256)).value;
    let left = 0,
      right = 0;
    while (
      left < before.length &&
      left < prefix.length &&
      before[before.length - left - 1] === prefix[prefix.length - left - 1]
    )
      left++;
    while (
      right < after.length &&
      right < suffix.length &&
      after[right] === suffix[right]
    )
      right++;
    const lastLine =
      range.line + source.slice(range.from, range.to).split("\n").length - 1;
    return {
      range,
      approximate,
      contextScore: left + right,
      lineDistance:
        nearLine === undefined
          ? Infinity
          : Math.max(range.line - nearLine, nearLine - lastLine, 0),
    };
  });
}

/** Conservative lookup retained for callers that require an unambiguous range. */
export function matchPdfCommentRange(
  source: string,
  selected: string,
  nearLine?: number,
  context?: { before: string; after: string },
): PdfCommentRangeMatch {
  const candidates = pdfCommentCandidates(source, selected, nearLine, context);
  if (!candidates.length) return { status: "unmatched" };
  if (candidates.length === 1)
    return { status: "matched", range: candidates[0].range };
  candidates.sort((a, b) => b.contextScore - a.contextScore);
  if (candidates[0].contextScore >= candidates[1].contextScore + 4)
    return { status: "matched", range: candidates[0].range };
  candidates.sort((a, b) => a.lineDistance - b.lineDistance);
  if (candidates[0].lineDistance < candidates[1].lineDistance)
    return { status: "matched", range: candidates[0].range };
  return { status: "ambiguous" };
}

/** Automatically choose among actual matches, with a visible notice for weak ties. */
export function pickPdfCommentRange(
  files: Array<{ filePath: string; content: string }>,
  selected: string,
  options: {
    context?: { before: string; after: string };
    source?: { filePath: string; line: number };
    activeFilePath?: string;
  } = {},
): { filePath: string; range: PdfCommentRange; approximate: boolean } | null {
  const candidates = files.flatMap((file) =>
    pdfCommentCandidates(
      file.content,
      selected,
      file.filePath === options.source?.filePath
        ? options.source.line
        : undefined,
      options.context,
    ).map((candidate) => ({ ...candidate, filePath: file.filePath })),
  );
  candidates.sort(
    (a, b) =>
      Number(a.approximate) - Number(b.approximate) ||
      b.contextScore - a.contextScore ||
      (a.lineDistance === b.lineDistance
        ? 0
        : a.lineDistance - b.lineDistance) ||
      Number(b.filePath === options.activeFilePath) -
        Number(a.filePath === options.activeFilePath) ||
      (a.filePath < b.filePath ? -1 : a.filePath > b.filePath ? 1 : 0) ||
      a.range.from - b.range.from ||
      a.range.to - b.range.to,
  );
  const [best, second] = candidates;
  if (!best) return null;
  const strongContext = second && best.contextScore >= second.contextScore + 4;
  const strongLocation =
    second && best.lineDistance <= 2 && best.lineDistance < second.lineDistance;
  return {
    filePath: best.filePath,
    range: best.range,
    approximate:
      best.approximate ||
      Boolean(
        second && !second.approximate && !strongContext && !strongLocation,
      ),
  };
}
