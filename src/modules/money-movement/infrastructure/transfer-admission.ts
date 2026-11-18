import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { performance } from 'node:perf_hooks';
import { MoneyMovementTelemetry } from '@src/common/observability/money-movement-telemetry';
import { TransferOverloadedError } from '../domain/errors';

interface Waiter {
  keys: string[];
  deadline: number;
  expire: () => void;
  admit: () => void;
}

/** Bounds work before acquiring a connection or starting a database transaction. */
@Injectable()
export class TransferAdmission {
  private readonly mode: 'off' | 'global' | 'account';
  private readonly activeLimit: number;
  private readonly queueLimit: number;
  private readonly waitMs: number;
  private readonly pending: Waiter[] = [];
  private readonly occupied = new Set<string>();
  private active = 0;

  constructor(config: ConfigService, private readonly telemetry: MoneyMovementTelemetry) {
    this.mode = config.getOrThrow('TRANSFER_ADMISSION');
    this.activeLimit = config.getOrThrow('TRANSFER_ACTIVE_LIMIT');
    this.queueLimit = config.getOrThrow('TRANSFER_QUEUE_LIMIT');
    this.waitMs = config.getOrThrow('TRANSFER_QUEUE_WAIT_MS');
  }

  async run<T>(sourceId: string, recipientNumber: string, work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    if (this.mode === 'off') return work();
    const keys = this.mode === 'account' ? [`source:${sourceId}`, `recipient:${recipientNumber}`] : [];
    await this.acquire(keys, signal);
    try {
      signal?.throwIfAborted();
      return await work();
    } finally {
      this.active--;
      for (const key of keys) this.occupied.delete(key);
      this.drain();
    }
  }

  private acquire(keys: string[], signal?: AbortSignal): Promise<void> {
    const started = performance.now();
    if (this.active < this.activeLimit &&
        keys.every(key => !this.occupied.has(key) && !this.pending.some(waiter => waiter.keys.includes(key)))) {
      this.reserve(keys, started);
      return Promise.resolve();
    }
    if (this.pending.length >= this.queueLimit) {
      this.telemetry.increment('queue_full');
      this.telemetry.observe('transfer_queue_wait', 0);
      return Promise.reject(new TransferOverloadedError());
    }

    return new Promise((resolve, reject) => {
      const remove = (reason: 'queue_timeout' | 'queue_cancelled', error: unknown) => {
        const index = this.pending.indexOf(waiter);
        if (index < 0) return;
        this.pending.splice(index, 1);
        cleanup();
        this.telemetry.increment(reason);
        this.telemetry.observe('transfer_queue_wait', performance.now() - started);
        reject(error);
      };
      const cancel = () => {
        remove('queue_cancelled', signal?.reason);
        this.drain();
      };
      const expire = () => remove('queue_timeout', new TransferOverloadedError());
      const timer = setTimeout(() => {
        expire();
        this.drain();
      }, this.waitMs);
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
      };
      const waiter: Waiter = {
        keys,
        deadline: started + this.waitMs,
        expire,
        admit: () => {
          cleanup();
          this.reserve(keys, started);
          resolve();
        },
      };
      this.pending.push(waiter);
      signal?.addEventListener('abort', cancel, { once: true });
    });
  }

  private reserve(keys: string[], started: number): void {
    this.active++;
    for (const key of keys) this.occupied.add(key);
    this.telemetry.increment('queue_admitted');
    this.telemetry.observe('transfer_queue_wait', performance.now() - started);
  }

  private drain(): void {
    // A queued request can pass earlier ones only if they share no keys.
    const earlierKeys = new Set<string>();
    for (let index = 0; index < this.pending.length && this.active < this.activeLimit;) {
      const waiter = this.pending[index];
      if (performance.now() >= waiter.deadline) {
        waiter.expire();
        continue;
      }
      if (waiter.keys.some(key => this.occupied.has(key) || earlierKeys.has(key))) {
        for (const key of waiter.keys) earlierKeys.add(key);
        index++;
      } else {
        this.pending.splice(index, 1);
        waiter.admit();
      }
    }
  }
}
