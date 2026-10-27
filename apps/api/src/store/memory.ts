import { randomUUID } from 'node:crypto';
import type {
  Event,
  ParticipationRequest,
  ParticipationResponse,
  VerificationResponse,
} from '@apple/contracts';
import { DomainError } from '../errors.js';
import { fingerprint } from './fingerprint.js';
import type { EventBatchResult, Store } from './types.js';

/** Unit-test double only. Runtime startup always creates PostgresStore. */
export class MemoryStore implements Store {
  readonly events = new Map<
    string,
    { event: Event; fingerprint: string; ownerSessionId: string | null }
  >();
  readonly participations = new Map<string, ParticipationResponse>();
  private readonly participationOwners = new Map<string, { sessionId: string; roundId: string }>();
  available = true;

  async ready(): Promise<boolean> {
    return this.available;
  }

  async ingestEvents(events: Event[], sessionId: string): Promise<EventBatchResult> {
    const ownerSessionId = sessionId.toLowerCase();
    const staged = new Map(this.events);
    let accepted = 0;
    let duplicates = 0;
    for (const event of events) {
      const hash = fingerprint(event);
      const eventId = event.eventId.toLowerCase();
      const existing = staged.get(eventId);
      if (existing) {
        if (existing.fingerprint !== hash || existing.ownerSessionId !== ownerSessionId) {
          throw new DomainError(
            'EVENT_CONFLICT',
            409,
            'An event ID was already used for different content.',
          );
        }
        duplicates++;
      } else {
        staged.set(eventId, {
          event: structuredClone(event),
          fingerprint: hash,
          ownerSessionId,
        });
        accepted++;
      }
    }
    this.events.clear();
    for (const [id, event] of staged) this.events.set(id, event);
    return { accepted, duplicates };
  }

  async recordParticipation(
    sessionId: string,
    request: ParticipationRequest,
  ): Promise<ParticipationResponse> {
    const key = `${sessionId.toLowerCase()}:${request.campaignId}:${request.idempotencyKey.toLowerCase()}`;
    const previous = this.participations.get(key);
    if (previous) {
      if (previous.interaction !== request.interaction) {
        throw new DomainError(
          'IDEMPOTENCY_CONFLICT',
          409,
          'The idempotency key was already used for a different interaction.',
        );
      }
      return structuredClone(previous);
    }
    const result: ParticipationResponse = {
      participationId: randomUUID(),
      campaignId: request.campaignId,
      interaction: request.interaction,
      status: 'recorded',
      providerMode: 'mock',
      createdAt: new Date().toISOString(),
    };
    this.participations.set(key, result);
    this.participationOwners.set(result.participationId, {
      sessionId: sessionId.toLowerCase(),
      roundId: request.idempotencyKey.toLowerCase(),
    });
    return structuredClone(result);
  }

  async verification(
    sessionId: string,
    participationId: string,
  ): Promise<VerificationResponse | undefined> {
    const owner = this.participationOwners.get(participationId.toLowerCase());
    if (!owner || owner.sessionId !== sessionId.toLowerCase()) return undefined;
    const receipt = [...this.participations.values()].find(
      (item) => item.participationId === participationId.toLowerCase(),
    );
    if (!receipt) return undefined;
    const sessionEvents = [...this.events.values()].filter(
      (item) => item.ownerSessionId === sessionId.toLowerCase(),
    );
    const roundEvents = sessionEvents.filter(
      (item) =>
        item.event.properties.roundId?.toLowerCase() === owner.roundId &&
        item.event.campaignId === receipt.campaignId,
    );
    const counts = new Map<Event['eventName'], number>();
    for (const { event } of roundEvents)
      counts.set(event.eventName, (counts.get(event.eventName) ?? 0) + 1);
    return {
      receipt: structuredClone(receipt),
      roundId: owner.roundId,
      checkedAt: new Date().toISOString(),
      eventSummary: {
        sessionTotal: sessionEvents.length,
        roundTotal: roundEvents.length,
        byName: [...counts.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([eventName, count]) => ({ eventName, count })),
      },
    };
  }

  async close(): Promise<void> {}
}
