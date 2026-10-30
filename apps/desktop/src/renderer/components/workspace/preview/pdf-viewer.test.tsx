import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PdfViewer } from "./pdf-viewer";

const mocks = vi.hoisted(() => ({
  client: {
    openDocument: vi.fn(),
    closeDocument: vi.fn(),
    getAllPageSizes: vi.fn(),
  },
  getMupdfClientRevision: vi.fn(() => 1),
  getCachedDocument: vi.fn(),
  getOrOpenDocument: vi.fn(),
}));
vi.mock("@/lib/mupdf/mupdf-client", () => ({
  getMupdfClient: () => mocks.client,
  getMupdfClientRevision: mocks.getMupdfClientRevision,
}));
vi.mock("@/lib/mupdf/pdf-doc-cache", () => ({
  getCachedDocument: mocks.getCachedDocument,
  getOrOpenDocument: mocks.getOrOpenDocument,
}));
vi.mock("./mupdf-page", () => ({
  MupdfPage: ({ docId }: { docId: number }) => <div data-document={docId} />,
}));
vi.mock("./pdf-selection-highlight", () => ({
  PdfSelectionHighlight: () => null,
}));
vi.mock("./pdf-selection-drag", () => ({ usePdfSelectionDrag: () => {} }));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const bytes = new TextEncoder().encode("%PDF-1.7 snapshot");
const sizes = [{ width: 612, height: 792 }];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("historical PDF document ownership", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getMupdfClientRevision.mockReturnValue(1);
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    mocks.client.openDocument.mockResolvedValue(11);
    mocks.client.getAllPageSizes.mockResolvedValue(sizes);
    mocks.client.closeDocument.mockResolvedValue(undefined);
    mocks.getCachedDocument.mockReturnValue(null);
    mocks.getOrOpenDocument.mockResolvedValue({ docId: 99, pageSizes: sizes });
    container = document.body.appendChild(document.createElement("div"));
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  async function render(data = bytes, revision = 0, isolated = true) {
    await act(async () => {
      root.render(
        <PdfViewer
          dataSource={{ kind: "standalone", data }}
          scale={1}
          isolatedSelection={isolated}
          documentReloadRevision={revision}
        />,
      );
    });
  }

  it("opens copied bytes outside the live LRU and closes replaced and unmounted documents", async () => {
    await render();
    expect(mocks.getCachedDocument).not.toHaveBeenCalled();
    expect(mocks.getOrOpenDocument).not.toHaveBeenCalled();
    const buffer = mocks.client.openDocument.mock.calls[0][0];
    expect(Array.from(new Uint8Array(buffer))).toEqual(Array.from(bytes));
    expect(buffer).not.toBe(bytes.buffer);
    expect(
      container.querySelector("[data-document]")?.getAttribute("data-document"),
    ).toBe("11");

    mocks.client.openDocument.mockResolvedValueOnce(12);
    await render(new TextEncoder().encode("%PDF-1.7 second"));
    expect(mocks.client.closeDocument.mock.calls).toEqual([[11]]);
    await act(async () => {
      root.unmount();
    });
    expect(mocks.client.closeDocument.mock.calls).toEqual([[11], [12]]);
  });

  it("closes a document whose open resolves after the viewer unmounts", async () => {
    const opened = deferred<number>();
    mocks.client.openDocument.mockReturnValueOnce(opened.promise);
    await render();
    await act(async () => {
      root.unmount();
    });
    expect(mocks.client.closeDocument).not.toHaveBeenCalled();
    await act(async () => {
      opened.resolve(21);
    });
    expect(mocks.client.closeDocument).toHaveBeenCalledExactlyOnceWith(21);
    expect(mocks.client.getAllPageSizes).not.toHaveBeenCalled();
  });

  it("closes once when page metadata completes after a snapshot switch", async () => {
    const pages = deferred<typeof sizes>();
    mocks.client.getAllPageSizes.mockReturnValueOnce(pages.promise);
    await render();
    mocks.client.openDocument.mockResolvedValueOnce(22);
    await render(new TextEncoder().encode("%PDF-1.7 next"));
    expect(mocks.client.closeDocument).toHaveBeenCalledExactlyOnceWith(11);
    await act(async () => {
      pages.resolve(sizes);
    });
    expect(
      container.querySelector("[data-document]")?.getAttribute("data-document"),
    ).toBe("22");
    expect(mocks.client.closeDocument).toHaveBeenCalledExactlyOnceWith(11);
  });

  it("reopens historical bytes when a live compile resets the worker", async () => {
    await render();
    mocks.client.openDocument.mockResolvedValueOnce(31);
    await render(bytes, 1);
    expect(mocks.client.closeDocument).toHaveBeenCalledExactlyOnceWith(11);
    expect(mocks.client.openDocument).toHaveBeenCalledTimes(2);
    expect(
      container.querySelector("[data-document]")?.getAttribute("data-document"),
    ).toBe("31");
  });

  it("closes owned documents when page metadata fails", async () => {
    mocks.client.getAllPageSizes.mockRejectedValueOnce(
      new Error("Unreadable PDF"),
    );
    await render();
    expect(mocks.client.closeDocument).toHaveBeenCalledExactlyOnceWith(11);
    expect(container.querySelector("[data-document]")).toBeNull();
  });

  it("leaves ordinary standalone viewers on the existing shared cache path", async () => {
    await render(bytes, 0, false);
    expect(mocks.getCachedDocument).toHaveBeenCalledWith(bytes);
    expect(mocks.getOrOpenDocument).toHaveBeenCalledWith(bytes);
    expect(mocks.client.openDocument).not.toHaveBeenCalled();
    await act(async () => {
      root.unmount();
    });
    expect(mocks.client.closeDocument).not.toHaveBeenCalled();
  });
  it.each([
    false,
    true,
  ])("remounts repeated document IDs only after reload (cache hit: %s)", async (cacheHit) => {
    await render(bytes, 0, false);
    const original = container.querySelector("[data-document]");
    expect(original).not.toBeNull();
    mocks.getMupdfClientRevision.mockReturnValue(2);
    // A global worker change alone must not remount the still-displayed document.
    await render(bytes, 0, false);
    expect(container.querySelector("[data-document]")).toBe(original);
    mocks.getOrOpenDocument.mockResolvedValue({
      docId: 99,
      pageSizes: [...sizes],
    });
    if (cacheHit)
      mocks.getCachedDocument.mockReturnValue({
        docId: 99,
        pageSizes: [...sizes],
      });
    await render(new TextEncoder().encode("%PDF-1.7 replaced"), 1, false);
    expect(container.querySelector("[data-document]")).not.toBe(original);
  });
});
