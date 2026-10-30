import type { PdfSource } from "@/lib/mupdf/pdf-source";
import { getPdfBytes } from "@/stores/document-store";

export type PdfViewerDataSource =
  | {
      kind: "compiled";
      rootFileId: string;
      revision: number;
    }
  | {
      kind: "standalone";
      data: PdfSource;
    };

export function getPdfViewerBytes(
  source: PdfViewerDataSource,
): PdfSource | null {
  if (source.kind === "standalone") return source.data;
  return getPdfBytes(source.rootFileId) ?? null;
}

export function hasPdfViewerBytes(source: PdfViewerDataSource): boolean {
  return getPdfViewerBytes(source) != null;
}
