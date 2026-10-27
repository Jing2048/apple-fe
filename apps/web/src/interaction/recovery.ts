import { createInteractionState, type InteractionState } from './machine';

export const recoveryKey = 'campaign-lab.completed-round.v1';
type RecoveryStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export function rememberRound(storage: RecoveryStorage | null, state: InteractionState): boolean {
  if (!storage || state.phase !== 'completed') return false;
  try {
    storage.setItem(
      recoveryKey,
      JSON.stringify({
        version: 1,
        roundId: state.roundId,
        interaction: state.interaction,
        activeMs: state.activeMs,
        hitTimes: state.hitTimes,
      }),
    );
    return true;
  } catch {
    return false;
  }
}

export function forgetRound(storage: RecoveryStorage | null): void {
  try {
    storage?.removeItem(recoveryKey);
  } catch {
    /* Storage is optional; gameplay remains usable. */
  }
}

/** Stored state is a local draft, never proof of a server-side business outcome. */
export function recoverRound(storage: RecoveryStorage | null): InteractionState | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(recoveryKey);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) throw new Error('Invalid recovery');
    const value = parsed as Record<string, unknown>;
    if (
      value.version !== 1 ||
      typeof value.roundId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        value.roundId,
      ) ||
      (value.interaction !== 'timing' && value.interaction !== 'swipe') ||
      typeof value.activeMs !== 'number' ||
      !Number.isFinite(value.activeMs) ||
      value.activeMs < 0 ||
      value.activeMs > 3_600_000 ||
      !Array.isArray(value.hitTimes) ||
      value.hitTimes.length !== 3 ||
      value.hitTimes.some(
        (time: unknown, index: number, all: unknown[]) =>
          typeof time !== 'number' ||
          !Number.isFinite(time) ||
          time < 0 ||
          time > Number(value.activeMs) ||
          (index > 0 && time < Number(all[index - 1])),
      )
    )
      throw new Error('Invalid recovery');
    return {
      ...createInteractionState(value.roundId.toLowerCase()),
      phase: 'completed',
      interaction: value.interaction,
      activeMs: value.activeMs,
      hitTimes: value.hitTimes as number[],
      steps: 3,
      collected: value.interaction === 'swipe' ? [0, 1, 2] : [],
    };
  } catch {
    forgetRound(storage);
    return null;
  }
}

export function sessionStorageOrNull(): RecoveryStorage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}
