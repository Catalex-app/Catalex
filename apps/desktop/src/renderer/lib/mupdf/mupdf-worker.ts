import { ASSET_PROTOCOL } from "../../../branding";
import type { PdfFileSource } from "./pdf-source";
import { PdfRangeReader } from "./pdf-range-stream";
import { searchPdfText, type PreviewSearchQuery } from "../preview-search";
import type { PageRasterRegion, StructuredTextData } from "./types";
import { drawPageRegion } from "./draw-page-region";
import { extractStructuredText } from "./structured-text";
import * as mupdf from "mupdf";

const documentMap = new Map<number, mupdf.PDFDocument>();
let nextDocId = 1;

const methods: Record<string, (...args: any[]) => any> = {};

function fileStream(source: PdfFileSource) {
  if (!Number.isSafeInteger(source.byteLength) || source.byteLength < 5)
    throw new Error("Invalid PDF size");
  if (
    !source.url.startsWith(`${ASSET_PROTOCOL}://pdf/`) ||
    !/^[a-f0-9-]+$/.test(source.url.slice(`${ASSET_PROTOCOL}://pdf/`.length))
  )
    throw new Error("Invalid PDF source");
  const request = (method: string, url: string, binary = false) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, url, false);
    if (binary) xhr.responseType = "arraybuffer";
    xhr.send();
    if (xhr.status < 200 || xhr.status >= 300)
      throw new Error(`PDF range request failed (${xhr.status})`);
    return binary ? xhr.response : xhr.responseText;
  };
  const lease = request("POST", `${source.url}/lease`);
  const url = `${ASSET_PROTOCOL}://pdf/${lease}`;
  const reader = new PdfRangeReader(
    source.byteLength,
    (offset, length) =>
      new Uint8Array(
        request("GET", `${url}?offset=${offset}&length=${length}`, true),
      ),
  );
  const handle = {
    fileSize: () => reader.fileSize(),
    read: (
      memory: Uint8Array,
      offset: number,
      length: number,
      position: number,
    ) => reader.read(memory, offset, length, position),
    close: () => {
      reader.close();
      try {
        request("DELETE", url);
      } catch {
        /* Window shutdown also releases leases. */
      }
    },
  };
  try {
    return new mupdf.Stream(handle);
  } catch (error) {
    handle.close();
    throw error;
  }
}

methods.openDocument = (
  buffer: ArrayBuffer | PdfFileSource,
  magic: string,
): number => {
  const docId = nextDocId++;
  const stream = buffer instanceof ArrayBuffer ? null : fileStream(buffer);
  let doc: mupdf.PDFDocument;
  try {
    doc = mupdf.Document.openDocument(
      stream ?? (buffer as ArrayBuffer),
      magic,
    ) as mupdf.PDFDocument;
  } finally {
    stream?.destroy();
  }
  documentMap.set(docId, doc);
  return docId;
};

methods.closeDocument = (docId: number): void => {
  const doc = documentMap.get(docId);
  if (doc) {
    documentMap.delete(docId);
    doc.destroy();
  }
};

methods.resetDocuments = (): void => {
  for (const doc of documentMap.values()) doc.destroy();
  documentMap.clear();
};

methods.countPages = (docId: number): number => {
  const doc = documentMap.get(docId)!;
  return doc.countPages();
};

methods.getPageSize = (
  docId: number,
  pageIndex: number,
): { width: number; height: number } => {
  const doc = documentMap.get(docId)!;
  const page = doc.loadPage(pageIndex);
  try {
    const bounds = page.getBounds();
    return {
      width: bounds[2] - bounds[0],
      height: bounds[3] - bounds[1],
    };
  } finally {
    page.destroy();
  }
};

methods.getAllPageSizes = (
  docId: number,
): { width: number; height: number }[] => {
  const doc = documentMap.get(docId)!;
  const count = doc.countPages();
  const sizes: { width: number; height: number }[] = [];
  for (let i = 0; i < count; i++) {
    const page = doc.loadPage(i);
    try {
      const bounds = page.getBounds();
      sizes.push({
        width: bounds[2] - bounds[0],
        height: bounds[3] - bounds[1],
      });
    } finally {
      page.destroy();
    }
  }
  return sizes;
};

const rasterCanvas = new OffscreenCanvas(1, 1);
const rasterContext = rasterCanvas.getContext("2d")!;
let rasterPixels: ImageData | undefined;

