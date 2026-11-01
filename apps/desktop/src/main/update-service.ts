import type { UpdateCheckResult, UpdateSnapshot } from "../update-types";

export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60_000;
export const UPDATE_RETRY_INTERVAL_MS = 60 * 60_000;

/** One scheduler and snapshot for the entire application, independent of windows. */
export class UpdateService {
  private snapshot: UpdateSnapshot = {
    revision: 0,
    status: "idle",
    update: null,
    checking: false,
  };
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pending: Promise<UpdateSnapshot> | undefined;
  private nextCheckAt = 0;
  private started = false;
  private stopped = false;

  constructor(
    private readonly fetchUpdate: () => Promise<UpdateCheckResult>,
    private readonly changed: (state: UpdateSnapshot) => void,
    private readonly now = () => Date.now(),
  ) {}

  getState(): UpdateSnapshot {
    return this.snapshot;
  }

  start() {
    if (this.started || this.stopped) return;
    this.started = true;
    void this.check();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  checkIfDue(): Promise<UpdateSnapshot> {
    if (!this.started || this.stopped) return Promise.resolve(this.snapshot);
    if (this.pending) return this.pending;
    if (this.now() >= this.nextCheckAt) return this.check();
    this.armTimer();
    return Promise.resolve(this.snapshot);
  }

  /** Explicit user checks bypass the schedule and join any in-flight check. */
  check(): Promise<UpdateSnapshot> {
    if (this.stopped) return Promise.resolve(this.snapshot);
    if (this.pending) return this.pending;
    clearTimeout(this.timer);
    this.publish({ ...this.snapshot, checking: true });
    this.pending = this.run().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  private async run(): Promise<UpdateSnapshot> {
    let interval = UPDATE_CHECK_INTERVAL_MS;
    try {
      const result = await this.fetchUpdate();
      if (this.stopped) return this.snapshot;
      if (result && "unavailable" in result) {
        interval = UPDATE_RETRY_INTERVAL_MS;
        this.publish({
          ...this.snapshot,
          status: "unavailable",
          message: result.message,
          checking: false,
        });
      } else {
        this.publish({
          ...this.snapshot,
          status: "ready",
          update: result,
          message: undefined,
          checking: false,
        });
      }
    } catch (error) {
      if (this.stopped) return this.snapshot;
      interval = UPDATE_RETRY_INTERVAL_MS;
      this.publish({
        ...this.snapshot,
        status: "error",
        message: error instanceof Error ? error.message : String(error),
        checking: false,
      });
    } finally {
      if (!this.stopped) {
        this.nextCheckAt = this.now() + interval;
        if (this.started) this.armTimer();
      }
    }
    return this.snapshot;
  }

  private publish(state: UpdateSnapshot) {
    this.snapshot = { ...state, revision: this.snapshot.revision + 1 };
    this.changed(this.snapshot);
  }

  private armTimer() {
    clearTimeout(this.timer);
    this.timer = setTimeout(
      () => {
        void this.checkIfDue();
      },
      Math.max(1, this.nextCheckAt - this.now()),
    );
    this.timer.unref?.();
  }
}
