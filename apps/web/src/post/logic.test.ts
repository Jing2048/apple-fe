import { describe, expect, it } from 'vitest';
import { activeStarIds, createPostState, postReducer } from './logic';

function started() {
  return postReducer(postReducer(createPostState('round'), { type: 'LOADED' }), {
    type: 'START',
    now: 100,
  });
}

describe('cloud post journey', () => {
  it('collects six stars in three pairs, allowing either order within a pair', () => {
    let state = started();
    expect(activeStarIds(state)).toEqual([0, 1]);
    for (const [index, cell] of [1, 0, 3, 2, 4, 5].entries()) {
      state = postReducer(state, { type: 'COLLECT', cell, now: 200 + index * 100 });
    }
    expect(state).toMatchObject({
      phase: 'completed',
      steps: 6,
      target: 6,
      interaction: 'swipe',
      activeMs: 600,
    });
    expect(state.collected).toEqual([1, 0, 3, 2, 4, 5]);
    expect(activeStarIds(state)).toEqual([]);
    expect(postReducer(state, { type: 'COLLECT', cell: 5, now: 1_000 })).toBe(state);
  });

  it('rejects skipping groups, duplicate collection and generic timing hits', () => {
    let state = started();
    expect(postReducer(state, { type: 'COLLECT', cell: 2, now: 200 })).toBe(state);
    expect(postReducer(state, { type: 'HIT', now: 200 })).toBe(state);
    state = postReducer(state, { type: 'COLLECT', cell: 0, now: 200 });
    expect(activeStarIds(state)).toEqual([1]);
    expect(postReducer(state, { type: 'COLLECT', cell: 0, now: 201 })).toBe(state);
    expect(postReducer(state, { type: 'COLLECT', cell: 3, now: 202 })).toBe(state);
    expect(state.steps).toBe(1);
  });

  it('excludes paused duration and requires explicit resume before collecting', () => {
    let state = started();
    state = postReducer(state, { type: 'COLLECT', cell: 0, now: 200 });
    state = postReducer(state, { type: 'PAUSE', now: 300 });
    expect(postReducer(state, { type: 'COLLECT', cell: 1, now: 400 })).toBe(state);
    state = postReducer(state, { type: 'RESUME', now: 10_000 });
    state = postReducer(state, { type: 'COLLECT', cell: 1, now: 10_100 });
    expect(state.hitTimes).toEqual([100, 300]);
    expect(activeStarIds(state)).toEqual([2, 3]);
  });

  it('creates a clean six-star round on reset and cannot switch to timing', () => {
    let state = postReducer(started(), { type: 'COLLECT', cell: 0, now: 200 });
    expect(postReducer(state, { type: 'SELECT', interaction: 'timing', roundId: 'other' })).toBe(
      state,
    );
    state = postReducer(state, { type: 'RESET', roundId: 'fresh' });
    expect(state).toMatchObject({
      phase: 'ready',
      roundId: 'fresh',
      interaction: 'swipe',
      target: 6,
      steps: 0,
      collected: [],
    });
  });

  it('restores a paused journey only during loading without restarting it', () => {
    let paused = postReducer(started(), { type: 'COLLECT', cell: 0, now: 200 });
    paused = postReducer(paused, { type: 'PAUSE', now: 300 });
    const restored = postReducer(createPostState('new'), { type: 'RESTORE', state: paused });
    expect(restored).toBe(paused);
    expect(postReducer(restored, { type: 'COLLECT', cell: 1, now: 5_000 })).toBe(restored);
    expect(postReducer(createPostState('new'), { type: 'RESTORE', state: started() }).phase).toBe(
      'loading',
    );
  });
});
