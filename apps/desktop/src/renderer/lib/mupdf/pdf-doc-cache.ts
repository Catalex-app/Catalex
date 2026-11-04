import { pdfOpenArgument, type PdfSource } from "./pdf-source";
import {
  getMupdfClient,
  getMupdfClientRevision,
  closeMupdfClient,
} from "./mupdf-client";
import { createLogger } from "@/lib/debug/logger";
import type { PageSize } from "./types";

const log = createLogger("pdf-doc-cache");

interface CachedDoc {
  source: PdfSource;
  docId: number;
  pageSizes: PageSize[];
  lastAccess: number;
}

const MAX_OPEN_DOCS = 5;
const cache = new Map<string, CachedDoc>();
let cacheRevision = getMupdfClientRevision();
let generation = 0;
const opening = new Map<string, Promise<DocCacheResult>>();

function clearStaleCache(): void {
  const revision = getMupdfClientRevision();
  if (cacheRevision === revision) return;

  const count = cache.size;
  cache.clear();
  opening.clear();
  generation++;
  cacheRevision = revision;
  if (count > 0) {
    log.warn(`Dropped ${count} cached MuPDF documents after worker reset`);
  }
}

/** Create a fast fingerprint from PDF bytes (length + sampled bytes). */
function computeFingerprint(data: PdfSource): string {
  if (!ArrayBuffer.isView(data)) return `file:${data.id}`;
  const len = data.length;
  if (len < 16) return `${len}:${Array.from(data).join(",")}`;
  // Sample: length + first 8 bytes + middle 8 bytes + last 8 bytes
  const first = Array.from(data.subarray(0, 8));
  const mid = Array.from(
    data.subarray(Math.floor(len / 2) - 4, Math.floor(len / 2) + 4),
  );
  const last = Array.from(data.subarray(len - 8));
  return `${len}:${first.join(",")}|${mid.join(",")}|${last.join(",")}`;
}

async function evictOldest(): Promise<void> {
  if (cache.size < MAX_OPEN_DOCS) return;

  let oldestKey: string | null = null;
  let oldestAccess = Infinity;
  for (const [key, entry] of cache) {
    if (entry.lastAccess < oldestAccess) {
      oldestAccess = entry.lastAccess;
      oldestKey = key;
    }
  }
  if (oldestKey) {
    const entry = cache.get(oldestKey)!;
    cache.delete(oldestKey);
    log.debug(`Evicted doc ${entry.docId} (cache size was ${cache.size + 1})`);
    await getMupdfClient()
      .closeDocument(entry.docId)
      .catch(() => {});
  }
}

export interface DocCacheResult {
  docId: number;
  pageSizes: PageSize[];
  cacheHit: boolean;
}

/**
 * Synchronous cache lookup — returns the cached result if the PDF is already open,
 * or null on cache miss. Use this to skip the async path on file switch.
 */
export function getCachedDocument(data: PdfSource): DocCacheResult | null {
  clearStaleCache();
  const fingerprint = computeFingerprint(data);
  const cached = cache.get(fingerprint);
  if (cached) {
    cached.lastAccess = Date.now();
    return { docId: cached.docId, pageSizes: cached.pageSizes, cacheHit: true };
  }
  return null;
}

/**
 * Get or open a MuPDF document, using the LRU cache.
 * Returns the docId and pageSizes. If the same PDF bytes were already open,
 * reuses the existing document (cache hit).
 */
export async function getOrOpenDocument(
  data: PdfSource,
): Promise<DocCacheResult> {
  clearStaleCache();
  // Reuse synchronous lookup to avoid duplicating fingerprint + cache logic
  const hit = getCachedDocument(data);
  if (hit) return hit;

  const fingerprint = computeFingerprint(data);
  const pending = opening.get(fingerprint);
  if (pending) return pending;
  const epoch = generation;
  const client = getMupdfClient();
  const revision = getMupdfClientRevision();
  cacheRevision = revision;
  const operation = (async () => {
    await evictOldest();
    if (epoch !== generation)
      throw Object.assign(new Error("Superseded PDF work"), {
        name: "AbortError",
      });
    const docId = await client.openDocument(pdfOpenArgument(data));
    try {
      const sizes = await client.getAllPageSizes(docId);
      if (epoch !== generation || revision !== getMupdfClientRevision())
        throw Object.assign(new Error("Superseded PDF work"), {
          name: "AbortError",
        });
      cacheRevision = revision;
      cache.set(fingerprint, {
        source: data,
        docId,
        pageSizes: sizes,
        lastAccess: Date.now(),
      });
      return { docId, pageSizes: sizes, cacheHit: false };
    } catch (error) {
      void client.closeDocument(docId).catch(() => {});
      throw error;
    }
  })();
  opening.set(fingerprint, operation);
  try {
    return await operation;
  } finally {
    if (opening.get(fingerprint) === operation) opening.delete(fingerprint);
  }
}

/** Close and remove a specific document from cache by docId. */
export function invalidateDoc(docId: number): void {
  clearStaleCache();
  for (const [key, entry] of cache) {
    if (entry.docId === docId) {
      cache.delete(key);
      getMupdfClient()
        .closeDocument(docId)
        .catch(() => {});
      return;
    }
  }
}

/** Abort stale render work before opening a newly compiled PDF revision. */
export function prepareForNewPdfRevision(): void {
  generation++;
  cache.clear();
  opening.clear();
  const client = getMupdfClient();
  cacheRevision = getMupdfClientRevision();
  void client.resetDocuments().catch((error) => {
    if (error?.name !== "AbortError")
      log.warn("PDF document reset failed", { error: String(error) });
  });
}

/** Close all cached documents (e.g., on project close). */
export async function clearDocCache(): Promise<void> {
  clearStaleCache();
  generation++;
  opening.clear();
  const count = cache.size;
  cache.clear();
  // Destroying documents alone leaves the worker's WASM heap allocated.
  // Close every document (including historical viewers), then terminate it.
  await closeMupdfClient().catch(() => {});
  log.info(`Cleared doc cache (${count} documents closed)`);
}
