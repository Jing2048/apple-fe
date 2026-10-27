import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearPostDraft,
  postRecoveryKey,
  readPostDraft,
  savePostDraft,
  type BlessingIndex,
  type PostStorage,
} from '../post/recovery';
import { createPostState, postReducer } from '../post/logic';
import { uuid } from '../uuid';
import { OfflineRecords, offlineRecordLimit, offlineRecordsMaxLength } from './records';
import {
  getOfflineDraftStorage,
  getOfflineLocalStorage,
  getOfflineStorageKeys,
  offlineDraftKey,
  offlineProbeKey,
  offlineRecordsKey,
  type OfflineNamespace,
} from './storage';

function storage() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      data.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      data.delete(key);
    }),
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('optional offline records', () => {
  it('deduplicates canonical round IDs, keeps the first ID/time and persists selection changes', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-27T12:00:00.000Z'));
    const backing = storage();
    const records = new OfflineRecords(backing);
    const round = uuid();
    const first = records.record(round, 0)!;
    expect(records.getSnapshot().persistence).toBe('local');
    const initial = records.getSnapshot();
    expect(records.getSnapshot()).toBe(initial);
    expect(records.record(round.toUpperCase(), 0)).toBe(first);
    expect(records.getSnapshot()).toBe(initial);
    vi.setSystemTime(new Date('2026-10-28T12:00:00.000Z'));
    const restored = new OfflineRecords(backing);
    const selected = restored.record(round.toUpperCase(), 2)!;
    expect(selected).toEqual({ ...first, blessingIndex: 2 });
    expect(restored.getSnapshot().records).toHaveLength(1);
    expect(new OfflineRecords(backing).getSnapshot().records).toEqual([selected]);
    const envelope = JSON.parse(backing.getItem(offlineRecordsKey)!);
    expect(Object.keys(envelope).sort()).toEqual(['records', 'version']);
    expect(envelope.version).toBe(1);
    expect(Object.keys(envelope.records[0]).sort()).toEqual([
      'blessingIndex',
      'createdAt',
      'id',
      'roundId',
    ]);
    expect(Object.isFrozen(restored.getSnapshot())).toBe(true);
    expect(Object.isFrozen(restored.getSnapshot().records)).toBe(true);
    expect(Object.isFrozen(selected)).toBe(true);
  });

  it('keeps stable snapshots and only notifies meaningful changes', () => {
    const records = new OfflineRecords(null);
    const notify = vi.fn();
    const unsubscribe = records.subscribe(notify);
    const round = uuid();
    records.record(round, 0);
    const first = records.getSnapshot();
    records.record(round, 0);
    expect(records.getSnapshot()).toBe(first);
    expect(records.record('invalid-round', 0)).toBeNull();
    expect(records.record(round, 3 as BlessingIndex)).toBeNull();
    expect(records.record(round, '1' as unknown as BlessingIndex)).toBeNull();
    expect(records.getSnapshot()).toBe(first);
    records.record(round, 1);
    records.clear();
    const cleared = records.getSnapshot();
    records.clear();
    expect(records.getSnapshot()).toBe(cleared);
    expect(notify).toHaveBeenCalledTimes(3);
    unsubscribe();
    records.record(uuid(), 0);
    expect(notify).toHaveBeenCalledTimes(3);
  });

  it('retains only the most recent twenty rounds and preserves first creation order on selection', () => {
    vi.useFakeTimers();
    const backing = storage();
    const records = new OfflineRecords(backing);
    const rounds = Array.from({ length: offlineRecordLimit + 1 }, () => uuid());
    for (const [index, round] of rounds.entries()) {
      vi.setSystemTime(new Date(Date.UTC(2026, 9, 27, 12, 0, index)));
      records.record(round, 0);
    }
    expect(records.getSnapshot().records).toHaveLength(20);
    expect(records.getSnapshot().records[0]?.roundId).toBe(rounds.at(-1));
    expect(records.getSnapshot().records.at(-1)?.roundId).toBe(rounds[1]);
    expect(records.getSnapshot().records.some((record) => record.roundId === rounds[0])).toBe(
      false,
    );
    const oldest = records.getSnapshot().records.at(-1)!;
    vi.setSystemTime(new Date('2026-10-30T12:00:00.000Z'));
    records.record(oldest.roundId, 2);
    expect(records.getSnapshot().records.at(-1)).toEqual({ ...oldest, blessingIndex: 2 });
    expect(new OfflineRecords(backing).getSnapshot().records).toEqual(
      records.getSnapshot().records,
    );
  });

  it('retains new completions after clock rollback and keeps persisted insertion order', () => {
    vi.useFakeTimers();
    const backing = storage();
    const prior = Array.from({ length: 20 }, () => ({
      id: uuid(),
      roundId: uuid(),
      blessingIndex: 0,
      createdAt: '2027-01-01T00:00:00.000Z',
    }));
    backing.setItem(offlineRecordsKey, JSON.stringify({ version: 1, records: prior }));
    vi.setSystemTime(new Date('2026-10-27T12:00:00.000Z'));
    const records = new OfflineRecords(backing);
    expect(records.getSnapshot().records).toEqual(prior);
    const round = uuid();
    const card = records.record(round, 1);
    expect(card).not.toBeNull();
    expect(records.getSnapshot().records).toEqual([card, ...prior.slice(0, 19)]);
    expect(records.getSnapshot().persistence).toBe('local');
    expect(new OfflineRecords(backing).getSnapshot().records).toEqual(
      records.getSnapshot().records,
    );
    const position = records
      .getSnapshot()
      .records.findIndex((record) => record.roundId === prior[10]!.roundId);
    records.record(prior[10]!.roundId, 2);
    expect(records.getSnapshot().records[position]).toEqual({ ...prior[10], blessingIndex: 2 });
  });

  it('discards malformed, oversized, duplicated or invalid stored data without touching online keys', () => {
    const backing = storage();
    const valid = {
      id: uuid(),
      roundId: uuid(),
      blessingIndex: 1,
      createdAt: '2026-10-27T12:00:00.000Z',
    };
    const cases = [
      'not-json',
      '[]',
      'null',
      JSON.stringify({ version: 2, records: [valid] }),
      JSON.stringify({ version: 1, records: [valid], extra: true }),
      JSON.stringify({ version: 1, records: 'not-records' }),
      ...[
        { ...valid, id: 'not-a-uuid' },
        { ...valid, roundId: 'not-a-uuid' },
        { ...valid, blessingIndex: 3 },
        { ...valid, blessingIndex: '1' },
        { ...valid, createdAt: 'not-a-date' },
        { ...valid, createdAt: '2026-02-30T12:00:00.000Z' },
        { ...valid, createdAt: '2026-10-27T12:00:00Z' },
        { ...valid, createdAt: 123 },
        { ...valid, email: 'not-stored@example.invalid' },
      ].map((record) => JSON.stringify({ version: 1, records: [record] })),
      JSON.stringify({
        version: 1,
        records: [valid, { ...valid, id: uuid(), roundId: valid.roundId.toUpperCase() }],
      }),
      JSON.stringify({ version: 1, records: [valid, { ...valid, roundId: uuid() }] }),
      JSON.stringify({
        version: 1,
        records: Array.from({ length: 21 }, () => ({ ...valid, id: uuid(), roundId: uuid() })),
      }),
      'x'.repeat(offlineRecordsMaxLength + 1),
    ];
    backing.setItem(postRecoveryKey, 'online-draft');
    for (const raw of cases) {
      backing.setItem(offlineRecordsKey, raw);
      const records = new OfflineRecords(backing);
      expect(records.getSnapshot().records).toEqual([]);
      expect(backing.getItem(offlineRecordsKey)).toBeNull();
      expect(backing.getItem(postRecoveryKey)).toBe('online-draft');
    }
  });

  it('clears only offline records and draft while leaving online and unrelated data untouched', () => {
    const backing = storage();
    backing.setItem(postRecoveryKey, 'online-draft');
    backing.setItem('unrelated-key', 'unrelated-data');
    backing.setItem(offlineDraftKey, 'offline-draft');
    const records = new OfflineRecords(backing);
    records.record(uuid(), 1);
    expect(backing.getItem(offlineProbeKey)).toBeNull();
    records.clear();
    expect(records.getSnapshot()).toEqual({ records: [], persistence: 'local' });
    expect(backing.getItem(offlineRecordsKey)).toBeNull();
    expect(backing.getItem(offlineDraftKey)).toBeNull();
    expect(backing.getItem(postRecoveryKey)).toBe('online-draft');
    expect(backing.getItem('unrelated-key')).toBe('unrelated-data');
    expect(new OfflineRecords(backing).getSnapshot().records).toEqual([]);
  });

  it('falls back to this instance memory after quota failure and still attempts persistent deletion', () => {
    const backing = storage();
    const records = new OfflineRecords(backing);
    const original = records.record(uuid(), 0)!;
    backing.setItem(offlineDraftKey, 'draft');
    backing.setItem.mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    expect(records.record(uuid(), 1)).not.toBeNull();
    expect(records.getSnapshot().persistence).toBe('memory');
    expect(records.getSnapshot().records).toHaveLength(2);
    expect(JSON.parse(backing.getItem(offlineRecordsKey)!).records).toEqual([original]);
    const attemptedWrites = backing.setItem.mock.calls.length;
    records.record(uuid(), 2);
    expect(backing.setItem.mock.calls).toHaveLength(attemptedWrites);
    records.clear();
    expect(records.getSnapshot()).toEqual({ records: [], persistence: 'memory' });
    expect(backing.getItem(offlineRecordsKey)).toBeNull();
    expect(backing.getItem(offlineDraftKey)).toBeNull();
  });

  it('clears memory and reports unconfirmed persistent removal without claiming disk data vanished', () => {
    const backing = storage();
    const records = new OfflineRecords(backing);
    records.record(uuid(), 0);
    backing.setItem(offlineDraftKey, 'draft');
    backing.removeItem.mockImplementation((key) => {
      if (key === offlineRecordsKey) throw new Error('Removal denied');
      backing.data.delete(key);
    });
    records.clear();
    expect(records.getSnapshot()).toEqual({ records: [], persistence: 'memory' });
    expect(backing.getItem(offlineRecordsKey)).not.toBeNull();
    expect(backing.getItem(offlineDraftKey)).toBeNull();
  });

  it('does not mark silent or unreadable writes as persistent', () => {
    const silent = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
    const memory = new OfflineRecords(silent);
    expect(memory.getSnapshot().persistence).toBe('memory');
    expect(memory.record(uuid(), 0)).not.toBeNull();
    expect(memory.getSnapshot().persistence).toBe('memory');
    const backing = storage();
    const records = new OfflineRecords(backing);
    backing.setItem.mockImplementation(() => {});
    records.record(uuid(), 1);
    expect(records.getSnapshot().persistence).toBe('memory');
  });

  it('keeps readable saved cards in memory when browser storage becomes read-only', () => {
    const backing = storage();
    const first = new OfflineRecords(backing).record(uuid(), 1)!;
    backing.setItem.mockImplementation(() => {
      throw new Error('Read-only storage');
    });
    const restored = new OfflineRecords(backing);
    expect(restored.getSnapshot()).toEqual({ records: [first], persistence: 'memory' });
    expect(restored.record(first.roundId, 2)).toEqual({ ...first, blessingIndex: 2 });
  });

  it('controls storage getters and explicit null without falling back to global storage or networking', () => {
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('Offline means no network'));
    const deniedWindow = Object.defineProperty({}, 'localStorage', {
      get: () => {
        throw new Error('SecurityError');
      },
    });
    vi.stubGlobal('window', deniedWindow);
    expect(getOfflineLocalStorage()).toBeNull();
    expect(getOfflineDraftStorage()).toBeNull();
    const denied = new OfflineRecords();
    expect(denied.getSnapshot().persistence).toBe('memory');
    expect(denied.record(uuid(), 0)).not.toBeNull();
    expect(() => denied.clear()).not.toThrow();
    const available = storage();
    vi.stubGlobal('window', { localStorage: available });
    expect(getOfflineDraftStorage(null)).toBeNull();
    const disabled = new OfflineRecords(null);
    disabled.record(uuid(), 2);
    disabled.clear();
    expect(available.getItem).not.toHaveBeenCalled();
    expect(available.setItem).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('handles exceptional method getters as an unavailable optional storage backend', () => {
    const denied = Object.defineProperty({}, 'getItem', {
      get: () => {
        throw new Error('Getter denied');
      },
    }) as PostStorage;
    const records = new OfflineRecords(denied);
    expect(records.getSnapshot().persistence).toBe('memory');
    expect(records.record(uuid(), 0)).not.toBeNull();
    expect(() => records.clear()).not.toThrow();
    expect(getOfflineDraftStorage(denied)).toBeNull();
  });
});

