import type { PdfFileSource } from "./mupdf/pdf-source";
import { invoke } from "./desktop/core";
import { getMupdfClient } from "./mupdf/mupdf-client";
import { locatePdfCommentPassage } from "./mupdf/pdf-comment-passage";
import { useDocumentStore } from "@/stores/document-store";

export interface AgentPdfRequest {
  requestId: string;
  projectRoot: string;
  path: string;
  fingerprint: string;
  pages: number[];
  passage?: string;
}

/** Uses a private immutable document handle, without changing the visible PDF. */
export async function readAgentPdf(request: AgentPdfRequest) {
  if (useDocumentStore.getState().projectRoot !== request.projectRoot)
    throw new Error("stale_session: project changed");
  const source = await invoke<PdfFileSource>("desktop:pdf:open", {
    path: request.path,
  });
  let client: ReturnType<typeof getMupdfClient> | undefined;
  let document: number | undefined;
  try {
    if (source.fingerprint !== request.fingerprint)
      throw new Error("changed_pdf: read the current PDF again");
    client = getMupdfClient();
    document = await client.openDocument(source);
    const pageCount = await client.countPages(document);
    const pages = [];
    let anchor;
    for (const page of request.pages) {
      if (!Number.isInteger(page) || page < 1 || page > pageCount)
        throw new Error(`invalid_page: PDF has ${pageCount} pages`);
      const data = await client.getPageText(document, page - 1);
      const text = data.blocks
        .map((block) => block.lines.map((line) => line.text).join("\n"))
        .join("\n\n");
      if (new TextEncoder().encode(text).length > 80_000)
        throw new Error(
          "page_too_large: extracted page text exceeds the tool limit",
        );
      pages.push({ page, text });
      if (request.passage !== undefined) {
        anchor = {
          fingerprint: request.fingerprint,
          text: request.passage,
          regions: locatePdfCommentPassage(data, page, request.passage),
        };
      }
    }
    if (useDocumentStore.getState().projectRoot !== request.projectRoot)
      throw new Error("stale_session: project changed");
    return { fingerprint: request.fingerprint, pageCount, pages, anchor };
  } finally {
    if (document !== undefined && client)
      await client.closeDocument(document).catch(() => {});
    await invoke("desktop:pdf:release", { id: source.id }).catch(() => {});
  }
}
