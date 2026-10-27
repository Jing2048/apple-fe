import type { InteractionState } from '../interaction/machine';
import { createPostState, POST_STAR_COUNT } from './logic';

export const postRecoveryKey = 'campaign-cloud-post.round.v1';
export type PostStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export type BlessingIndex = 0 | 1 | 2;

export interface PostDraft {
  state: InteractionState;
  blessingIndex: BlessingIndex;
}

const draftFields = new Set([
  'version',
  'roundId',
  'collected',
  'activeMs',
  'hitTimes',
  'phase',
  'blessingIndex',
]);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validDuration(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= Number.MAX_SAFE_INTEGER
  );
}

function parseDraft(raw: unknown): PostDraft | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (
    Object.keys(value).some((key) => !draftFields.has(key)) ||
    value.version !== 1 ||
    typeof value.roundId !== 'string' ||
    !uuidPattern.test(value.roundId) ||
    (value.blessingIndex !== 0 && value.blessingIndex !== 1 && value.blessingIndex !== 2) ||
    !validDuration(value.activeMs) ||
    !Array.isArray(value.collected) ||
    !Array.isArray(value.hitTimes) ||
    value.collected.length > POST_STAR_COUNT ||
    value.hitTimes.length !== value.collected.length
  )
    return null;

  const collected: unknown[] = value.collected;
  const hitTimes: unknown[] = value.hitTimes;
  if (
    new Set(collected).size !== collected.length ||
    collected.some(
      (id, index) =>
        typeof id !== 'number' ||
        !Number.isInteger(id) ||
        id < 0 ||
        id >= POST_STAR_COUNT ||
        Math.floor(id / 2) !== Math.floor(index / 2),
    ) ||
    hitTimes.some(
      (time, index) =>
        !validDuration(time) ||
        time > Number(value.activeMs) ||
        (index > 0 && time < Number(hitTimes[index - 1])),
    )
  )
    return null;

  const steps = collected.length;
  if (
    value.phase !== 'ready' &&
    value.phase !== 'playing' &&
    value.phase !== 'paused' &&
    value.phase !== 'completed'
  )
    return null;
  if (value.phase === 'ready' && (steps !== 0 || value.activeMs !== 0)) return null;
  if (value.phase === 'completed' ? steps !== POST_STAR_COUNT : steps >= POST_STAR_COUNT)
    return null;

  return {
    state: {
      ...createPostState(value.roundId.toLowerCase()),
      phase:
        value.phase === 'ready' ? 'ready' : value.phase === 'completed' ? 'completed' : 'paused',
      steps,
      collected: collected as number[],
      hitTimes: hitTimes as number[],
      activeMs: value.activeMs,
      resumedAt: null,
    },
    blessingIndex: value.blessingIndex,
  };
}

export function readPostDraft(storage: PostStorage | null): PostDraft | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(postRecoveryKey);
    if (!raw) return null;
    if (raw.length > 4_096) throw new Error('Oversized local draft');
    const draft = parseDraft(JSON.parse(raw));
    if (!draft) throw new Error('Invalid local draft');
    return draft;
  } catch {
    clearPostDraft(storage);
    return null;
  }
}

/**
 * The caller can snapshot PAUSE with performance.now() before saving a playing
 * state to retain the current active duration. This module never invents elapsed
 * wall time, and a recovered journey always waits for an explicit resume.
 */
export function savePostDraft(
  storage: PostStorage | null,
  state: InteractionState,
  blessingIndex: number,
): boolean {
  if (
    !storage ||
    state.phase === 'loading' ||
    state.phase === 'error' ||
    state.target !== POST_STAR_COUNT ||
    state.interaction !== 'swipe'
  )
    return false;
  const payload = {
    version: 1,
    roundId: state.roundId,
    collected: state.collected,
    activeMs: Math.max(state.activeMs, state.hitTimes.at(-1) ?? 0),
    hitTimes: state.hitTimes,
    phase: state.phase,
    blessingIndex,
  };
  if (!parseDraft(payload)) return false;
  try {
    storage.setItem(postRecoveryKey, JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

export function clearPostDraft(storage: PostStorage | null): void {
  try {
    storage?.removeItem(postRecoveryKey);
  } catch {
    /* Storage is optional. */
  }
}

export function getPostStorage(): PostStorage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}