describe('isolated offline draft adapter', () => {
  it('reuses the validated post recovery schema within the offline namespace only', () => {
    const backing = storage();
    backing.setItem(postRecoveryKey, 'online-draft');
    backing.setItem(offlineRecordsKey, 'separate-records');
    const adapter = getOfflineDraftStorage(backing);
    const round = uuid();
    const ready = postReducer(createPostState(round), { type: 'LOADED' });
    expect(savePostDraft(adapter, ready, 2)).toBe(true);
    expect(readPostDraft(adapter)).toMatchObject({
      blessingIndex: 2,
      state: { roundId: round, phase: 'ready' },
    });
    expect(backing.getItem(offlineDraftKey)).not.toBeNull();
    expect(backing.getItem(postRecoveryKey)).toBe('online-draft');
    clearPostDraft(adapter);
    expect(backing.getItem(offlineDraftKey)).toBeNull();
    expect(backing.getItem(postRecoveryKey)).toBe('online-draft');
    expect(backing.getItem(offlineRecordsKey)).toBe('separate-records');
    expect(() => adapter?.setItem('unexpected-key', 'value')).toThrow(
      'Unsupported offline draft key',
    );
  });

  it('preserves recovery false/null behavior when writes, reads or removals fail', () => {
    const backing: PostStorage = {
      getItem: () => {
        throw new Error('Read denied');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
      removeItem: () => {
        throw new Error('Removal denied');
      },
    };
    const adapter = getOfflineDraftStorage(backing);
    expect(adapter).not.toBeNull();
    const ready = postReducer(createPostState(uuid()), { type: 'LOADED' });
    expect(savePostDraft(adapter, ready, 0)).toBe(false);
    expect(readPostDraft(adapter)).toBeNull();
    expect(() => clearPostDraft(adapter)).not.toThrow();
    expect(savePostDraft(getOfflineDraftStorage(null), ready, 0)).toBe(false);
  });
});

describe('classic and new-year offline namespaces', () => {
  it('preserves the original default keys and reads existing classic history without migration', () => {
    expect(getOfflineStorageKeys()).toEqual({
      records: 'cloud-post.offline.v1.records',
      draft: 'cloud-post.offline.v1.draft',
      probe: 'cloud-post.offline.v1.probe',
    });
    expect(getOfflineStorageKeys('classic')).toEqual({
      records: offlineRecordsKey,
      draft: offlineDraftKey,
      probe: offlineProbeKey,
    });
    expect(getOfflineStorageKeys('new-year')).toEqual({
      records: 'cloud-post.offline.new-year.v1.records',
      draft: 'cloud-post.offline.new-year.v1.draft',
      probe: 'cloud-post.offline.new-year.v1.probe',
    });
    expect(Object.isFrozen(getOfflineStorageKeys())).toBe(true);
    expect(Object.isFrozen(getOfflineStorageKeys('new-year'))).toBe(true);
    const backing = storage();
    const saved = {
      id: uuid(),
      roundId: uuid(),
      blessingIndex: 1,
      createdAt: '2026-10-27T12:00:00.000Z',
    };
    backing.setItem(
      'cloud-post.offline.v1.records',
      JSON.stringify({ version: 1, records: [saved] }),
    );
    expect(new OfflineRecords(backing).getSnapshot().records).toEqual([saved]);
    expect(new OfflineRecords(backing, 'new-year').getSnapshot().records).toEqual([]);
    expect(backing.getItem('cloud-post.offline.v1.records')).not.toBeNull();
    expect(backing.getItem('cloud-post.offline.new-year.v1.records')).toBeNull();
  });

  it('isolates the same round, blessing selection, recovery and clear in both directions', () => {
    const backing = storage();
    const classic = new OfflineRecords(backing);
    const newYear = new OfflineRecords(backing, 'new-year');
    const classicDraft = getOfflineDraftStorage(backing);
    const newYearDraft = getOfflineDraftStorage(backing, 'new-year');
    const round = uuid();
    const classicCard = classic.record(round, 0)!;
    const newYearCard = newYear.record(round.toUpperCase(), 2)!;
    expect(classicCard.id).not.toBe(newYearCard.id);
    expect(new OfflineRecords(backing).getSnapshot().records).toEqual([classicCard]);
    expect(new OfflineRecords(backing, 'new-year').getSnapshot().records).toEqual([newYearCard]);
    const ready = postReducer(createPostState(round), { type: 'LOADED' });
    const progressed = postReducer(postReducer(ready, { type: 'START', now: 100 }), {
      type: 'COLLECT',
      cell: 0,
      now: 200,
    });
    expect(savePostDraft(classicDraft, progressed, 0)).toBe(true);
    expect(savePostDraft(newYearDraft, ready, 2)).toBe(true);
    expect(readPostDraft(classicDraft)).toMatchObject({
      blessingIndex: 0,
      state: { roundId: round, phase: 'paused', steps: 1 },
    });
    expect(readPostDraft(newYearDraft)).toMatchObject({
      blessingIndex: 2,
      state: { roundId: round, phase: 'ready', steps: 0 },
    });
    backing.setItem(postRecoveryKey, 'online-draft');
    newYear.clear();
    expect(newYear.getSnapshot().records).toEqual([]);
    expect(readPostDraft(newYearDraft)).toBeNull();
    expect(new OfflineRecords(backing).getSnapshot().records).toEqual([classicCard]);
    expect(readPostDraft(classicDraft)?.state.steps).toBe(1);
    const anotherNewYearCard = newYear.record(round, 1)!;
    expect(savePostDraft(newYearDraft, ready, 1)).toBe(true);
    classic.clear();
    expect(readPostDraft(classicDraft)).toBeNull();
    expect(new OfflineRecords(backing, 'new-year').getSnapshot().records).toEqual([
      anotherNewYearCard,
    ]);
    expect(readPostDraft(newYearDraft)?.blessingIndex).toBe(1);
    expect(backing.getItem(postRecoveryKey)).toBe('online-draft');
  });

  it('rejects invalid scopes before any explicit or default storage access', () => {
    const backing = storage();
    const getter = vi.fn(() => backing);
    vi.stubGlobal('window', Object.defineProperty({}, 'localStorage', { get: getter }));
    for (const invalid of [
      '',
      'other',
      'classic.records',
      '../classic',
      '__proto__',
      null,
    ] as unknown as OfflineNamespace[]) {
      expect(() => getOfflineStorageKeys(invalid)).toThrow('Unsupported offline namespace');
      expect(() => new OfflineRecords(backing, invalid)).toThrow('Unsupported offline namespace');
      expect(() => getOfflineDraftStorage(backing, invalid)).toThrow(
        'Unsupported offline namespace',
      );
      expect(() => new OfflineRecords(undefined, invalid)).toThrow('Unsupported offline namespace');
      expect(() => getOfflineDraftStorage(undefined, invalid)).toThrow(
        'Unsupported offline namespace',
      );
      expect(() => new OfflineRecords(null, invalid)).toThrow('Unsupported offline namespace');
      expect(() => getOfflineDraftStorage(null, invalid)).toThrow('Unsupported offline namespace');
    }
    expect(getter).not.toHaveBeenCalled();
    expect(backing.getItem).not.toHaveBeenCalled();
    expect(backing.setItem).not.toHaveBeenCalled();
    expect(backing.removeItem).not.toHaveBeenCalled();
  });

  it('contains corrupt new-year history and write failures without removing or changing classic data', () => {
    const backing = storage();
    const classic = new OfflineRecords(backing);
    const classicCard = classic.record(uuid(), 0)!;
    const newKeys = getOfflineStorageKeys('new-year');
    backing.setItem(newKeys.records, 'corrupt-json');
    const newYear = new OfflineRecords(backing, 'new-year');
    expect(newYear.getSnapshot().records).toEqual([]);
    expect(backing.getItem(newKeys.records)).toBeNull();
    expect(new OfflineRecords(backing).getSnapshot().records).toEqual([classicCard]);
    backing.setItem.mockImplementation((key, value) => {
      if (key === newKeys.records) throw new Error('New-year write failed');
      backing.data.set(key, value);
    });
    expect(newYear.record(uuid(), 2)).not.toBeNull();
    expect(newYear.getSnapshot().persistence).toBe('memory');
    const secondClassicCard = classic.record(uuid(), 1)!;
    expect(classic.getSnapshot().persistence).toBe('local');
    expect(new OfflineRecords(backing).getSnapshot().records).toEqual([
      secondClassicCard,
      classicCard,
    ]);
  });

  it('defaults undefined to local storage while explicit null disables new-year persistence', () => {
    const backing = storage();
    const getter = vi.fn(() => backing);
    vi.stubGlobal('window', Object.defineProperty({}, 'localStorage', { get: getter }));
    expect(new OfflineRecords(null, 'new-year').getSnapshot().persistence).toBe('memory');
    expect(getOfflineDraftStorage(null, 'new-year')).toBeNull();
    expect(getter).not.toHaveBeenCalled();
    const newYear = new OfflineRecords(undefined, 'new-year');
    const card = newYear.record(uuid(), 1)!;
    expect(newYear.getSnapshot().persistence).toBe('local');
    expect(JSON.parse(backing.getItem(getOfflineStorageKeys('new-year').records)!).records).toEqual(
      [card],
    );
    const ready = postReducer(createPostState(uuid()), { type: 'LOADED' });
    expect(savePostDraft(getOfflineDraftStorage(undefined, 'new-year'), ready, 2)).toBe(true);
    expect(backing.getItem(getOfflineStorageKeys('new-year').draft)).not.toBeNull();
    expect(backing.getItem(offlineRecordsKey)).toBeNull();
    expect(backing.getItem(offlineDraftKey)).toBeNull();
  });
});
