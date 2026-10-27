import { describe, expect, it } from 'vitest';
import { crossedTargets } from './pointer';
import { createInteractionState, interactionReducer } from './machine';

describe('pointer collection', () => {
  const targets = [0, 1, 2].map((id) => ({ id, x: id * 100, y: 50, radius: 20 }));
  it('collects cells crossed by a fast movement and ignores a distant path', () => {
    expect(crossedTargets({ x: -30, y: 50 }, { x: 230, y: 50 }, targets)).toEqual([0, 1, 2]);
    expect(crossedTargets({ x: -30, y: 100 }, { x: 230, y: 100 }, targets)).toEqual([]);
  });
  it('handles stationary pointer positions without division errors', () => {
    expect(crossedTargets({ x: 100, y: 50 }, { x: 100, y: 50 }, targets)).toEqual([1]);
  });
  it('includes tangent boundary contact', () => {
    expect(crossedTargets({ x: -30, y: 70 }, { x: 30, y: 70 }, targets)).toEqual([0]);
  });
  it('preserves crossed sets under direction reversal and segment subdivision', () => {
    let seed = 0x5f21;
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 0x1_0000_0000;
    };
    for (let index = 0; index < 1_000; index += 1) {
      const from = { x: random() * 400 - 100, y: random() * 200 - 50 };
      const to = { x: random() * 400 - 100, y: random() * 200 - 50 };
      const t = random();
      const middle = { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
      const whole = crossedTargets(from, to, targets);
      expect(crossedTargets(to, from, targets)).toEqual(whole);
      expect(
        [
          ...new Set([
            ...crossedTargets(from, middle, targets),
            ...crossedTargets(middle, to, targets),
          ]),
        ].sort(),
      ).toEqual(whole);
    }
  });
  it('counts a cell once and ignores collection while paused', () => {
    let state = interactionReducer(createInteractionState('round'), { type: 'LOADED' });
    state = interactionReducer(state, { type: 'SELECT', interaction: 'swipe', roundId: 'swipe' });
    state = interactionReducer(state, { type: 'START', now: 0 });
    state = interactionReducer(state, { type: 'COLLECT', cell: 0, now: 100 });
    expect(interactionReducer(state, { type: 'COLLECT', cell: 0, now: 200 })).toBe(state);
    state = interactionReducer(state, { type: 'PAUSE', now: 300 });
    expect(interactionReducer(state, { type: 'COLLECT', cell: 1, now: 400 })).toBe(state);
    expect(state.steps).toBe(1);
  });
});
