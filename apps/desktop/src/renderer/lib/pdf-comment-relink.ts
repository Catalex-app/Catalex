import type {
  InlineEditorComment,
  PdfCommentAnchor,
} from "@/components/workspace/editor/inline-comments";
import { invoke } from "./desktop/core";
import { getMupdfClient } from "./mupdf/mupdf-client";
import { locatePdfCommentPassage } from "./mupdf/pdf-comment-passage";
import type { PdfFileSource } from "./mupdf/pdf-source";
import type { StructuredTextData } from "./mupdf/types";

// A revised PDF usually moves text by a few pages, not across the whole file.
const NEARBY_PAGES = 200;

const compact = (text: string) =>
  Array.from(text, (char) => char.normalize("NFKC"))
    .join("")
    .replace(/\s+/gu, "");

/**
 * Finds a comment's quoted text in another version of its PDF, starting at the
 * saved page and moving outward. Text repeated on the nearest page that has it
 * is not guessed.
 */
export async function relocatePdfCommentAnchor(
  anchor: PdfCommentAnchor,
  fingerprint: string,
  pageCount: number,
  pageText: (
    page: number,
  ) => Promise<{ data: StructuredTextData; text: string }>,
): Promise<PdfCommentAnchor | null> {
  const needle = compact(anchor.text);
  if (!needle) return null;
  const saved = Math.min(Math.max(anchor.regions[0]?.page ?? 1, 1), pageCount);
  for (let distance = 0; distance <= NEARBY_PAGES; distance++) {
    for (const page of distance
      ? [saved - distance, saved + distance]
      : [saved]) {
      if (page < 1 || page > pageCount) continue;
      const { data, text } = await pageText(page);
      if (!text.includes(needle)) continue;
      try {
        const regions = locatePdfCommentPassage(data, page, anchor.text);
        return { fingerprint, text: anchor.text, regions };
      } catch (error) {
        if (String(error).includes("ambiguous_passage")) return null;
      }
    }
  }
  return null;
}

/**
 * New positions for PDF comments whose file was replaced. Comments made on an
 * identical copy keep their saved position and need none.
 */
export async function relocatePdfComments(
  path: string,
  comments: InlineEditorComment[],
): Promise<Record<string, PdfCommentAnchor>> {
  const anchors: Record<string, PdfCommentAnchor> = {};
  if (!comments.some((comment) => comment.pdf)) return anchors;
  const source = await invoke<PdfFileSource>("desktop:pdf:open", { path });
  let client: ReturnType<typeof getMupdfClient> | undefined;
  let document: number | undefined;
  try {
    const fingerprint = source.fingerprint;
    const moved = comments.filter(
      (comment) => comment.pdf && comment.pdf.fingerprint !== fingerprint,
    );
    if (!fingerprint || !moved.length) return anchors;
    client = getMupdfClient();
    const opened = await client.openDocument(source);
    document = opened;
    const pageCount = await client.countPages(opened);
    const pages = new Map<
      number,
      Promise<{ data: StructuredTextData; text: string }>
    >();
    const pageText = (page: number) => {
      let cached = pages.get(page);
      if (!cached) {
        cached = client!.getPageText(opened, page - 1).then((data) => ({
          data,
          text: compact(
            data.blocks
              .flatMap((block) => block.lines.map((line) => line.text))
              .join(""),
          ),
        }));
        pages.set(page, cached);
      }
      return cached;
    };
    for (const comment of moved) {
      const anchor = await relocatePdfCommentAnchor(
        comment.pdf!,
        fingerprint,
        pageCount,
        pageText,
      );
      if (anchor) anchors[comment.id] = anchor;
    }
    return anchors;
  } finally {
    if (document !== undefined && client)
      await client.closeDocument(document).catch(() => {});
    await invoke("desktop:pdf:release", { id: source.id }).catch(() => {});
  }
}
