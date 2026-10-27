import {
  isLanternColor,
  isLanternId,
  isLanternPattern,
  isLanternState,
  isLanternWish,
  type LanternColor,
  type LanternPattern,
  type LanternState,
} from './model';

export const lanternDraftKey = 'paper-lantern.offline.v1.draft';
export const lanternCardsKey = 'paper-lantern.offline.v1.cards';
export const lanternCardLimit = 10;
export type LanternStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export interface LanternCard {
  readonly id: string;
  readonly wish: string;
  readonly color: LanternColor;
  readonly pattern: LanternPattern;
  readonly createdAt: string;
}
export interface LanternSnapshot {
  readonly cards: readonly LanternCard[];
  readonly persistence: 'local' | 'memory';
}
const cardFields = new Set(['id', 'wish', 'color', 'pattern', 'createdAt']);

function getStorage(): LanternStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

function dateIsValid(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value))
    return false;
  return Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function envelope(
  raw: string,
  field: 'state' | 'cards',
  max: number,
): Record<string, unknown> | null {
  if (raw.length > max) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const parsed = value as Record<string, unknown>;
    return parsed.version === 1 &&
      Object.keys(parsed).every((key) => key === 'version' || key === field)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function parseDraft(raw: string): LanternState | null {
  const parsed = envelope(raw, 'state', 2048);
  if (!parsed || !isLanternState(parsed.state)) return null;
  return { ...parsed.state, id: parsed.state.id.toLowerCase() };
}

function parseCards(raw: string): LanternCard[] | null {
  const parsed = envelope(raw, 'cards', 8192);
  if (!parsed || !Array.isArray(parsed.cards) || parsed.cards.length > lanternCardLimit)
    return null;
  const cards: LanternCard[] = [];
  const ids = new Set<string>();
  for (const entry of parsed.cards) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const card = entry as Record<string, unknown>;
    if (
      Object.keys(card).some((key) => !cardFields.has(key)) ||
      !isLanternId(card.id) ||
      !isLanternWish(card.wish) ||
      !isLanternColor(card.color) ||
      !isLanternPattern(card.pattern) ||
      !dateIsValid(card.createdAt)
    )
      return null;
    const id = card.id.toLowerCase();
    if (ids.has(id)) return null;
    ids.add(id);
    cards.push({
      id,
      wish: card.wish,
      color: card.color,
      pattern: card.pattern,
      createdAt: card.createdAt,
    });
  }
  return cards;
}

function snapshot(
  cards: readonly LanternCard[],
  persistence: LanternSnapshot['persistence'],
): LanternSnapshot {
  return Object.freeze({
    cards: Object.freeze(cards.map((card) => Object.freeze(card))),
    persistence,
  });
}

/** Local wishes only. No camera data, requests, or server receipts. */
export class LanternStore {
  private readonly backing: LanternStorage | null;
  private draft: LanternState | null = null;
  private current: LanternSnapshot;
  private canPersist = false;
  private readonly listeners = new Set<() => void>();

  constructor(backing: LanternStorage | null = getStorage()) {
    this.backing = backing;
    let cards: LanternCard[] = [];
    let readable = Boolean(backing);
    if (backing) {
      for (const key of [lanternCardsKey, lanternDraftKey]) {
        try {
          const raw = backing.getItem(key);
          if (raw === null) continue;
          if (key === lanternCardsKey) {
            const parsed = parseCards(raw);
            if (parsed) cards = parsed;
            else backing.removeItem(key);
          } else {
            const parsed = parseDraft(raw);
            if (parsed) this.draft = parsed;
            else backing.removeItem(key);
          }
        } catch {
          readable = false;
        }
      }
      if (readable) {
        try {
          const raw = JSON.stringify({ version: 1, cards });
          backing.setItem(lanternCardsKey, raw);
          this.canPersist = backing.getItem(lanternCardsKey) === raw;
        } catch {
          /* Keep readable cards in memory without claiming a successful write. */
        }
      }
    }
    this.current = snapshot(cards, this.canPersist ? 'local' : 'memory');
  }

  getSnapshot = (): LanternSnapshot => this.current;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readDraft = (): LanternState | null =>
    this.draft
      ? {
          ...this.draft,
          phase: this.draft.phase === 'flying' ? 'keepsake' : this.draft.phase,
        }
      : null;

  saveDraft = (state: LanternState): boolean => {
    if (!isLanternState(state)) return false;
    this.draft = { ...state, id: state.id.toLowerCase() };
    const saved = this.persist(lanternDraftKey, JSON.stringify({ version: 1, state: this.draft }));
    this.publish(this.current.cards);
    return saved;
  };

  saveCard = (state: LanternState): LanternCard | null => {
    if (!isLanternState(state) || state.phase !== 'keepsake') return null;
    const id = state.id.toLowerCase();
    const previous = this.current.cards.find((card) => card.id === id);
    if (previous)
      return previous.wish === state.wish &&
        previous.color === state.color &&
        previous.pattern === state.pattern
        ? previous
        : null;
    let createdAt: string;
    try {
      createdAt = new Date().toISOString();
    } catch {
      return null;
    }
    if (!dateIsValid(createdAt)) return null;
    const card: LanternCard = {
      id,
      wish: state.wish,
      color: state.color,
      pattern: state.pattern,
      createdAt,
    };
    const cards = [card, ...this.current.cards].slice(0, lanternCardLimit);
    this.persist(lanternCardsKey, JSON.stringify({ version: 1, cards }));
    this.publish(cards);
    return this.current.cards[0] ?? null;
  };

  clear = (): void => {
    this.draft = null;
    if (this.backing) {
      for (const key of [lanternCardsKey, lanternDraftKey]) {
        try {
          this.backing.removeItem(key);
          if (this.backing.getItem(key) !== null) this.canPersist = false;
        } catch {
          this.canPersist = false;
        }
      }
    }
    this.publish([]);
  };

  private persist(key: string, raw: string): boolean {
    if (!this.canPersist || !this.backing) return false;
    try {
      this.backing.setItem(key, raw);
      if (this.backing.getItem(key) === raw) return true;
    } catch {
      /* This instance remains usable in memory. */
    }
    this.canPersist = false;
    return false;
  }

  private publish(cards: readonly LanternCard[]): void {
    const persistence = this.canPersist ? 'local' : 'memory';
    if (
      this.current.persistence === persistence &&
      cards.length === this.current.cards.length &&
      cards.every((card, index) => card === this.current.cards[index])
    )
      return;
    this.current = snapshot(cards, persistence);
    for (const listener of [...this.listeners]) listener();
  }
}
