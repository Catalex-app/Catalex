/** Bounded native fallback: one request running and one replaceable pending value. */
export class CoalescedScrollTask<T> {
  private pending: { value: T } | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private lastStart = Number.NEGATIVE_INFINITY;

  constructor(
    private run: (value: T) => Promise<unknown>,
    private interval = 120,
  ) {}

  push(value: T) {
    this.pending = { value };
    this.schedule();
  }

  clear() {
    this.pending = null;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule() {
    if (this.running || this.timer !== null || !this.pending) return;
    const wait = Math.max(
      0,
      this.interval - (performance.now() - this.lastStart),
    );
    this.timer = setTimeout(() => {
      this.timer = null;
      const request = this.pending;
      if (!request) return;
      this.pending = null;
      this.running = true;
      this.lastStart = performance.now();
      void this.run(request.value)
        .catch(() => {})
        .finally(() => {
          this.running = false;
          this.schedule();
        });
    }, wait);
  }
}
