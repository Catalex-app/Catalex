import { describe, expect, it, vi } from "vitest";
import {
  getPdfViewerBytes,
  hasPdfViewerBytes,
  type PdfViewerDataSource,
} from "./pdf-data-source";

vi.mock("@/stores/document-store", () => ({
  getPdfBytes: vi.fn((rootFileId: string) =>
    rootFileId === "main.tex" ? new Uint8Array([1, 2, 3]) : undefined,
  ),
}));

describe("PDF viewer data source", () => {
  it("resolves compiled PDF bytes from the external cache by root id", () => {
    const source: PdfViewerDataSource = {
      kind: "compiled",
      rootFileId: "main.tex",
      revision: 4,
    };

    expect(getPdfViewerBytes(source)).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("uses a small compiled source descriptor instead of embedding PDF bytes", () => {
    const source: PdfViewerDataSource = {
      kind: "compiled",
      rootFileId: "main.tex",
      revision: 4,
    };

    const values = Object.values(source) as unknown[];
    expect(values.some((value) => value instanceof Uint8Array)).toBe(false);
    expect(JSON.stringify(source).length).toBeLessThan(80);
  });

  it("reports whether a source currently has bytes", () => {
    expect(
      hasPdfViewerBytes({
        kind: "compiled",
        rootFileId: "missing.tex",
        revision: 1,
      }),
    ).toBe(false);

    expect(
      hasPdfViewerBytes({
        kind: "standalone",
        data: new Uint8Array([4, 5]),
      }),
    ).toBe(true);
  });
});
