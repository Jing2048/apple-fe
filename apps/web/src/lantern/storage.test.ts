import { afterEach, describe, expect, it, vi } from 'vitest';
import { uuid } from '../uuid';
import { createLanternState, lanternReducer, type LanternState } from './model';
import { LanternStore, lanternCardsKey, lanternDraftKey, type LanternStorage } from './storage';

function memoryStorage() {
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

function keepsake(id = uuid()): LanternState {
  let state = lanternReducer(createLanternState(id), { type: 'SET_WISH', value: '愿家人平安' });
  for (const action of [
    { type: 'START' },
    { type: 'OPEN' },
    { type: 'PREPARE' },
    { type: 'RELEASE' },
    { type: 'FINISH_FLIGHT' },
  ] as const)
    state = lanternReducer(state, action);
  return state;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('paper lantern local storage only', () => {
  it('restores partial unfolding and converts interrupted flight to a keepsake exactly once', () => {
    const backing = memoryStorage();
    const store = new LanternStore(backing);
    let state = keepsake();
    state = { ...state, phase: 'unfold', openProgress: 0.4 };
    expect(store.saveDraft(state)).toBe(true);
    expect(new LanternStore(backing).readDraft()).toEqual(state);
    const flight = { ...state, phase: 'flying', openProgress: 1 } as LanternState;
    expect(store.saveDraft(flight)).toBe(true);
    const restored = new LanternStore(backing);
    const finished = restored.readDraft()!;
    expect(finished).toEqual({ ...flight, phase: 'keepsake' });
    const first = restored.saveCard(finished);
    expect(first).not.toBeNull();
    expect(restored.saveCard(finished)).toBe(first);
    const again = new LanternStore(backing);
    expect(again.saveCard(again.readDraft()!)).toEqual(first);
    expect(again.getSnapshot().cards).toHaveLength(1);
    const mutable = restored.readDraft()!;
    mutable.wish = 'changed outside store';
    expect(restored.readDraft()?.wish).toBe('愿家人平安');
  });

  it('preserves immutable card identity/time and rejects same-ID content changes', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-27T12:00:00.000Z'));
    const backing = memoryStorage();
    const store = new LanternStore(backing);
    const state = keepsake();
    expect(store.saveCard({ ...state, phase: 'flying' })).toBeNull();
    const first = store.saveCard(state)!;
    const snapshot = store.getSnapshot();
    vi.setSystemTime(new Date('2026-10-28T12:00:00.000Z'));
    expect(store.saveCard({ ...state, id: state.id.toUpperCase() })).toBe(first);
    for (const conflict of [
      { ...state, wish: '不同的心愿' },
      { ...state, color: 'ivory' },
      { ...state, pattern: 'window' },
    ] as LanternState[])
      expect(store.saveCard(conflict)).toBeNull();
    expect(store.getSnapshot()).toBe(snapshot);
    expect(new LanternStore(backing).getSnapshot().cards).toEqual([first]);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.keys(first).sort()).toEqual(['color', 'createdAt', 'id', 'pattern', 'wish']);
  });

  it('retains ten cards in insertion order despite clock rollback', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2027-01-01T00:00:00.000Z'));
    const backing = memoryStorage();
    const store = new LanternStore(backing);
    const prior = Array.from({ length: 10 }, () => store.saveCard(keepsake())!);
    vi.setSystemTime(new Date('2026-10-27T00:00:00.000Z'));
    const latest = store.saveCard(keepsake())!;
    expect(store.getSnapshot().cards).toEqual([latest, ...prior.slice(1).reverse()]);
    expect(new LanternStore(backing).getSnapshot().cards).toEqual(store.getSnapshot().cards);
  });

  it('discards invalid, oversized or impossible drafts and card lists without repairing content', () => {
    const backing = memoryStorage();
    const state = keepsake();
    const validCard = {
      id: state.id,
      wish: state.wish,
      color: state.color,
      pattern: state.pattern,
      createdAt: '2026-10-27T00:00:00.000Z',
    };
    const invalidDrafts = [
      'broken-json',
      JSON.stringify({ version: 2, state }),
      JSON.stringify({ version: 1, state: { ...state, wish: '🐉'.repeat(33) } }),
      JSON.stringify({ version: 1, state: { ...state, wish: ' 不要自动修复 ' } }),
      JSON.stringify({ version: 1, state: { ...state, phase: 'decorate', openProgress: 0.1 } }),
      JSON.stringify({ version: 1, state: { ...state, extra: true } }),
      'x'.repeat(2049),
    ];
    const invalidCards = [
      'broken-json',
      JSON.stringify({ version: 2, cards: [validCard] }),
      ...[
        { ...validCard, wish: '🐉'.repeat(33) },
        { ...validCard, color: 'blue' },
        { ...validCard, pattern: 'unknown' },
        { ...validCard, createdAt: '2026-02-30T00:00:00.000Z' },
        { ...validCard, id: 'invalid' },
        { ...validCard, camera: true },
      ].map((card) => JSON.stringify({ version: 1, cards: [card] })),
      JSON.stringify({
        version: 1,
        cards: [validCard, { ...validCard, id: validCard.id.toUpperCase() }],
      }),
      JSON.stringify({
        version: 1,
        cards: Array.from({ length: 11 }, () => ({ ...validCard, id: uuid() })),
      }),
      'x'.repeat(8193),
    ];
    backing.setItem('cloud-post.offline.v1.records', 'unrelated-classic');
    for (const raw of invalidDrafts) {
      backing.setItem(lanternDraftKey, raw);
      expect(new LanternStore(backing).readDraft()).toBeNull();
      expect(backing.getItem(lanternDraftKey)).toBeNull();
    }
    for (const raw of invalidCards) {
      backing.setItem(lanternCardsKey, raw);
      expect(new LanternStore(backing).getSnapshot().cards).toEqual([]);
    }
    expect(backing.getItem('cloud-post.offline.v1.records')).toBe('unrelated-classic');
  });

  it('falls back to memory after write failure and never fabricates persistence', () => {
    const backing = memoryStorage();
    const store = new LanternStore(backing);
    const state = keepsake();
    backing.setItem.mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    expect(store.saveDraft(state)).toBe(false);
    expect(store.readDraft()).toEqual(state);
    expect(store.getSnapshot().persistence).toBe('memory');
    const writes = backing.setItem.mock.calls.length;
    expect(store.saveCard(state)).not.toBeNull();
    expect(backing.setItem.mock.calls).toHaveLength(writes);
    expect(store.getSnapshot().cards).toHaveLength(1);
    const silent = new LanternStore({
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    });
    expect(silent.getSnapshot().persistence).toBe('memory');
  });

  it('clears only lantern keys and reports failed persistent deletion while clearing memory', () => {
    const backing = memoryStorage();
    const unrelated = [
      'cloud-post.offline.v1.records',
      'cloud-post.offline.new-year.v1.draft',
      'campaign-cloud-post.round.v1',
    ];
    for (const key of unrelated) backing.setItem(key, 'keep');
    const store = new LanternStore(backing);
    const state = keepsake();
    store.saveDraft(state);
    store.saveCard(state);
    store.clear();
    expect(store.readDraft()).toBeNull();
    expect(store.getSnapshot()).toEqual({ cards: [], persistence: 'local' });
    expect(backing.getItem(lanternDraftKey)).toBeNull();
    expect(backing.getItem(lanternCardsKey)).toBeNull();
    for (const key of unrelated) expect(backing.getItem(key)).toBe('keep');
    store.saveDraft(state);
    store.saveCard(state);
    backing.removeItem.mockImplementation(() => {
      throw new Error('Denied');
    });
    store.clear();
    expect(store.getSnapshot()).toEqual({ cards: [], persistence: 'memory' });
    expect(store.readDraft()).toBeNull();
    expect(backing.getItem(lanternDraftKey)).not.toBeNull();
  });

  it('keeps stable snapshots, skips no-op notifications and rejects invalid save input', () => {
    const store = new LanternStore(null);
    const changed = vi.fn();
    const off = store.subscribe(changed);
    const state = keepsake();
    const initial = store.getSnapshot();
    expect(store.getSnapshot()).toBe(initial);
    expect(store.saveDraft(state)).toBe(false);
    expect(store.getSnapshot()).toBe(initial);
    const card = store.saveCard(state);
    expect(store.saveCard(state)).toBe(card);
    expect(store.saveDraft({ ...state, wish: 'x'.repeat(33) })).toBe(false);
    expect(store.readDraft()).toEqual(state);
    store.clear();
    expect(changed).toHaveBeenCalledTimes(2);
    off();
    store.saveCard(state);
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it('handles denied getters or explicit null without accessing devices or networking', () => {
    const getter = vi.fn(() => {
      throw new Error('SecurityError');
    });
    vi.stubGlobal('window', Object.defineProperty({}, 'localStorage', { get: getter }));
    const request = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No network'));
    const disabled = new LanternStore(null);
    expect(getter).not.toHaveBeenCalled();
    const unavailable = new LanternStore();
    expect(unavailable.getSnapshot().persistence).toBe('memory');
    expect(unavailable.saveCard(keepsake())).not.toBeNull();
    const denied = Object.defineProperty({}, 'getItem', {
      get: () => {
        throw new Error('Denied method getter');
      },
    }) as LanternStorage;
    expect(new LanternStore(denied).getSnapshot().persistence).toBe('memory');
    expect(() => disabled.clear()).not.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
});
