import {
  CAMPAIGN_ID_PATTERN,
  type Event,
  type EventName,
  type EventProperties,
} from '@apple/contracts';
import { uuid } from '../uuid';

const eventNames: ReadonlySet<string> = new Set<EventName>([
  'page_view',
  'interaction_started',
  'interaction_completed',
  'interaction_paused',
  'interaction_resumed',
  'interaction_reset',
  'resource_failed',
]);
const campaignIdPattern = new RegExp(CAMPAIGN_ID_PATTERN);

export interface TelemetrySnapshot {
  consent: boolean;
  queued: number;
  accepted: number;
  duplicates: number;
  dropped: number;
  sending: boolean;
  lastError: string | null;
  beaconAttempted: boolean;
}

interface TelemetryOptions {
  campaignId: Event['campaignId'];
  releaseId: string;
  fetch?: typeof fetch;
  makeId?: () => string;
  now?: () => Date;
  maxQueue?: number;
  batchSize?: number;
  automatic?: boolean;
}

export function sanitizeProperties(properties: EventProperties): EventProperties {
  const clean: EventProperties = {};
  if (
    typeof properties.roundId === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      properties.roundId,
    )
  ) {
    clean.roundId = properties.roundId.toLowerCase();
  }
  if (properties.interaction === 'timing' || properties.interaction === 'swipe') {
    clean.interaction = properties.interaction;
  }
  if (
    properties.reason !== undefined &&
    ['hidden', 'user', 'network', 'asset'].includes(properties.reason)
  ) {
    clean.reason = properties.reason;
  }
  if (
    typeof properties.durationMs === 'number' &&
    Number.isInteger(properties.durationMs) &&
    properties.durationMs >= 0 &&
    properties.durationMs <= 3_600_000
  ) {
    clean.durationMs = properties.durationMs;
  }
  if (
    typeof properties.steps === 'number' &&
    Number.isInteger(properties.steps) &&
    properties.steps >= 0 &&
    properties.steps <= 100
  ) {
    clean.steps = properties.steps;
  }
  return clean;
}

/**
 * Optional, memory-only analytics. Acknowledged batches are removed; beacon delivery
 * is best effort and never counts as an acknowledgement. No identifiers survive reload.
 */
export class TelemetryClient {
  private readonly fetcher: typeof fetch;
  private readonly makeId: () => string;
  private readonly now: () => Date;
  private readonly maxQueue: number;
  private readonly batchSize: number;
  private readonly automatic: boolean;
  private readonly listeners = new Set<() => void>();
  private queue: Event[] = [];
  private sessionId: string | null = null;
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inflight: Promise<void> | null = null;
  private controller: AbortController | null = null;
  private retryMs = 1_000;
  private snapshot: TelemetrySnapshot = {
    consent: false,
    queued: 0,
    accepted: 0,
    duplicates: 0,
    dropped: 0,
    sending: false,
    lastError: null,
    beaconAttempted: false,
  };

  constructor(private readonly options: TelemetryOptions) {
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.makeId = options.makeId ?? uuid;
    this.now = options.now ?? (() => new Date());
    this.maxQueue = options.maxQueue ?? 200;
    this.batchSize = Math.min(50, options.batchSize ?? 50);
    this.automatic = options.automatic ?? true;
    if (
      options.campaignId.length < 1 ||
      options.campaignId.length > 64 ||
      !campaignIdPattern.test(options.campaignId)
    ) {
      throw new Error('Invalid analytics campaign identifier');
    }
    if (!/^[a-zA-Z0-9._-]{1,100}$/.test(options.releaseId)) {
      throw new Error('Invalid analytics release identifier');
    }
    if (this.maxQueue < 1 || this.batchSize < 1) throw new Error('Invalid queue configuration');
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): TelemetrySnapshot => this.snapshot;

  pendingForRound(roundId: string): number {
    return this.queue.filter((event) => event.properties.roundId === roundId.toLowerCase()).length;
  }

  setConsent(consent: boolean): void {
    if (consent === this.snapshot.consent) return;
    this.generation += 1;
    if (!consent) {
      this.controller?.abort();
      this.cancelTimer();
      this.queue = [];
      this.sessionId = null;
      this.publish({ consent: false, queued: 0, sending: false, lastError: null });
      return;
    }
    this.sessionId = this.makeId();
    this.publish({ consent: true, lastError: null });
  }