function pixmapBitmap(pixmap: mupdf.Pixmap): ImageBitmap {
  const w = pixmap.getWidth();
  const h = pixmap.getHeight();
  // Reuse one staging buffer instead of sending a new RGBA allocation per page.
  if (rasterPixels?.width !== w || rasterPixels.height !== h) {
    rasterCanvas.width = w;
    rasterCanvas.height = h;
    rasterPixels = rasterContext.createImageData(w, h);
  }
  const rgb = pixmap.getPixels();
  const rgba = rasterPixels.data;
  for (let i = 0, j = 0; i < rgb.length; i += 3, j += 4) {
    rgba[j] = rgb[i];
    rgba[j + 1] = rgb[i + 1];
    rgba[j + 2] = rgb[i + 2];
    rgba[j + 3] = 255;
  }
  rasterContext.putImageData(rasterPixels, 0, 0);
  return rasterCanvas.transferToImageBitmap();
}

methods.drawPageRegion = (
  docId: number,
  pageIndex: number,
  region: PageRasterRegion,
): ImageBitmap => {
  const page = documentMap.get(docId)!.loadPage(pageIndex);
  try {
    const pixmap = drawPageRegion(page, region);
    try {
      return pixmapBitmap(pixmap);
    } finally {
      pixmap.destroy();
    }
  } finally {
    page.destroy();
  }
};

methods.drawPage = (
  docId: number,
  pageIndex: number,
  dpi: number,
): ImageBitmap => {
  const doc = documentMap.get(docId)!;
  const page = doc.loadPage(pageIndex);
  try {
    const scale = dpi / 72;
    const matrix = mupdf.Matrix.scale(scale, scale);
    // alpha=false so the PDF's white background is rendered opaquely (RGB, 3 bytes/pixel)
    const pixmap = page.toPixmap(
      matrix,
      mupdf.ColorSpace.DeviceRGB,
      false,
      true,
    );
    try {
      return pixmapBitmap(pixmap);
    } finally {
      pixmap.destroy();
    }
  } finally {
    page.destroy();
  }
};

methods.getPageText = (docId: number, pageIndex: number): unknown => {
  const doc = documentMap.get(docId)!;
  const page = doc.loadPage(pageIndex);
  try {
    const stext = page.toStructuredText("preserve-whitespace");
    try {
      return extractStructuredText(stext);
    } finally {
      stext.destroy();
    }
  } finally {
    page.destroy();
  }
};

methods.searchPage = (
  docId: number,
  pageIndex: number,
  query: PreviewSearchQuery,
) =>
  searchPdfText(
    methods.getPageText(docId, pageIndex) as StructuredTextData,
    query,
  );

methods.getPageLinks = (docId: number, pageIndex: number): unknown[] => {
  const doc = documentMap.get(docId)!;
  const page = doc.loadPage(pageIndex);
  try {
    const links = page.getLinks();
    try {
      return links.map((link: any) => {
        const bounds = link.getBounds();
        const uri: string = link.getURI() || "";
        const isExternal: boolean =
          link.isExternal?.() ?? uri.startsWith("http");
        let href: string;
        if (isExternal) {
          href = uri;
        } else {
          try {
            const resolved = doc.resolveLink(uri) as any;
            if (typeof resolved === "number") {
              href = `#page=${resolved + 1}`;
            } else if (resolved && typeof resolved.page === "number") {
              href = `#page=${resolved.page + 1}`;
            } else {
              href = uri;
            }
          } catch {
            href = uri;
          }
        }
        return {
          x: bounds[0],
          y: bounds[1],
          w: bounds[2] - bounds[0],
          h: bounds[3] - bounds[1],
          href,
          isExternal,
        };
      });
    } finally {
      for (const link of links) link.destroy();
    }
  } finally {
    page.destroy();
  }
};

methods.renderThumbnail = (
  docId: number,
  pageIndex: number,
  targetWidth: number,
): ArrayBuffer => {
  const doc = documentMap.get(docId)!;
  const page = doc.loadPage(pageIndex);
  try {
    const bounds = page.getBounds();
    const pageWidth = bounds[2] - bounds[0];
    const retinaScale = 2;
    const scale = (targetWidth * retinaScale) / pageWidth;
    const matrix = mupdf.Matrix.scale(scale, scale);
    const pixmap = page.toPixmap(
      matrix,
      mupdf.ColorSpace.DeviceRGB,
      false,
      true,
    );
    try {
      const png = pixmap.asPNG();
      return png.buffer as ArrayBuffer;
    } finally {
      pixmap.destroy();
    }
  } finally {
    page.destroy();
  }
};

// RPC message handler
self.onmessage = (event: MessageEvent) => {
  const [func, id, args] = event.data as [string, number, unknown[]];
  try {
    const result = methods[func](...args);
    if (result instanceof ImageBitmap) {
      postMessage(["RESULT", id, result], { transfer: [result] });
    } else if (result instanceof ArrayBuffer) {
      postMessage(["RESULT", id, result], { transfer: [result] });
    } else {
      postMessage(["RESULT", id, result]);
    }
  } catch (error: any) {
    postMessage(["ERROR", id, { name: error.name, message: error.message }]);
  }
};

postMessage(["INIT", 0, Object.keys(methods)]);
