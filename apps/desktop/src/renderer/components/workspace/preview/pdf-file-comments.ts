import type {
  InlineEditorComment,
  PdfCommentAnchor,
} from "../editor/inline-comments";
import type { PdfCommentTarget, PreviewCommentRegion } from "./pdf-comments";

/** Geometry is valid only for the exact PDF snapshot that supplied the selection. */
export function pdfFileCommentTargets(
  filePath: string,
  fingerprint: string | null,
  comments: InlineEditorComment[],
): PdfCommentTarget[] {
  return comments.flatMap((comment) => {
    const anchor = comment.pdf;
    if (
      !anchor ||
      !validPdfCommentRegions(anchor.regions) ||
      anchor.fingerprint !== fingerprint ||
      comment.resolved ||
      (!comment.text.trim() && !comment.isEditing)
    )
      return [];
    return [
      {
        filePath,
        comment,
        firstLine: anchor.regions[0].page,
        lastLine: anchor.regions[anchor.regions.length - 1].page,
        sourceText: anchor.text,
        sourceBefore: "",
        sourceAfter: "",
      },
    ];
  });
}

export function pdfFileCommentRegions(
  targets: PdfCommentTarget[],
  page: number,
  preview?: { id: string; anchor: PdfCommentAnchor } | null,
): PreviewCommentRegion[] {
  return targets.flatMap((target) => {
    const regions =
      (preview?.id === target.comment.id ? preview.anchor : target.comment.pdf)
        ?.regions ?? [];
    return regions.flatMap((region, index) =>
      region.page === page
        ? [
            {
              bounds: {
                x: region.x,
                y: region.y,
                w: region.width,
                h: region.height,
              },
              ranges: [
                {
                  target,
                  x: region.x,
                  width: region.width,
                  start: index === 0,
                  end: index === regions.length - 1,
                },
              ],
            },
          ]
        : [],
    );
  });
}

export function validPdfCommentRegions(
  regions: PdfCommentAnchor["regions"] | undefined,
): regions is PdfCommentAnchor["regions"] {
  return (
    !!regions?.length &&
    regions.length <= 2000 &&
    regions.every(
      (r) =>
        Number.isInteger(r.page) &&
        r.page > 0 &&
        r.page <= 100000 &&
        [r.x, r.y, r.width, r.height].every(
          (v) => Number.isFinite(v) && v >= 0 && v <= 1000000,
        ) &&
        r.width > 0 &&
        r.height > 0,
    )
  );
}

export const emptyPdfCommentLookup = async () => [];
