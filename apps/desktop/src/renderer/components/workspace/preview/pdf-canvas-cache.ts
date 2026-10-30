export const PDF_CANVAS_BUDGET_BYTES = 128 * 1024 * 1024;

/** Per-viewer pixel budget. Visible/nearby pages may exceed it; old pages may not. */
export class PdfCanvasCache {
  private entries = new Map<
    HTMLCanvasElement,
    { bytes: number; protected: () => boolean; release: () => void }
  >();
  private bytes = 0;

  constructor(private readonly budget = PDF_CANVAS_BUDGET_BYTES) {}

  store(
    canvas: HTMLCanvasElement,
    protectedPage: () => boolean,
    release: () => void,
  ) {
    this.bytes -= this.entries.get(canvas)?.bytes ?? 0;
    this.entries.delete(canvas);
    const bytes = canvas.width * canvas.height * 4;
    this.entries.set(canvas, { bytes, protected: protectedPage, release });
    this.bytes += bytes;
    this.trim();
  }

  touch(canvas: HTMLCanvasElement) {
    const entry = this.entries.get(canvas);
    if (!entry) return;
    this.entries.delete(canvas);
    this.entries.set(canvas, entry);
  }

  remove(canvas: HTMLCanvasElement) {
    const entry = this.entries.get(canvas);
    if (!entry) return;
    this.entries.delete(canvas);
    this.bytes -= entry.bytes;
    entry.release();
  }

  trim() {
    for (const [canvas, entry] of this.entries) {
      if (this.bytes <= this.budget) break;
      if (!entry.protected()) this.remove(canvas);
    }
  }
}
