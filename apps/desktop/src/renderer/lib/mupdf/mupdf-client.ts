import type { PdfFileSource } from "./pdf-source";
import type { PreviewSearchQuery } from "../preview-search";
import type { Rect } from "./types";
import type {
  StructuredTextData,
  LinkData,
  PageSize,
  PageRasterRegion,
  WorkerResponse,
} from "./types";
import { createLogger } from "@/lib/debug/logger";

const log = createLogger("mupdf-worker");

export interface MupdfClient {
  openDocument(
    buffer: ArrayBuffer | PdfFileSource,
    magic?: string,
  ): Promise<number>;
  closeDocument(docId: number): Promise<void>;
  countPages(docId: number): Promise<number>;
  getPageSize(docId: number, pageIndex: number): Promise<PageSize>;
  getAllPageSizes(docId: number): Promise<PageSize[]>;
  drawPage(
    docId: number,
    pageIndex: number,
    dpi: number,
    signal?: AbortSignal,
  ): Promise<ImageBitmap>;
  drawPageRegion(
    docId: number,
    pageIndex: number,
    region: PageRasterRegion,
    signal?: AbortSignal,
  ): Promise<ImageBitmap>;
  getPageText(docId: number, pageIndex: number): Promise<StructuredTextData>;
  searchPage(
    docId: number,
    pageIndex: number,
    query: PreviewSearchQuery,
  ): Promise<Rect[][]>;
  getPageLinks(docId: number, pageIndex: number): Promise<LinkData[]>;
  renderThumbnail(
    docId: number,
    pageIndex: number,
    targetWidth: number,
  ): Promise<ArrayBuffer>;
  resetDocuments(): Promise<void>;
  destroy(): void;
}

type PendingRequest = {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
};

