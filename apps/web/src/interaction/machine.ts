export type Interaction = 'timing' | 'swipe';
export type Phase = 'loading' | 'ready' | 'playing' | 'paused' | 'completed' | 'error';

export interface InteractionState {
  phase: Phase;
  interaction: Interaction;
  roundId: string;
  steps: number;
  target: number;
  activeMs: number;
  resumedAt: number | null;
  hitTimes: number[];
  collected: number[];
  error: string | null;
}

export type InteractionAction =
  | { type: 'LOADED' }
  | { type: 'RESTORE'; state: InteractionState }
  | { type: 'LOAD_FAILED'; message: string }
  | { type: 'RETRY' }
  | { type: 'SELECT'; interaction: Interaction; roundId: string }
  | { type: 'START'; now: number }
  | { type: 'HIT'; now: number }
  | { type: 'COLLECT'; cell: number; now: number }
  | { type: 'PAUSE'; now: number }
  | { type: 'RESUME'; now: number }
  | { type: 'RESET'; roundId: string };

export function createInteractionState(roundId: string, target = 3): InteractionState {
  if (!Number.isInteger(target) || target < 1 || target > 100)
    throw new Error('Invalid interaction target');
  return {
    phase: 'loading',
    interaction: 'timing',
    roundId,
    steps: 0,
    target,
    activeMs: 0,
    resumedAt: null,
    hitTimes: [],
    collected: [],
    error: null,
  };
}

function elapsed(state: InteractionState, now: number): number {
  return Math.max(
    state.hitTimes.at(-1) ?? 0,
    state.activeMs + (state.resumedAt === null ? 0 : Math.max(0, now - state.resumedAt)),
  );
}

function hit(state: InteractionState, now: number): InteractionState {
  const activeMs = elapsed(state, now);
  const steps = state.steps + 1;
  return {
    ...state,
    steps,
    hitTimes: [...state.hitTimes, activeMs],
    phase: steps >= state.target ? 'completed' : 'playing',
    activeMs: steps >= state.target ? activeMs : state.activeMs,
    resumedAt: steps >= state.target ? null : state.resumedAt,
  };
}

export function interactionReducer(
  state: InteractionState,
  action: InteractionAction,
): InteractionState {
  if ('now' in action && (!Number.isFinite(action.now) || action.now < 0)) return state;
  switch (action.type) {
    case 'LOADED':
      return state.phase === 'loading' ? { ...state, phase: 'ready', error: null } : state;
    case 'RESTORE':
      return state.phase === 'loading' && action.state.phase === 'completed' ? action.state : state;
    case 'LOAD_FAILED':
      return state.phase === 'loading'
        ? { ...state, phase: 'error', error: action.message }
        : state;
    case 'RETRY':
      return state.phase === 'error' ? { ...state, phase: 'loading', error: null } : state;
    case 'SELECT':
      if (state.phase === 'loading' || state.phase === 'error') return state;
      return {
        ...createInteractionState(action.roundId, state.target),
        interaction: action.interaction,
        phase: 'ready',
      };
    case 'START':
      return state.phase === 'ready'
        ? { ...state, phase: 'playing', resumedAt: action.now }
        : state;
    case 'COLLECT':
      if (
        state.interaction !== 'swipe' ||
        state.phase !== 'playing' ||
        !Number.isInteger(action.cell) ||
        action.cell < 0 ||
        action.cell >= state.target ||
        state.collected.includes(action.cell)
      )
        return state;
      return {
        ...hit(state, action.now),
        collected: [...state.collected, action.cell],
      };
    case 'HIT': {
      if (state.phase !== 'playing' || state.interaction !== 'timing') return state;
      return hit(state, action.now);
    }
    case 'PAUSE':
      return state.phase === 'playing'
        ? { ...state, phase: 'paused', activeMs: elapsed(state, action.now), resumedAt: null }
        : state;
    case 'RESUME':
      return state.phase === 'paused'
        ? { ...state, phase: 'playing', resumedAt: action.now }
        : state;
    case 'RESET':
      if (state.phase === 'loading' || state.phase === 'error') return state;
      return {
        ...createInteractionState(action.roundId, state.target),
        interaction: state.interaction,
        phase: 'ready',
      };
  }
}
