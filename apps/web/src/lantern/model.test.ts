import { describe, expect, it } from 'vitest';
import {
  createLanternState,
  isLanternState,
  lanternReducer,
  normalizeWish,
  type LanternColor,
  type LanternPattern,
} from './model';

const id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const begin = () =>
  lanternReducer(
    lanternReducer(createLanternState(id), { type: 'SET_WISH', value: '愿家人平安' }),
    { type: 'START' },
  );

describe('paper lantern pure flow', () => {
  it('creates a deterministic initial state and requires a nonempty wish', () => {
    const initial = createLanternState(id.toUpperCase());
    expect(initial).toEqual({
      id,
      phase: 'wish',
      wish: '',
      openProgress: 0,
      color: 'red',
      pattern: 'blossom',
    });
    expect(() => createLanternState('not-an-id')).toThrow('UUID');
    expect(lanternReducer(initial, { type: 'START' })).toBe(initial);
    const whitespace = lanternReducer(initial, { type: 'SET_WISH', value: '   ' });
    expect(lanternReducer(whitespace, { type: 'START' })).toBe(whitespace);
    for (const action of [
      { type: 'PREPARE' },
      { type: 'RELEASE' },
      { type: 'FINISH_FLIGHT' },
    ] as const)
      expect(lanternReducer(initial, action)).toBe(initial);
  });

  it('preserves editing spaces, normalizes NFC at start and counts Unicode codepoints', () => {
    const editing = lanternReducer(createLanternState(id), {
      type: 'SET_WISH',
      value: '  e\u0301 \n 平安\u0000\u202e  ',
    });
    expect(editing.wish.endsWith(' ')).toBe(true);
    expect(editing.wish).toContain('e\u0301');
    expect(lanternReducer(editing, { type: 'START' }).wish).toBe('é 平安');
    expect(normalizeWish('  愿\t你\n平安  ')).toBe('愿 你 平安');
    const emojis = lanternReducer(createLanternState(id), {
      type: 'SET_WISH',
      value: '🐉'.repeat(33),
    });
    expect(Array.from(emojis.wish)).toHaveLength(32);
    expect(emojis.wish.length).toBe(64);
    expect(lanternReducer(emojis, { type: 'START' }).phase).toBe('unfold');
    expect(normalizeWish('🐉'.repeat(33))).toBe('🐉'.repeat(33));
    expect(normalizeWish('\ud800\u0000')).toBe('');
    expect(normalizeWish('👩‍👩‍👧‍👦')).toBe('👩‍👩‍👧‍👦');
    expect(Array.from(normalizeWish('👩‍👩‍👧‍👦'))).toHaveLength(7);
    const invisible = lanternReducer(createLanternState(id), {
      type: 'SET_WISH',
      value: '\u200c\u200d',
    });
    expect(lanternReducer(invisible, { type: 'START' })).toBe(invisible);
    const plain = '<b>愿你平安</b>';
    expect(normalizeWish(plain)).toBe(plain);
  });

  it('accumulates finite unfold progress monotonically without implicit confirmation', () => {
    const started = begin();
    const partial = lanternReducer(started, { type: 'OPEN_PROGRESS', progress: 0.3 });
    expect(partial.phase).toBe('unfold');
    for (const progress of [0.1, -1, Number.NaN, Number.POSITIVE_INFINITY])
      expect(lanternReducer(partial, { type: 'OPEN_PROGRESS', progress })).toBe(partial);
    expect(lanternReducer(partial, { type: 'CONFIRM_OPEN' })).toBe(partial);
    const complete = lanternReducer(partial, { type: 'OPEN_PROGRESS', progress: 2 });
    expect(complete.openProgress).toBe(1);
    expect(complete.phase).toBe('unfold');
    expect(lanternReducer(complete, { type: 'CONFIRM_OPEN' }).phase).toBe('decorate');
    expect(lanternReducer(started, { type: 'OPEN' })).toMatchObject({
      phase: 'decorate',
      openProgress: 1,
    });
  });

  it('limits decoration to its phase and makes release and flight completion idempotent', () => {
    const started = begin();
    expect(lanternReducer(started, { type: 'SET_COLOR', color: 'ivory' })).toBe(started);
    let decorated = lanternReducer(started, { type: 'OPEN' });
    expect(lanternReducer(decorated, { type: 'SET_COLOR', color: 'blue' as LanternColor })).toBe(
      decorated,
    );
    expect(
      lanternReducer(decorated, { type: 'SET_PATTERN', pattern: 'unknown' as LanternPattern }),
    ).toBe(decorated);
    decorated = lanternReducer(lanternReducer(decorated, { type: 'SET_COLOR', color: 'apricot' }), {
      type: 'SET_PATTERN',
      pattern: 'ripple',
    });
    const launch = lanternReducer(decorated, { type: 'PREPARE' });
    expect(lanternReducer(launch, { type: 'FINISH_FLIGHT' })).toBe(launch);
    expect(lanternReducer(launch, { type: 'SET_WISH', value: 'cannot change' })).toBe(launch);
    expect(lanternReducer(launch, { type: 'SET_COLOR', color: 'red' })).toBe(launch);
    const flying = lanternReducer(launch, { type: 'RELEASE' });
    expect(lanternReducer(flying, { type: 'RELEASE' })).toBe(flying);
    const keepsake = lanternReducer(flying, { type: 'FINISH_FLIGHT' });
    expect(keepsake).toMatchObject({
      id,
      phase: 'keepsake',
      wish: '愿家人平安',
      color: 'apricot',
      pattern: 'ripple',
    });
    expect(lanternReducer(keepsake, { type: 'FINISH_FLIGHT' })).toBe(keepsake);
    expect(createLanternState('bbbbbbbb-cccc-4ddd-8eee-ffffffffffff').phase).toBe('wish');
  });

  it('rejects impossible or overlong persisted states rather than normalizing corrupt input', () => {
    const unfolded = begin();
    expect(isLanternState(unfolded)).toBe(true);
    for (const value of [
      { ...unfolded, wish: '🐉'.repeat(33) },
      { ...unfolded, wish: '  平安 ' },
      { ...unfolded, wish: '平安\u0000' },
      { ...unfolded, phase: 'decorate', openProgress: 0.2 },
      { ...unfolded, openProgress: Number.NaN },
      { ...unfolded, openProgress: -1 },
      { ...unfolded, id: 'invalid' },
      { ...unfolded, camera: 'not-a-field' },
    ])
      expect(isLanternState(value)).toBe(false);
  });
});
