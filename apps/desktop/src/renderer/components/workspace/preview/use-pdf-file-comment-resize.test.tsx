import { StrictMode, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PdfSource } from "@/lib/mupdf/pdf-source";
import type { StructuredTextData } from "@/lib/mupdf/types";
import type { PdfCommentTarget } from "./pdf-comments";
import { usePdfFileCommentResize } from "./use-pdf-file-comment-resize";

const mocks = vi.hoisted(() => ({
  getOrOpenDocument: vi.fn(),
  getPageText: vi.fn(),
}));
vi.mock("@/lib/mupdf/pdf-doc-cache", () => ({
  getOrOpenDocument: mocks.getOrOpenDocument,
}));
vi.mock("@/lib/mupdf/mupdf-client", () => ({
  getMupdfClient: () => ({ getPageText: mocks.getPageText }),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function pageText(text = "alpha beta gamma"): StructuredTextData {
  return {
    blocks: [
      {
        type: "text",
        bbox: { x: 0, y: 0, w: text.length, h: 10 },
        lines: [
          {
            text,
            bbox: { x: 0, y: 0, w: text.length, h: 10 },
            wmode: 0,
            x: 0,
            y: 10,
            font: {
              name: "test",
              family: "serif",
              size: 10,
              weight: "normal",
              style: "normal",
            },
            chars: Array.from(text, (c, x) => ({
              c,
              origin: { x, y: 10 },
              quad: [x, 0, x + 1, 0, x, 10, x + 1, 10],
            })),
          },
        ],
      },
    ],
  };
}

function target(page = 1): PdfCommentTarget {
  return {
    filePath: "paper.pdf",
    comment: {
      id: `comment-${page}`,
      from: 0,
      to: 0,
      line: page,
      text: "Check this",
      pdf: {
        fingerprint: "a".repeat(40),
        text: "beta",
        regions: [{ page, x: 6, y: 0, width: 4, height: 10 }],
      },
    },
    firstLine: page,
    lastLine: page,
    sourceText: "beta",
    sourceBefore: "",
    sourceAfter: "",
  };
}

describe("PDF comment resize resource lifetime", () => {
  let root: Root;
  let state: ReturnType<typeof usePdfFileCommentResize>;
  const source = new Uint8Array([1]);
  const resize = vi.fn();

  function Probe({
    selected,
    data,
  }: {
    selected: PdfCommentTarget | null;
    data: PdfSource;
  }) {
    state = usePdfFileCommentResize(data, selected, resize);
    return null;
  }

  async function render(
    selected: PdfCommentTarget | null,
    data: PdfSource = source,
  ) {
    await act(async () => {
      root.render(<Probe selected={selected} data={data} />);
    });
  }

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.clearAllMocks();
    mocks.getOrOpenDocument.mockResolvedValue({ docId: 1 });
    mocks.getPageText.mockResolvedValue(pageText());
    root = createRoot(document.createElement("div"));
  });
  afterEach(() => {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  });

  it("releases preparation and completed-drag geometry while keeping handles usable", async () => {
    const selected = target();
    await render(selected);
    expect(state.ready).toBe(true);
    expect(mocks.getPageText).toHaveBeenCalledTimes(1);
    await act(async () => {
      state.start(selected, "from", 1);
      state.move({ page: 1, offset: 2 });
    });
    expect(mocks.getPageText).toHaveBeenCalledTimes(2);
    expect(state.preview?.anchor.text).toBe("pha beta");
    await act(async () => state.finish(true));
    expect(resize).toHaveBeenCalledWith(
      selected,
      expect.objectContaining({ text: "pha beta" }),
    );
    expect(state.preview).toBeNull();
    expect(state.ready).toBe(true);
    await act(async () => {
      state.start(selected, "from", 1);
      state.move({ page: 1, offset: 3 });
    });
    expect(mocks.getPageText).toHaveBeenCalledTimes(3);
    expect(state.preview?.anchor.text).toBe("ha beta");
    act(() => state.finish(false));
    expect(resize).toHaveBeenCalledTimes(1);
  });

  it("does not reuse geometry after dismissal, deletion or a source change", async () => {
    const selected = target();
    await render(selected);
    await render(null);
    expect(state.ready).toBe(false);
    await render(selected);
    expect(mocks.getPageText).toHaveBeenCalledTimes(2);
    await render(null);
    await render(target(2));
    expect(mocks.getPageText).toHaveBeenLastCalledWith(1, 1);
    await render(selected, new Uint8Array([2]));
    expect(mocks.getPageText).toHaveBeenCalledTimes(4);
    expect(state.ready).toBe(true);
  });

  it("discards cancelled drag results without replacing newer pending reads", async () => {
    const selected = target();
    await render(selected);
    const old = deferred<StructuredTextData>();
    const current = deferred<StructuredTextData>();
    mocks.getPageText
      .mockReturnValueOnce(old.promise)
      .mockReturnValueOnce(current.promise);
    await act(async () => {
      state.start(selected, "from", 1);
      state.move({ page: 1, offset: 2 });
    });
    act(() => state.finish(false));
    await act(async () => {
      state.start(selected, "from", 1);
      state.move({ page: 1, offset: 2 });
    });
    await act(async () => old.resolve(pageText("outdated page")));
    await act(async () => state.move({ page: 1, offset: 3 }));
    expect(mocks.getPageText).toHaveBeenCalledTimes(3);
    expect(state.preview).toBeNull();
    await act(async () => current.resolve(pageText()));
    expect(state.preview?.anchor.text).toBe("ha beta");
  });

  it("stops dismissed preparations before requesting worker text", async () => {
    const opening = deferred<{ docId: number }>();
    mocks.getOrOpenDocument.mockReturnValue(opening.promise);
    await render(target());
    await render(null);
    await act(async () => opening.resolve({ docId: 1 }));
    expect(mocks.getPageText).not.toHaveBeenCalled();
    expect(state.ready).toBe(false);
  });

  it("keeps replacement handles valid when an older anchor finishes loading", async () => {
    const old = deferred<StructuredTextData>();
    const current = deferred<StructuredTextData>();
    mocks.getPageText
      .mockReturnValueOnce(old.promise)
      .mockReturnValueOnce(current.promise);
    await render(target());
    const replacement = target();
    replacement.comment.pdf = {
      ...replacement.comment.pdf!,
      text: "gamma",
      regions: [{ page: 1, x: 11, y: 0, width: 5, height: 10 }],
    };
    await render(replacement);
    await act(async () => current.resolve(pageText()));
    expect(state.ready).toBe(true);
    await act(async () => old.resolve(pageText("outdated page")));
    expect(state.ready).toBe(true);
    await act(async () => {
      state.start(replacement, "from", 1);
      state.move({ page: 1, offset: 6 });
    });
    expect(mocks.getPageText).toHaveBeenCalledTimes(3);
    expect(state.preview?.anchor.text).toBe("beta gamma");
  });

  it("prepares and resizes after the Strict Mode cleanup/setup cycle", async () => {
    const selected = target();
    await act(async () =>
      root.render(
        <StrictMode>
          <Probe selected={selected} data={source} />
        </StrictMode>,
      ),
    );
    expect(state.ready).toBe(true);
    await act(async () => {
      state.start(selected, "from", 1);
      state.move({ page: 1, offset: 2 });
    });
    expect(state.preview?.anchor.text).toBe("pha beta");
  });
});