function createClient(): MupdfClient {
  const worker = new Worker(new URL("./mupdf-worker.ts", import.meta.url), {
    type: "module",
  });

  const pending = new Map<number, PendingRequest>();
  let nextId = 1;
  let inFlight: number | null = null;
  let workTimer: ReturnType<typeof setTimeout> | undefined;
  let initialized = false;
  const queue: Array<{ id: number; send: () => void }> = [];
  function pump() {
    if (failed || !initialized || inFlight !== null) return;
    while (queue.length) {
      const next = queue.shift()!;
      if (!pending.has(next.id)) continue;
      inFlight = next.id;
      workTimer = setTimeout(
        () => failWorker(new Error("MuPDF worker job timed out")),
        30_000,
      );
      next.send();
      return;
    }
  }
  let resolveReady!: () => void;
  let failedError: Error | null = null;
  let failed = false;

  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });

  function failWorker(error: Error): void {
    if (failed) return;
    failed = true;
    failedError = error;
    for (const request of pending.values()) {
      request.reject(error);
    }
    pending.clear();
    queue.length = 0;
    clearTimeout(workTimer);
    worker.terminate();
    if (instance === client) {
      instance = null;
      clientRevision++;
    }
  }

  worker.onmessage = (event: MessageEvent) => {
    if (failed) return;
    const data = event.data as WorkerResponse;
    const [type, id, payload] = data;

    if (type === "INIT") {
      log.info("Worker initialized");
      initialized = true;
      resolveReady();
      pump();
      return;
    }

    if (inFlight === id) {
      inFlight = null;
      clearTimeout(workTimer);
    }
    const request = pending.get(id);
    if (!request) {
      // Executing renders can finish after cancellation. Nobody will consume
      // their transferred pixels, so release them here.
      if (typeof ImageBitmap !== "undefined" && payload instanceof ImageBitmap)
        payload.close();
      pump();
      return;
    }
    pending.delete(id);

    if (type === "RESULT") {
      request.resolve(payload);
    } else if (type === "ERROR") {
      const err = payload as { name: string; message: string };
      request.reject(new Error(`${err.name}: ${err.message}`));
    }
    pump();
  };

  worker.onerror = (event) => {
    log.error("Worker fatal error", { message: event.message });
    failWorker(new Error(`MuPDF worker failed: ${event.message}`));
  };

  const CALL_TIMEOUT_MS = 30_000;

  function callWithSignal(
    signal: AbortSignal | undefined,
    method: string,
    ...args: unknown[]
  ): Promise<any> {
    if (failedError) return Promise.reject(failedError);
    if (signal?.aborted)
      return Promise.reject(
        new DOMException("Superseded PDF render", "AbortError"),
      );

    return new Promise((resolve, reject) => {
      const id = nextId++;
      const abort = () => {
        pending
          .get(id)
          ?.reject(new DOMException("Superseded PDF render", "AbortError"));
        pending.delete(id);
        const queued = queue.findIndex((request) => request.id === id);
        if (queued >= 0) queue.splice(queued, 1);
        // An executing job still owns the worker slot until its reply arrives.
      };

      const timer = setTimeout(() => {
        if (pending.has(id)) {
          const error = new Error(
            `MuPDF worker timeout: ${method} took longer than ${CALL_TIMEOUT_MS}ms`,
          );
          if (inFlight === id) failWorker(error);
          else {
            pending.get(id)?.reject(error);
            pending.delete(id);
          }
        }
      }, CALL_TIMEOUT_MS);

      pending.set(id, {
        resolve: (value: any) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          resolve(value);
        },
        reject: (error: Error) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          reject(error);
        },
      });
      signal?.addEventListener("abort", abort, { once: true });

      ready.then(() => {
        if (!pending.has(id)) return;
        if (failedError) {
          pending.get(id)?.reject(failedError);
          pending.delete(id);
          return;
        }
        queue.push({
          id,
          send: () => {
            try {
              const transferables: Transferable[] = [];
              for (const arg of args) {
                if (arg instanceof ArrayBuffer) {
                  transferables.push(arg);
                }
              }

              worker.postMessage([method, id, args], {
                transfer: transferables,
              });
            } catch (err) {
              if (!pending.has(id)) return;
              const error = err instanceof Error ? err : new Error(String(err));
              pending.get(id)?.reject(error);
              pending.delete(id);
              inFlight = null;
              clearTimeout(workTimer);
              pump();
            }
          },
        });
        pump();
      });
    });
  }

  function call(method: string, ...args: unknown[]): Promise<any> {
    return callWithSignal(undefined, method, ...args);
  }

  const client: MupdfClient = {
    openDocument: (buffer, magic = "application/pdf") =>
      call("openDocument", buffer, magic),
    closeDocument: (docId) => call("closeDocument", docId),
    countPages: (docId) => call("countPages", docId),
    getPageSize: (docId, pageIndex) => call("getPageSize", docId, pageIndex),
    getAllPageSizes: (docId) => call("getAllPageSizes", docId),
    drawPage: (docId, pageIndex, dpi, signal) =>
      callWithSignal(signal, "drawPage", docId, pageIndex, dpi),
    drawPageRegion: (docId, pageIndex, region, signal) =>
      callWithSignal(signal, "drawPageRegion", docId, pageIndex, region),
    getPageText: (docId, pageIndex) => call("getPageText", docId, pageIndex),
    searchPage: (docId, pageIndex, query) =>
      call("searchPage", docId, pageIndex, query),
    getPageLinks: (docId, pageIndex) => call("getPageLinks", docId, pageIndex),
    renderThumbnail: (docId, pageIndex, targetWidth) =>
      call("renderThumbnail", docId, pageIndex, targetWidth),
    resetDocuments: () => {
      const error = new Error("Superseded PDF work");
      error.name = "AbortError";
      for (const request of pending.values()) request.reject(error);
      pending.clear();
      queue.length = 0;
      // Only the currently executing job can still be in the worker. Its reply
      // releases the slot; reset runs before any requests for the new PDF.
      return call("resetDocuments");
    },
    destroy: () => {
      failWorker(new Error("MuPDF worker was destroyed"));
    },
  };

  return client;
}

let instance: MupdfClient | null = null;
let clientRevision = 0;

export function getMupdfClientRevision(): number {
  return clientRevision;
}

export function getMupdfClient(): MupdfClient {
  if (!instance) {
    clientRevision++;
    instance = createClient();
  }
  return instance;
}

/** Terminate the current worker and clear the singleton, forcing recreation on next use. */
export function resetMupdfClient(): void {
  if (instance) {
    instance.destroy();
    instance = null;
  } else {
    clientRevision++;
  }
}

/** Release document leases, then the worker's WASM memory on project close. */
export async function closeMupdfClient(): Promise<void> {
  const client = instance;
  if (!client) return;
  // A new project can open while the old worker finishes releasing its files.
  instance = null;
  clientRevision++;
  try {
    await client.resetDocuments();
  } finally {
    client.destroy();
  }
}
