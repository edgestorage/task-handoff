type DecodeJob = { bytes: number; run(isCurrent: () => boolean): Promise<void> };

/** A local decoder capacity limit, not a transport bandwidth estimate. Keep
 * one native call in flight; invalidation drops pending compressed frames as
 * a group so the controller can resume at a fresh keyframe. */
export class RemoteDesktopDecodeQueue {
  private pending: DecodeJob[] = [];
  private active?: DecodeJob;
  private bytes = 0;
  private revision = 0;

  constructor(private readonly maxFrames = 8, private readonly maxBytes = 16 * 1024 * 1024) {}

  get size() { return this.pending.length + (this.active ? 1 : 0); }
  get bufferedBytes() { return this.bytes; }

  clear() {
    this.revision++;
    this.pending = [];
    this.bytes = this.active?.bytes ?? 0;
  }

  enqueue(job: DecodeJob) {
    if (this.size >= this.maxFrames || this.bytes + job.bytes > this.maxBytes) {
      this.clear();
      return false;
    }
    this.pending.push(job);
    this.bytes += job.bytes;
    void this.drain();
    return true;
  }

  private async drain() {
    if (this.active) return;
    while (this.pending.length) {
      const job = this.pending.shift()!;
      const revision = this.revision;
      this.active = job;
      try { await job.run(() => revision === this.revision); }
      finally {
        this.bytes -= job.bytes;
        this.active = undefined;
      }
    }
  }
}
