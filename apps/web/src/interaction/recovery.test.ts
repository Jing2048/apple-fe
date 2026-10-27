import { describe, expect, it } from 'vitest';
import { createInteractionState, interactionReducer } from './machine';
import { forgetRound, recoverRound, recoveryKey, rememberRound } from './recovery';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}

describe('completed-round recovery', () => {
  it('restores the same idempotency key and local summary without identity or analytics', () => {
    const storage = memoryStorage();
    let state = interactionReducer(createInteractionState('4baee274-67bc-452b-93cb-cfaad8a5c34e'), {
      type: 'LOADED',
    });
    state = interactionReducer(state, { type: 'START', now: 100 });
    for (const now of [200, 300, 400]) state = interactionReducer(state, { type: 'HIT', now });
    expect(rememberRound(storage, state)).toBe(true);
    expect(recoverRound(storage)).toMatchObject({
      phase: 'completed',
      roundId: state.roundId,
      activeMs: 300,
      steps: 3,
    });
    expect(Object.keys(JSON.parse(storage.getItem(recoveryKey) ?? '{}')).sort()).toEqual([
      'activeMs',
      'hitTimes',
      'interaction',
      'roundId',
      'version',
    ]);
    forgetRound(storage);
    expect(recoverRound(storage)).toBe(null);
  });
  it('discards corrupted, stale and invalid round snapshots', () => {
    const storage = memoryStorage();
    for (const value of [
      'invalid-json',
      '{"version":0}',
      JSON.stringify({
        version: 1,
        roundId: '4baee274-67bc-452b-93cb-cfaad8a5c34e',
        interaction: 'timing',
        activeMs: -1,
        hitTimes: [0, 1, 2],
      }),
    ]) {
      storage.setItem(recoveryKey, value);
      expect(recoverRound(storage)).toBe(null);
      expect(storage.getItem(recoveryKey)).toBe(null);
    }
  });
  it('tolerates unavailable or disabled browser storage', () => {
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
    expect(recoverRound(denied)).toBe(null);
    expect(recoverRound(null)).toBe(null);
    expect(() => forgetRound(denied)).not.toThrow();
    expect(rememberRound(denied, { ...createInteractionState('round'), phase: 'completed' })).toBe(
      false,
    );
  });
});
