export type LanternColor = 'red' | 'apricot' | 'ivory';
export type LanternPattern = 'blossom' | 'window' | 'ripple';
export type LanternPhase = 'wish' | 'unfold' | 'decorate' | 'launch' | 'flying' | 'keepsake';
export interface LanternState {
  id: string;
  phase: LanternPhase;
  wish: string;
  openProgress: number;
  color: LanternColor;
  pattern: LanternPattern;
}
export type LanternAction =
  | { type: 'SET_WISH'; value: string }
  | { type: 'START' }
  | { type: 'OPEN_PROGRESS'; progress: number }
  | { type: 'CONFIRM_OPEN' }
  | { type: 'OPEN' }
  | { type: 'SET_COLOR'; color: LanternColor }
  | { type: 'SET_PATTERN'; pattern: LanternPattern }
  | { type: 'PREPARE' }
  | { type: 'RELEASE' }
  | { type: 'FINISH_FLIGHT' };

export const lanternWishLimit = 32;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const colors = ['red', 'apricot', 'ivory'];
const patterns = ['blossom', 'window', 'ripple'];
const phases = ['wish', 'unfold', 'decorate', 'launch', 'flying', 'keepsake'];
const stateFields = new Set(['id', 'phase', 'wish', 'openProgress', 'color', 'pattern']);

export function isLanternId(value: unknown): value is string {
  return typeof value === 'string' && uuidPattern.test(value);
}
export function isLanternColor(value: unknown): value is LanternColor {
  return typeof value === 'string' && colors.includes(value);
}
export function isLanternPattern(value: unknown): value is LanternPattern {
  return typeof value === 'string' && patterns.includes(value);
}

function editableWish(value: string): string {
  return value
    .replace(/[\r\n\t\f\v]/g, ' ')
    .replace(/[\p{Cc}\p{Cf}\p{Cs}]/gu, (character) =>
      character === '\u200c' || character === '\u200d' ? character : '',
    );
}

/** Normalization does not silently truncate an oversized persisted/external wish. */
export function normalizeWish(value: string): string {
  if (typeof value !== 'string') return '';
  return editableWish(value).normalize('NFC').replace(/\s+/gu, ' ').trim();
}

export function isLanternWish(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.replace(/[\u200c\u200d]/gu, '').trim().length > 0 &&
    Array.from(value).length <= lanternWishLimit &&
    normalizeWish(value) === value
  );
}

export function isLanternState(value: unknown): value is LanternState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  if (
    Object.keys(state).some((key) => !stateFields.has(key)) ||
    !isLanternId(state.id) ||
    typeof state.phase !== 'string' ||
    !phases.includes(state.phase) ||
    typeof state.wish !== 'string' ||
    Array.from(state.wish).length > lanternWishLimit ||
    editableWish(state.wish) !== state.wish ||
    typeof state.openProgress !== 'number' ||
    !Number.isFinite(state.openProgress) ||
    state.openProgress < 0 ||
    state.openProgress > 1 ||
    !isLanternColor(state.color) ||
    !isLanternPattern(state.pattern)
  )
    return false;
  if (state.phase === 'wish') return state.openProgress === 0;
  if (!isLanternWish(state.wish)) return false;
  return state.phase === 'unfold' || state.openProgress === 1;
}

export function createLanternState(id: string): LanternState {
  if (!isLanternId(id)) throw new Error('A lantern requires a valid UUID.');
  return {
    id: id.toLowerCase(),
    phase: 'wish',
    wish: '',
    openProgress: 0,
    color: 'red',
    pattern: 'blossom',
  };
}

export function lanternReducer(state: LanternState, action: LanternAction): LanternState {
  switch (action.type) {
    case 'SET_WISH': {
      if (state.phase !== 'wish' || typeof action.value !== 'string') return state;
      const wish = Array.from(editableWish(action.value)).slice(0, lanternWishLimit).join('');
      return wish === state.wish ? state : { ...state, wish };
    }
    case 'START': {
      if (state.phase !== 'wish') return state;
      const wish = normalizeWish(state.wish);
      return isLanternWish(wish) ? { ...state, wish, phase: 'unfold' } : state;
    }
    case 'OPEN_PROGRESS': {
      if (state.phase !== 'unfold' || !Number.isFinite(action.progress)) return state;
      const openProgress = Math.min(1, Math.max(state.openProgress, action.progress, 0));
      return openProgress === state.openProgress ? state : { ...state, openProgress };
    }
    case 'CONFIRM_OPEN':
      return state.phase === 'unfold' && state.openProgress === 1
        ? { ...state, phase: 'decorate' }
        : state;
    case 'OPEN':
      return state.phase === 'unfold' ? { ...state, phase: 'decorate', openProgress: 1 } : state;
    case 'SET_COLOR':
      return state.phase === 'decorate' &&
        isLanternColor(action.color) &&
        state.color !== action.color
        ? { ...state, color: action.color }
        : state;
    case 'SET_PATTERN':
      return state.phase === 'decorate' &&
        isLanternPattern(action.pattern) &&
        state.pattern !== action.pattern
        ? { ...state, pattern: action.pattern }
        : state;
    case 'PREPARE':
      return state.phase === 'decorate' ? { ...state, phase: 'launch' } : state;
    case 'RELEASE':
      return state.phase === 'launch' ? { ...state, phase: 'flying' } : state;
    case 'FINISH_FLIGHT':
      return state.phase === 'flying' ? { ...state, phase: 'keepsake' } : state;
    default:
      return state;
  }
}
