import { describe, expect, it, vi } from "vitest";
import { PdfRangeReader } from "./pdf-range-stream";

describe("PDF random access stream", () => {
  it("reads across blocks, seeks backwards, and returns EOF without fetching the full file", () => {
    const data = Uint8Array.from({ length: 100 }, (_, i) => i);
    const fetch = vi.fn((p: number, n: number) => data.slice(p, p + n));
    const reader = new PdfRangeReader(data.length, fetch, 8, 16);
    const memory = new Uint8Array(20);
    expect(reader.read(memory, 2, 12, 5)).toBe(12);
    expect(memory.slice(2, 14)).toEqual(data.slice(5, 17));
    expect(fetch.mock.calls).toEqual([
      [0, 8],
      [8, 8],
      [16, 8],
    ]);
    expect(reader.read(memory, 0, 4, 10)).toBe(4);
    expect(fetch).toHaveBeenCalledTimes(3);
    reader.read(memory, 0, 3, 0); // Evicted first block is fetched again.
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(reader.read(memory, 0, 10, 98)).toBe(2);
    expect(memory.slice(0, 2)).toEqual(data.slice(98));
    expect(reader.read(memory, 0, 10, 100)).toBe(0);
    reader.close();
    reader.read(memory, 0, 2, 98);
    expect(fetch).toHaveBeenLastCalledWith(96, 4);
  });
  it("rejects truncated reads instead of silently corrupting the PDF", () => {
    const reader = new PdfRangeReader(100, () => new Uint8Array(2), 8, 16);
    expect(() => reader.read(new Uint8Array(8), 0, 8, 0)).toThrow(
      "Incomplete PDF range",
    );
    expect(() => reader.read(new Uint8Array(8), 0, 8, -1)).toThrow(
      "Invalid PDF position",
    );
  });
});
