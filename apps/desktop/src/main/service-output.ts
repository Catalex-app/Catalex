/** Incremental native stdout framing. JSON events/replies remain line-delimited;
 * a binary reply header is followed by exactly binaryLength bytes. */
export class ServiceOutput {
  private header: Buffer[] = [];
  private body: { id: number; bytes: Buffer; offset: number } | null = null;

  constructor(private readonly receive: (message: any) => void) {}

  push(chunk: Buffer): void {
    let offset = 0;
    while (offset < chunk.length) {
      if (this.body) {
        const body = this.body;
        const length = Math.min(
          body.bytes.length - body.offset,
          chunk.length - offset,
        );
        chunk.copy(body.bytes, body.offset, offset, offset + length);
        body.offset += length;
        offset += length;
        if (body.offset === body.bytes.length) {
          this.body = null;
          this.receive({ id: body.id, result: body.bytes });
        }
        continue;
      }
      const newline = chunk.indexOf(10, offset);
      if (newline < 0) {
        this.header.push(chunk.subarray(offset));
        return;
      }
      this.header.push(chunk.subarray(offset, newline));
      const message = JSON.parse(Buffer.concat(this.header).toString("utf8"));
      this.header = [];
      offset = newline + 1;
      if (message && typeof message === "object" && "binaryLength" in message) {
        if (
          !Number.isSafeInteger(message.id) ||
          !Number.isSafeInteger(message.binaryLength) ||
          message.binaryLength < 0 ||
          "result" in message ||
          "error" in message
        )
          throw new Error("Invalid binary response");
        const bytes = Buffer.allocUnsafe(message.binaryLength);
        if (bytes.length === 0) this.receive({ id: message.id, result: bytes });
        else this.body = { id: message.id, bytes, offset: 0 };
      } else this.receive(message);
    }
  }
}
