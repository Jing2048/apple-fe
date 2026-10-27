import type { BlessingIndex, PostStorage } from '../post/recovery';
import { uuid } from '../uuid';
import { getOfflineLocalStorage, getOfflineStorageKeys, type OfflineNamespace } from './storage';

export const offlineRecordLimit = 20;
export const offlineRecordsMaxLength = 8192;

export interface OfflineRecord {
  readonly id: string;
  readonly roundId: string;
  readonly blessingIndex: BlessingIndex;
  readonly createdAt: string;
}

export interface OfflineRecordsSnapshot {
  readonly records: readonly OfflineRecord[];
  readonly persistence: 'local' | 'memory';
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const isoPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const recordFields = new Set(['id', 'roundId', 'blessingIndex', 'createdAt']);

function validUuid(value: unknown): value is string {
  return typeof value === 'string' && uuidPattern.test(value);
}

function validBlessing(value: unknown): value is BlessingIndex {
  return value === 0 || value === 1 || value === 2;
}

function validDate(value: unknown): value is string {
  if (typeof value !== 'string' || !isoPattern.test(value)) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function recent(records: readonly OfflineRecord[]): OfflineRecord[] {
  // Insertion order survives clock rollback; a new completion must never evict itself.
  return [...records].slice(0, offlineRecordLimit);
}

function parseRecords(raw: string): OfflineRecord[] | null {
  if (raw.length > offlineRecordsMaxLength) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const envelope = value as Record<string, unknown>;
    if (
      Object.keys(envelope).some((key) => key !== 'version' && key !== 'records') ||
      envelope.version !== 1 ||
      !Array.isArray(envelope.records) ||
      envelope.records.length > offlineRecordLimit
    )
      return null;
    const records: OfflineRecord[] = [];
    const ids = new Set<string>();
    const rounds = new Set<string>();
    for (const entry of envelope.records) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
      const item = entry as Record<string, unknown>;
      if (
        Object.keys(item).some((key) => !recordFields.has(key)) ||
        !validUuid(item.id) ||
        !validUuid(item.roundId) ||
        !validBlessing(item.blessingIndex) ||
        !validDate(item.createdAt)
      )
        return null;
      const id = item.id.toLowerCase();
      const roundId = item.roundId.toLowerCase();
      if (ids.has(id) || rounds.has(roundId)) return null;
      ids.add(id);
      rounds.add(roundId);
      records.push({ id, roundId, blessingIndex: item.blessingIndex, createdAt: item.createdAt });
    }
    return recent(records);
  } catch {
    return null;
  }
}

function snapshot(
  records: readonly OfflineRecord[],
  persistence: OfflineRecordsSnapshot['persistence'],
): OfflineRecordsSnapshot {
  return Object.freeze({
    records: Object.freeze(records.map((record) => Object.freeze(record))),
    persistence,
  });
}

/** Optional local records only. No requests, server receipts, or online storage keys. */
export class OfflineRecords {
  private current: OfflineRecordsSnapshot;
  private readonly listeners = new Set<() => void>();
  private canPersist = false;
  private readonly backing: PostStorage | null;
  private readonly keys: ReturnType<typeof getOfflineStorageKeys>;

  constructor(backing?: PostStorage | null, namespace: OfflineNamespace = 'classic') {
    this.keys = getOfflineStorageKeys(namespace);
    this.backing = backing === undefined ? getOfflineLocalStorage() : backing;
    const storage = this.backing;
    let records: OfflineRecord[] = [];
    if (storage) {
      try {
        const raw = storage.getItem(this.keys.records);
        if (raw !== null) {
          const parsed = parseRecords(raw);
          if (parsed) records = parsed;
          else storage.removeItem(this.keys.records);
        }
        storage.setItem(this.keys.probe, '1');
        if (storage.getItem(this.keys.probe) !== '1')
          throw new Error('Storage write could not be confirmed.');
        storage.removeItem(this.keys.probe);
        this.canPersist = true;
      } catch {
        try {
          storage.removeItem(this.keys.probe);
        } catch {
          /* Optional storage. */
        }
      }
    }
    this.current = snapshot(records, this.canPersist ? 'local' : 'memory');
  }

  getSnapshot = (): OfflineRecordsSnapshot => this.current;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  record = (roundId: string, blessingIndex: BlessingIndex): OfflineRecord | null => {
    if (!validUuid(roundId) || !validBlessing(blessingIndex)) return null;
    const key = roundId.toLowerCase();
    const previous = this.current.records.find((record) => record.roundId === key);
    if (previous?.blessingIndex === blessingIndex) return previous;
    let card: OfflineRecord;
    try {
      card = previous
        ? { ...previous, blessingIndex }
        : {
            id: uuid().toLowerCase(),
            roundId: key,
            blessingIndex,
            createdAt: new Date().toISOString(),
          };
      if (!validUuid(card.id) || !validDate(card.createdAt)) return null;
    } catch {
      return null;
    }
    const records = recent(
      previous
        ? this.current.records.map((record) => (record.roundId === key ? card : record))
        : [card, ...this.current.records],
    );
    if (this.canPersist && this.backing) {
      try {
        const raw = JSON.stringify({ version: 1, records });
        this.backing.setItem(this.keys.records, raw);
        if (this.backing.getItem(this.keys.records) !== raw)
          throw new Error('Storage write could not be confirmed.');
      } catch {
        this.canPersist = false;
      }
    }
    this.publish(records);
    return this.current.records.find((record) => record.roundId === key) ?? null;
  };

  clear = (): void => {
    if (this.backing) {
      for (const key of [this.keys.records, this.keys.draft]) {
        try {
          this.backing.removeItem(key);
          if (this.backing.getItem(key) !== null)
            throw new Error('Storage deletion could not be confirmed.');
        } catch {
          this.canPersist = false;
        }
      }
    }
    this.publish([]);
  };

  private publish(records: readonly OfflineRecord[]): void {
    const persistence = this.canPersist ? 'local' : 'memory';
    if (
      this.current.persistence === persistence &&
      records.length === this.current.records.length &&
      records.every((record, index) => record === this.current.records[index])
    )
      return;
    this.current = snapshot(records, persistence);
    for (const listener of [...this.listeners]) listener();
  }
}
