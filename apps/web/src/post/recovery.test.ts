import { describe, expect, it } from 'vitest';
import { createPostState, postReducer } from './logic';
import { clearPostDraft, postRecoveryKey, readPostDraft, savePostDraft } from './recovery';

const roundId = 'CD4E20CB-908B-4FB5-AAD8-D2AAD10598AB';

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
    removeItem: (key: string) => {
      data.delete(key);
    },
  };
}

function started() {
  return postReducer(postReducer(createPostState(roundId), { type: 'LOADED' }), {
    type: 'START',
    now: 100,
  });
}

describe('cloud post local draft', () => {
  it('restores an unfinished round as paused with the same canonical key and blessing', () => {
    const storage = memoryStorage();
    let state = started();
    state = postReducer(state, { type: 'COLLECT', cell: 1, now: 200 });
    expect(savePostDraft(storage, state, 2)).toBe(true);
    const draft = readPostDraft(storage);
    expect(draft).toMatchObject({
      blessingIndex: 2,
      state: {
        roundId: roundId.toLowerCase(),
        phase: 'paused',
        steps: 1,
        activeMs: 100,
        resumedAt: null,
      },
    });
    expect(draft?.state.collected).toEqual([1]);
    expect(Object.keys(JSON.parse(storage.getItem(postRecoveryKey) ?? '{}')).sort()).toEqual([
      'activeMs',
      'blessingIndex',
      'collected',
      'hitTimes',
      'phase',
      'roundId',
      'version',
    ]);
  });

  it('retains a completed round key and all six stars for safe service confirmation', () => {
    const storage = memoryStorage();
    let state = started();
    for (let cell = 0; cell < 6; cell += 1)
      state = postReducer(state, { type: 'COLLECT', cell, now: 200 + cell * 100 });
    expect(savePostDraft(storage, state, 1)).toBe(true);
    expect(readPostDraft(storage)).toMatchObject({
      blessingIndex: 1,
      state: { phase: 'completed', roundId: roundId.toLowerCase(), steps: 6, activeMs: 600 },
    });
    clearPostDraft(storage);
    expect(readPostDraft(storage)).toBe(null);
  });

  it('keeps an unstarted round ready and rejects loading or invalid blessing drafts', () => {
    const storage = memoryStorage();
    expect(savePostDraft(storage, createPostState(roundId), 0)).toBe(false);
    const ready = postReducer(createPostState(roundId), { type: 'LOADED' });
    expect(savePostDraft(storage, ready, 0)).toBe(true);
    expect(readPostDraft(storage)?.state.phase).toBe('ready');
    expect(savePostDraft(storage, ready, 3)).toBe(false);
  });

  it('discards corrupt, out-of-order, impossible and oversized snapshots', () => {
    const storage = memoryStorage();
    const valid = {
      version: 1,
      roundId,
      collected: [0],
      activeMs: 100,
      hitTimes: [100],
      phase: 'playing',
      blessingIndex: 0,
    };
    const cases = [
      'invalid-json',
      JSON.stringify({ ...valid, version: 0 }),
      JSON.stringify({ ...valid, collected: [2] }),
      JSON.stringify({ ...valid, collected: [0, 0], hitTimes: [1, 2] }),
      JSON.stringify({ ...valid, collected: [0, 1], hitTimes: [50, 20] }),
      JSON.stringify({ ...valid, activeMs: -1 }),
      JSON.stringify({ ...valid, phase: 'completed' }),
      JSON.stringify({ ...valid, phase: 'ready' }),
      JSON.stringify({ ...valid, email: 'not-part-of-a-draft@example.invalid' }),
      'x'.repeat(4_097),
    ];
    for (const value of cases) {
      storage.setItem(postRecoveryKey, value);
      expect(readPostDraft(storage)).toBe(null);
      expect(storage.getItem(postRecoveryKey)).toBe(null);
    }
  });

  it('tolerates disabled browser storage without breaking the journey', () => {
    const denied = {
      getItem: () => {
        throw new Error('Denied');
      },
      setItem: () => {
        throw new Error('Denied');
      },
      removeItem: () => {
        throw new Error('Denied');
      },
    };
    expect(readPostDraft(denied)).toBe(null);
    expect(readPostDraft(null)).toBe(null);
    expect(savePostDraft(denied, started(), 0)).toBe(false);
    expect(savePostDraft(null, started(), 0)).toBe(false);
    expect(() => clearPostDraft(denied)).not.toThrow();
  });
});
