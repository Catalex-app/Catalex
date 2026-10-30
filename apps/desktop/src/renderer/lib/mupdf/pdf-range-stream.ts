/** MuPDF's stream callbacks are synchronous. This adapter runs only in its
 * worker, with bounded block reuse and no full-file buffer allocation. */
export class PdfRangeReader {
  private blocks = new Map<number, Uint8Array>();
  private cachedBytes = 0;
  constructor(
    private size: number,
    private fetchRange: (position: number, length: number) => Uint8Array,
    private blockSize = 128 * 1024,
    private budget = 2 * 1024 * 1024,
  ) {}
  fileSize() {
    return this.size;
  }
  read(memory: Uint8Array, offset: number, length: number, position: number) {
    if (!Number.isSafeInteger(position) || position < 0)
      throw new Error("Invalid PDF position");
    const count = Math.max(0, Math.min(length, this.size - position));
    let copied = 0;
    while (copied < count) {
      const start =
        Math.floor((position + copied) / this.blockSize) * this.blockSize;
      let block = this.blocks.get(start);
      if (block) this.blocks.delete(start);
      else {
        const wanted = Math.min(this.blockSize, this.size - start);
        block = this.fetchRange(start, wanted);
        if (block.length !== wanted) throw new Error("Incomplete PDF range");
        this.cachedBytes += block.byteLength;
      }
      this.blocks.set(start, block);
      const within = position + copied - start;
      const take = Math.min(count - copied, block.length - within);
      memory.set(block.subarray(within, within + take), offset + copied);
      copied += take;
      while (this.cachedBytes > this.budget && this.blocks.size) {
        const oldest = this.blocks.keys().next().value!;
        this.cachedBytes -= this.blocks.get(oldest)!.byteLength;
        this.blocks.delete(oldest);
      }
    }
    return count;
  }
  close() {
    this.blocks.clear();
    this.cachedBytes = 0;
  }
}
