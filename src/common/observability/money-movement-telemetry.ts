import { Injectable } from '@nestjs/common';

export type MovementTiming = 'transaction_start' | 'transaction_attempt' |
  'transaction_callback' | 'transaction_finish' | 'account_lock_query' | 'transfer_write' | 'transfer_queue_wait';
export type MovementCounter = 'attempts' | 'committed' | 'rejected' | 'retries' | 'retry_exhausted' |
  'queue_admitted' | 'queue_full' | 'queue_timeout' | 'queue_cancelled';
const BUCKETS_MS = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000];

/** Process-local, bounded aggregates. No account IDs, keys, amounts or payloads. */
@Injectable()
export class MoneyMovementTelemetry {
  private counters: Partial<Record<MovementCounter, number>> = {};
  private timings: Partial<Record<MovementTiming, {
    count: number; sumMs: number; maxMs: number; buckets: number[];
  }>> = {};

  increment(name: MovementCounter): void {
    this.counters[name] = (this.counters[name] ?? 0) + 1;
  }

  observe(name: MovementTiming, milliseconds: number): void {
    const value = Math.max(0, milliseconds);
    const metric = this.timings[name] ??= {
      count: 0, sumMs: 0, maxMs: 0, buckets: BUCKETS_MS.map(() => 0),
    };
    metric.count++;
    metric.sumMs += value;
    metric.maxMs = Math.max(metric.maxMs, value);
    BUCKETS_MS.forEach((upper, i) => { if (value <= upper) metric.buckets[i]++; });
  }

  snapshot() {
    return structuredClone({ counters: this.counters, timings: this.timings, bucketUpperBoundsMs: BUCKETS_MS });
  }

  reset(): void {
    this.counters = {};
    this.timings = {};
  }
}
