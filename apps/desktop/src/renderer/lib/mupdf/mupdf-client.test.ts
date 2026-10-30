import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getMupdfClient,
  resetMupdfClient,
  getMupdfClientRevision,
} from "@/lib/mupdf/mupdf-client";
import {
  prepareForNewPdfRevision,
  getCachedDocument,
  getOrOpenDocument,
  clearDocCache,
} from "@/lib/mupdf/pdf-doc-cache";

class TestWorker {
  static instances: TestWorker[] = [];

  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  messages: unknown[] = [];
  terminated = false;

  constructor() {
    TestWorker.instances.push(this);
  }

  postMessage(message: unknown): void {
    this.messages.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  init(): void {
    this.onmessage?.({ data: ["INIT", 0, []] } as MessageEvent);
  }

  resolveMessage(index: number, payload: unknown): void {
    const message = this.messages[index] as [string, number, unknown[]];
    this.onmessage?.({ data: ["RESULT", message[1], payload] } as MessageEvent);
  }

  fail(message: string): void {
    this.onerror?.({ message } as ErrorEvent);
  }

  static latest(): TestWorker {
    const worker = TestWorker.instances[TestWorker.instances.length - 1];
    if (!worker) throw new Error("Expected a worker instance");
    return worker;
  }
}

async function waitForMessages(
  worker: TestWorker,
  count: number,
): Promise<void> {
  for (let i = 0; i < 20; i++) {
    if (worker.messages.length >= count) return;
    await Promise.resolve();
  }
  throw new Error(`Expected ${count} worker messages`);
}

async function waitForWorker(): Promise<TestWorker> {
  for (let i = 0; i < 20; i++) {
    const worker = TestWorker.instances[TestWorker.instances.length - 1];
    if (worker) return worker;
    await Promise.resolve();
  }
  throw new Error("Expected a worker instance");
}

describe("mupdf client worker lifecycle", () => {
  beforeEach(() => {
    vi.stubGlobal("Worker", TestWorker);
    resetMupdfClient();
    TestWorker.instances = [];
  });

  afterEach(() => {
    resetMupdfClient();
    vi.unstubAllGlobals();
  });

  it("rejects callers when the worker fails before INIT", async () => {
    const client = getMupdfClient();
    const countPages = client.countPages(1);

    const worker = TestWorker.latest();
    worker.fail("init exploded");

    await expect(countPages).rejects.toThrow(
      "MuPDF worker failed: init exploded",
    );
    expect(worker.terminated).toBe(true);
    expect(getMupdfClient()).not.toBe(client);
  });

  it("releases the old worker on project close without invalidating a new project", async () => {
    const first = getOrOpenDocument(new Uint8Array([1, 4, 9]));
    const oldWorker = await waitForWorker();
    oldWorker.init();
    await waitForMessages(oldWorker, 1);
    oldWorker.resolveMessage(0, 8);
    await waitForMessages(oldWorker, 2);
    oldWorker.resolveMessage(1, [{ width: 100, height: 200 }]);
    await first;
    const close = clearDocCache();
    await waitForMessages(oldWorker, 3);
    expect((oldWorker.messages[2] as unknown[])[0]).toBe("resetDocuments");
    expect(oldWorker.terminated).toBe(false);
    const freshData = new Uint8Array([2, 4, 6]);
    const fresh = getOrOpenDocument(freshData);
    const worker = await waitForWorker();
    expect(worker).not.toBe(oldWorker);
    worker.init();
    await waitForMessages(worker, 1);
    worker.resolveMessage(0, 1);
    await waitForMessages(worker, 2);
    worker.resolveMessage(1, [{ width: 100, height: 200 }]);
    await fresh;
    const revision = getMupdfClientRevision();
    oldWorker.resolveMessage(2, null);
    await close;
    expect(oldWorker.terminated).toBe(true);
    expect(worker.terminated).toBe(false);
    expect(getMupdfClientRevision()).toBe(revision);
    expect(getCachedDocument(freshData)?.docId).toBe(1);
  });

  it("does not start a worker just to close an unused project", async () => {
    await clearDocCache();
    expect(TestWorker.instances).toHaveLength(0);
  });

  it("rejects pending calls after runtime failure and recreates a fresh worker", async () => {
    const client = getMupdfClient();
    const worker = TestWorker.latest();
    worker.init();

    const pendingCall = client.countPages(5);
    await waitForMessages(worker, 1);

    worker.fail("runtime exploded");

    await expect(pendingCall).rejects.toThrow(
      "MuPDF worker failed: runtime exploded",
    );
    expect(worker.terminated).toBe(true);

    const freshClient = getMupdfClient();
    const freshWorker = TestWorker.latest();
    expect(freshClient).not.toBe(client);
    expect(freshWorker).not.toBe(worker);

    freshWorker.init();
    const countPages = freshClient.countPages(5);
    await waitForMessages(freshWorker, 1);
    freshWorker.resolveMessage(0, 12);

    await expect(countPages).resolves.toBe(12);
  });

  it("discards obsolete queued rendering while keeping the worker alive", async () => {
    const client = getMupdfClient();
    const worker = TestWorker.latest();
    worker.init();
    const first = client.drawPage(1, 0, 72).catch((error) => error.name);
    const second = client.drawPage(1, 1, 72).catch((error) => error.name);
    await waitForMessages(worker, 1);
    expect(worker.messages).toHaveLength(1);
    const reset = client.resetDocuments();
    const opened = client.openDocument(new ArrayBuffer(4));
    expect(await first).toBe("AbortError");
    expect(await second).toBe("AbortError");
    worker.resolveMessage(0, null);
    await waitForMessages(worker, 2);
    expect((worker.messages[1] as unknown[])[0]).toBe("resetDocuments");
    worker.resolveMessage(1, null);
    await reset;
    await waitForMessages(worker, 3);
    expect((worker.messages[2] as unknown[])[0]).toBe("openDocument");
    worker.resolveMessage(2, 2);
    expect(await opened).toBe(2);
    expect(worker.terminated).toBe(false);
    expect(getMupdfClient()).toBe(client);
  });

  it("still terminates a stuck active job after its callers are cancelled", async () => {
    vi.useFakeTimers();
    try {
      const client = getMupdfClient();
      const worker = TestWorker.latest();
      worker.init();
      const drawing = client.drawPage(1, 0, 72).catch((error) => error.name);
      await waitForMessages(worker, 1);
      const reset = client.resetDocuments().catch((error) => error.message);
      expect(await drawing).toBe("AbortError");
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await reset).toContain("timed out");
      expect(worker.terminated).toBe(true);
      expect(getMupdfClient()).not.toBe(client);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not let an old document open repopulate the cache after a refresh", async () => {
    const data = new Uint8Array([6, 5, 4]);
    const old = getOrOpenDocument(data).catch((error) => error.name);
    const worker = await waitForWorker();
    worker.init();
    await waitForMessages(worker, 1);
    prepareForNewPdfRevision();
    const fresh = getOrOpenDocument(data);
    expect(await old).toBe("AbortError");
    worker.resolveMessage(0, 40);
    await waitForMessages(worker, 2);
    worker.resolveMessage(1, null);
    await waitForMessages(worker, 3);
    worker.resolveMessage(2, 41);
    await waitForMessages(worker, 4);
    worker.resolveMessage(3, [{ width: 100, height: 200 }]);
    expect((await fresh).docId).toBe(41);
    expect(getCachedDocument(data)?.docId).toBe(41);
  });

  it("shares concurrent document opens", async () => {
    const data = new Uint8Array([8, 7, 6, 5]);
    const first = getOrOpenDocument(data);
    const second = getOrOpenDocument(data);
    const worker = await waitForWorker();
    worker.init();
    await waitForMessages(worker, 1);
    worker.resolveMessage(0, 21);
    await waitForMessages(worker, 2);
    worker.resolveMessage(1, [{ width: 100, height: 100 }]);
    expect(await first).toEqual(await second);
    expect(worker.messages).toHaveLength(2);
  });

  it("drops cancelled detail jobs without sending them to the worker", async () => {
    const client = getMupdfClient();
    const worker = TestWorker.latest();
    worker.init();
    const base = client.drawPage(1, 0, 72);
    const controller = new AbortController();
    const region = { x: 100, y: 100, width: 100, height: 100, scale: 24 };
    const detail = client
      .drawPageRegion(1, 0, region, controller.signal)
      .catch((error) => error.name);
    await waitForMessages(worker, 1);
    controller.abort();
    expect(await detail).toBe("AbortError");
    const next = client.countPages(1);
    worker.resolveMessage(0, null);
    await base;
    await waitForMessages(worker, 2);
    expect((worker.messages[1] as unknown[])[0]).toBe("countPages");
    worker.resolveMessage(1, 1);
    expect(await next).toBe(1);
  });

  it("waits for an executing cancelled detail job before starting the next worker job", async () => {
    const client = getMupdfClient();
    const worker = TestWorker.latest();
    worker.init();
    const controller = new AbortController();
    const detail = client
      .drawPageRegion(
        1,
        0,
        { x: 0, y: 0, width: 10, height: 10, scale: 24 },
        controller.signal,
      )
      .catch((error) => error.name);
    await waitForMessages(worker, 1);
    controller.abort();
    expect(await detail).toBe("AbortError");
    const next = client.countPages(1);
    await Promise.resolve();
    expect(worker.messages).toHaveLength(1);
    worker.resolveMessage(0, null);
    await waitForMessages(worker, 2);
    worker.resolveMessage(1, 1);
    expect(await next).toBe(1);
    expect(worker.terminated).toBe(false);
  });

  it("releases pixels from a render cancelled while executing", async () => {
    class TestImageBitmap {
      close = vi.fn();
    }
    vi.stubGlobal("ImageBitmap", TestImageBitmap);
    const client = getMupdfClient();
    const worker = TestWorker.latest();
    worker.init();
    const controller = new AbortController();
    const render = client
      .drawPage(1, 0, 72, controller.signal)
      .catch((error) => error.name);
    await waitForMessages(worker, 1);
    controller.abort();
    expect(await render).toBe("AbortError");
    const pixels = new TestImageBitmap();
    worker.resolveMessage(0, pixels);
    expect(pixels.close).toHaveBeenCalledOnce();
  });

  it("drops cached document IDs after worker reset", async () => {
    const pdfData = new Uint8Array([1, 2, 3, 4]);
    const opened = getOrOpenDocument(pdfData);

    const worker = await waitForWorker();
    worker.init();
    await waitForMessages(worker, 1);
    worker.resolveMessage(0, 7);
    await waitForMessages(worker, 2);
    worker.resolveMessage(1, [{ width: 100, height: 200 }]);

    await expect(opened).resolves.toEqual({
      docId: 7,
      pageSizes: [{ width: 100, height: 200 }],
      cacheHit: false,
    });
    expect(getCachedDocument(pdfData)?.docId).toBe(7);

    resetMupdfClient();

    expect(getCachedDocument(pdfData)).toBeNull();
  });

  it("removes obsolete whole-page zooms and sends only the latest queued render", async () => {
    const client = getMupdfClient();
    const worker = TestWorker.latest();
    worker.init();
    const running = new AbortController();
    const first = client
      .drawPage(1, 0, 72, running.signal)
      .catch((error) => error.name);
    await waitForMessages(worker, 1);
    running.abort();
    expect(await first).toBe("AbortError");
    for (let dpi = 80; dpi < 100; dpi++) {
      const controller = new AbortController();
      const obsolete = client
        .drawPage(1, 0, dpi, controller.signal)
        .catch((error) => error.name);
      await Promise.resolve();
      controller.abort();
      expect(await obsolete).toBe("AbortError");
    }
    const latest = client.drawPage(1, 0, 100);
    await Promise.resolve();
    expect(worker.messages).toHaveLength(1);
    worker.resolveMessage(0, null);
    await waitForMessages(worker, 2);
    expect((worker.messages[1] as unknown[])[2]).toEqual([1, 0, 100]);
    worker.resolveMessage(1, "latest pixels");
    expect(await latest).toBe("latest pixels");
    expect(worker.terminated).toBe(false);
  });

  it("does not enqueue whole-page renders aborted before worker initialization", async () => {
    const client = getMupdfClient();
    const controller = new AbortController();
    const render = client
      .drawPage(1, 0, 72, controller.signal)
      .catch((error) => error.name);
    controller.abort();
    expect(await render).toBe("AbortError");
    await expect(
      client.drawPage(1, 0, 72, controller.signal),
    ).rejects.toHaveProperty("name", "AbortError");
    const worker = TestWorker.latest();
    worker.init();
    await Promise.resolve();
    expect(worker.messages).toHaveLength(0);
  });
});