  track(eventName: EventName, properties: EventProperties = {}): boolean {
    if (!this.snapshot.consent || !this.sessionId || !eventNames.has(eventName)) return false;
    if (this.queue.length >= this.maxQueue) {
      this.publish({ dropped: this.snapshot.dropped + 1, lastError: '队列已满，已丢弃新事件' });
      return false;
    }
    this.queue.push({
      eventId: this.makeId(),
      eventName,
      schemaVersion: 1,
      campaignId: this.options.campaignId,
      releaseId: this.options.releaseId,
      sessionId: this.sessionId,
      clientTime: this.now().toISOString(),
      properties: sanitizeProperties(properties),
    });
    this.publish({ queued: this.queue.length });
    this.schedule(1_000);
    return true;
  }

  flush(): Promise<void> {
    if (this.inflight) return this.inflight;
    if (!this.snapshot.consent || this.queue.length === 0) return Promise.resolve();
    this.cancelTimer();
    const generation = this.generation;
    const batch = this.queue.slice(0, this.batchSize);
    const controller = new AbortController();
    this.controller = controller;
    this.publish({ sending: true });
    const timeout = setTimeout(() => controller.abort(), 8_000);
    const task = this.send(batch, generation, controller.signal).finally(() => {
      clearTimeout(timeout);
      if (this.controller === controller) this.controller = null;
      this.inflight = null;
      if (generation === this.generation) this.publish({ sending: false });
      if (this.snapshot.consent && this.queue.length > 0) this.schedule(this.retryMs);
    });
    this.inflight = task;
    return task;
  }

  private async send(batch: Event[], generation: number, signal: AbortSignal): Promise<void> {
    try {
      const response = await this.fetcher('/api/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ events: batch }),
        signal,
      });
      if (generation !== this.generation) return;
      if (!response.ok) {
        if (response.status >= 400 && response.status < 500 && response.status !== 429) {
          this.remove(batch);
          this.publish({
            dropped: this.snapshot.dropped + batch.length,
            lastError: `事件被拒绝（HTTP ${response.status}），未计为送达`,
          });
          this.retryMs = 1_000;
          return;
        }
        throw new Error(`HTTP ${response.status}`);
      }
      const result: unknown = await response.json();
      if (generation !== this.generation) return;
      if (
        typeof result !== 'object' ||
        result === null ||
        !('accepted' in result) ||
        !('duplicates' in result) ||
        !Number.isInteger(result.accepted) ||
        !Number.isInteger(result.duplicates) ||
        Number(result.accepted) < 0 ||
        Number(result.duplicates) < 0 ||
        Number(result.accepted) + Number(result.duplicates) !== batch.length
      ) {
        throw new Error('Invalid acknowledgement');
      }
      this.remove(batch);
      this.retryMs = 1_000;
      this.publish({
        accepted: this.snapshot.accepted + Number(result.accepted),
        duplicates: this.snapshot.duplicates + Number(result.duplicates),
        lastError: null,
      });
    } catch {
      if (generation !== this.generation) return;
      this.retryMs = Math.min(30_000, this.retryMs * 2);
      this.publish({ lastError: '未收到服务端确认；事件保留并等待重试' });
    }
  }

  beacon(send: (url: string, data: Blob) => boolean): boolean {
    if (!this.snapshot.consent || this.queue.length === 0) return false;
    const body = new Blob([JSON.stringify({ events: this.queue.slice(0, this.batchSize) })], {
      type: 'application/json',
    });
    try {
      const attempted = send('/api/events', body);
      this.publish({ beaconAttempted: attempted });
      return attempted;
    } catch {
      this.publish({ lastError: '页面隐藏时发送未成功；事件仍在等待确认' });
      return false;
    }
  }

  stop(): void {
    this.setConsent(false);
    this.cancelTimer();
  }

  private remove(batch: Event[]): void {
    const ids = new Set(batch.map((event) => event.eventId));
    this.queue = this.queue.filter((event) => !ids.has(event.eventId));
    this.publish({ queued: this.queue.length });
  }

  private schedule(delay: number): void {
    if (!this.automatic || this.timer !== undefined || !this.snapshot.consent) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, delay);
  }

  private cancelTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private publish(update: Partial<TelemetrySnapshot>): void {
    this.snapshot = { ...this.snapshot, ...update };
    for (const listener of this.listeners) listener();
  }
}
