import {
  createInteractionState,
  interactionReducer,
  type InteractionAction,
  type InteractionState,
} from '../interaction/machine';

export const POST_STAR_COUNT = 6;

/** Percent coordinates keep the same three little journeys on narrow and wide screens. */
export const STAR_GROUPS = [
  {
    label: '第一缕晨光',
    hint: '先收集两颗小小的勇气',
    stars: [
      { id: 0, x: 28, y: 32 },
      { id: 1, x: 72, y: 41 },
    ],
  },
  {
    label: '云间的好运',
    hint: '再收下一点慢慢来的好运',
    stars: [
      { id: 2, x: 35, y: 24 },
      { id: 3, x: 75, y: 55 },
    ],
  },
  {
    label: '晚风里的祝福',
    hint: '最后，让星光找到要去的地方',
    stars: [
      { id: 4, x: 25, y: 54 },
      { id: 5, x: 66, y: 27 },
    ],
  },
] as const;

export function createPostState(roundId: string): InteractionState {
  return { ...createInteractionState(roundId, POST_STAR_COUNT), interaction: 'swipe' };
}

export function activeStarIds(state: InteractionState): number[] {
  if (state.phase === 'completed') return [];
  const group = STAR_GROUPS[Math.floor(state.steps / 2)];
  return group?.stars.map((star) => star.id).filter((id) => !state.collected.includes(id)) ?? [];
}

export function postReducer(state: InteractionState, action: InteractionAction): InteractionState {
  if (action.type === 'SELECT') return state;
  if (action.type === 'COLLECT' && !activeStarIds(state).includes(action.cell)) return state;
  if (action.type === 'RESTORE') {
    const restored = action.state;
    const restorablePhase =
      restored.phase === 'ready' || restored.phase === 'paused' || restored.phase === 'completed';
    if (
      state.phase !== 'loading' ||
      !restorablePhase ||
      restored.target !== POST_STAR_COUNT ||
      restored.interaction !== 'swipe' ||
      restored.resumedAt !== null ||
      restored.steps !== restored.collected.length ||
      (restored.phase === 'completed'
        ? restored.steps !== POST_STAR_COUNT
        : restored.steps >= POST_STAR_COUNT)
    ) {
      return state;
    }
    return restored;
  }
  return interactionReducer(state, action);
}
