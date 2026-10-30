import { describe, expect, it } from "vitest";
import { ServiceOutput } from "./service-output";

describe("native binary framing", () => {
  it.each([
    1, 7, 4096,
  ])("preserves every byte with %i-byte chunks and adjacent events", (chunkSize) => {
    const bytes = Buffer.from(
      Array.from({ length: 65536 }, (_, index) => index % 256),
    );
    const event = { event: "__channel:12", payload: [{ message: "中文" }] };
    const input = Buffer.concat([
      Buffer.from(`${JSON.stringify(event)}\n`),
      Buffer.from(`${JSON.stringify({ id: 3, binaryLength: bytes.length })}\n`),
      bytes,
      Buffer.from(`${JSON.stringify({ id: 4, result: "done" })}\n`),
    ]);
    const messages: unknown[] = [];
    const parser = new ServiceOutput((message) => messages.push(message));
    for (let offset = 0; offset < input.length; offset += chunkSize)
      parser.push(input.subarray(offset, offset + chunkSize));
    expect(messages).toEqual([
      event,
      { id: 3, result: bytes },
      { id: 4, result: "done" },
    ]);
  });
  it("does not publish an incomplete binary response", () => {
    const messages: unknown[] = [];
    const parser = new ServiceOutput((message) => messages.push(message));
    parser.push(Buffer.from('{"id":1,"binaryLength":3}\nAB'));
    expect(messages).toEqual([]);
    parser.push(Buffer.from('C{"id":2,"binaryLength":0}\n'));
    expect(messages).toEqual([
      { id: 1, result: Buffer.from("ABC") },
      { id: 2, result: Buffer.alloc(0) },
    ]);
  });
  it.each([
    -1,
    1.5,
    "3",
    Number.MAX_SAFE_INTEGER + 1,
  ])("rejects invalid binary lengths %s", (binaryLength) => {
    const parser = new ServiceOutput(() => {});
    expect(() =>
      parser.push(Buffer.from(`${JSON.stringify({ id: 1, binaryLength })}\n`)),
    ).toThrow();
  });
});
