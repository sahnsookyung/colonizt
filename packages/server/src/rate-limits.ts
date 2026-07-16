import { withinSlidingWindow } from "./websocket-transport.js";

export class RateLimitBuckets {
  private readonly buckets = new Map<string, number[]>();

  constructor(private readonly now: () => number = Date.now) {}

  allow(key: string, limit: number, windowMs: number, now = this.now()): boolean {
    const timestamps = this.buckets.get(key) ?? [];
    const allowed = withinSlidingWindow(timestamps, limit, windowMs, now);
    this.buckets.set(key, timestamps);
    return allowed;
  }

  sweep(maxAgeMs = 60_000): void {
    const cutoff = this.now() - maxAgeMs;
    for (const [key, timestamps] of this.buckets) {
      while (timestamps[0] !== undefined && timestamps[0] < cutoff) timestamps.shift();
      if (timestamps.length === 0) this.buckets.delete(key);
    }
  }

  size(): number {
    return this.buckets.size;
  }
}
