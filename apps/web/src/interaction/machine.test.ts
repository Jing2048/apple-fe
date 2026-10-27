import { describe, expect, it } from 'vitest';
import { createInteractionState, interactionReducer, type InteractionAction } from './machine';

describe('interaction state machine', () => {
  it('does not accept input before loading or after completion', () => {
    const loading = createInteractionState('round');
    expect(interactionReducer(loading, { type: 'HIT', now: 10 })).toBe(loading);
    let state = interactionReducer(loading, { type: 'LOADED' });
    state = interactionReducer(state, { type: 'START', now: 100 });
    for (const now of [200, 300, 400]) state = interactionReducer(state, { type: 'HIT', now });
    expect(state.phase).toBe('completed');
    expect(state.hitTimes).toEqual([100, 200, 300]);
    expect(interactionReducer(state, { type: 'HIT', now: 500 })).toBe(state);
  });

  it('excludes background pause time and requires explicit resume', () => {
    let state = interactionReducer(createInteractionState('round'), { type: 'LOADED' });
    state = interactionReducer(state, { type: 'START', now: 100 });
    state = interactionReducer(state, { type: 'PAUSE', now: 150 });
    expect(interactionReducer(state, { type: 'HIT', now: 500 })).toBe(state);
    state = interactionReducer(state, { type: 'RESUME', now: 10_000 });
    state = interactionReducer(state, { type: 'HIT', now: 10_100 });
    expect(state.hitTimes).toEqual([150]);
  });

  it('creates a fresh round on reset and preserves the selected probe', () => {
    let state = interactionReducer(createInteractionState('old'), { type: 'LOADED' });
    state = interactionReducer(state, {
      type: 'SELECT',
      interaction: 'swipe',
      roundId: 'selected',
    });
    state = interactionReducer(state, { type: 'START', now: 0 });
    state = interactionReducer(state, { type: 'HIT', now: 100 });
    state = interactionReducer(state, { type: 'RESET', roundId: 'new' });
    expect(state).toMatchObject({ phase: 'ready', roundId: 'new', interaction: 'swipe', steps: 0 });
    expect(state.hitTimes).toEqual([]);
  });

  it('recovers failed loading only through retry and confirmed load', () => {
    let state = interactionReducer(createInteractionState('round'), {
      type: 'LOAD_FAILED',
      message: 'offline',
    });
    expect(state.phase).toBe('error');
    expect(interactionReducer(state, { type: 'START', now: 0 })).toBe(state);
    state = interactionReducer(state, { type: 'RETRY' });
    expect(state.phase).toBe('loading');
    expect(interactionReducer(state, { type: 'LOADED' }).phase).toBe('ready');
  });

  it('preserves state invariants across deterministic generated action sequences', () => {
    let seed = 0x17ac11;
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed;
    };
    let state = createInteractionState('round');
    for (let i = 0; i < 5_000; i += 1) {
      const now = random() % 10_000;
      const actions: InteractionAction[] = [
        { type: 'LOADED' },
        { type: 'START', now },
        { type: 'HIT', now },
        { type: 'PAUSE', now },
        { type: 'RESUME', now },
        { type: 'RESET', roundId: `round-${i}` },
        { type: 'SELECT', interaction: random() % 2 ? 'timing' : 'swipe', roundId: `select-${i}` },
        { type: 'COLLECT', cell: random() % 4, now },
      ];
      const action = actions[random() % actions.length];
      if (!action) throw new Error('Missing generated action');
      const before = state;
      state = interactionReducer(state, action);
      expect(state.steps).toBeGreaterThanOrEqual(0);
      expect(state.steps).toBeLessThanOrEqual(state.target);
      expect(state.activeMs).toBeGreaterThanOrEqual(0);
      expect(state.hitTimes).toHaveLength(state.steps);
      expect(
        state.hitTimes.every((time, index, all) => index === 0 || time >= (all[index - 1] ?? 0)),
      ).toBe(true);
      if ((before.phase === 'paused' || before.phase === 'completed') && action.type === 'HIT')
        expect(state).toBe(before);
    }
  });
});
