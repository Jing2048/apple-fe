import { randomUUID } from 'node:crypto';
import type {
  Event,
  ParticipationRequest,
  ParticipationResponse,
  VerificationResponse,
} from '@apple/contracts';
import postgres from 'postgres';
import { DomainError } from '../errors.js';
import { fingerprint } from './fingerprint.js';
import type { EventBatchResult, Store } from './types.js';

interface ParticipationRow {
  participation_id: string;
  campaign_id: string;
  interaction: 'timing' | 'swipe';
  provider_mode: 'mock';
  created_at: Date;
}

function mapParticipation(row: ParticipationRow): ParticipationResponse {
  return {
    participationId: row.participation_id,
    campaignId: row.campaign_id,
    interaction: row.interaction,
    status: 'recorded',
    providerMode: row.provider_mode,
    createdAt: row.created_at.toISOString(),
  };
}

export class PostgresStore implements Store {
  constructor(readonly sql: postgres.Sql) {}

  async ready(): Promise<boolean> {
    const query = this.sql<
      {
        migrated: boolean;
        events: string | null;
        participations: string | null;
      }[]
    >`
      SELECT (SELECT COUNT(*) = 3 FROM schema_migrations WHERE name IN ('001_initial', '002_event_ownership', '003_campaign_catalog')) AS migrated,
             to_regclass('analytics_events')::text AS events,
             to_regclass('participations')::text AS participations
    `;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => {
        query.cancel();
        resolve(false);
      }, 2000);
      timer.unref();
    });
    try {
      return await Promise.race([
        query.then((rows) =>
          Boolean(rows[0]?.migrated && rows[0]?.events && rows[0]?.participations),
        ),
        deadline,
      ]);
    } catch {
      return false;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async ingestEvents(events: Event[], sessionId: string): Promise<EventBatchResult> {
    // Sorting prevents lock-order deadlocks for concurrent overlapping batches.
    const sorted = [...events].sort((a, b) => a.eventId.localeCompare(b.eventId));
    return this.sql.begin(async (transaction) => {
      let accepted = 0;
      let duplicates = 0;
      for (const event of sorted) {
        const hash = fingerprint(event);
        const inserted = await transaction`
          INSERT INTO analytics_events (event_id, payload, fingerprint, owner_session_id)
          VALUES (${event.eventId}, ${transaction.json(event)}, ${hash}, ${sessionId})
          ON CONFLICT (event_id) DO NOTHING RETURNING event_id
        `;
        if (inserted.length) {
          accepted++;
        } else {
          const existing = await transaction<
            { fingerprint: string; owner_session_id: string | null }[]
          >`
            SELECT fingerprint, owner_session_id FROM analytics_events WHERE event_id = ${event.eventId}
          `;
          if (
            existing[0]?.fingerprint !== hash ||
            existing[0]?.owner_session_id !== sessionId.toLowerCase()
          ) {
            throw new DomainError(
              'EVENT_CONFLICT',
              409,
              'An event ID was already used for different content.',
            );
          }
          duplicates++;
        }
      }
      return { accepted, duplicates };
    });
  }

  async verification(
    sessionId: string,
    participationId: string,
  ): Promise<VerificationResponse | undefined> {
    interface VerificationRow extends ParticipationRow {
      idempotency_key: string;
      checked_at: Date;
      session_total: number;
      round_total: number;
      by_name: VerificationResponse['eventSummary']['byName'];
    }
    // One statement supplies a consistent MVCC snapshot and never trusts payload.sessionId.
    const rows = await this.sql<VerificationRow[]>`
      WITH owned_receipt AS (
        SELECT participation_id, campaign_id, interaction, provider_mode, created_at, idempotency_key
        FROM participations
        WHERE participation_id = ${participationId} AND session_id = ${sessionId}
      ), session_events AS (
        SELECT payload FROM analytics_events
        WHERE owner_session_id = ${sessionId} AND EXISTS (SELECT 1 FROM owned_receipt)
      ), round_counts AS (
        SELECT payload->>'eventName' AS event_name, COUNT(*)::int AS count
        FROM session_events
        WHERE lower(payload->'properties'->>'roundId') = (SELECT idempotency_key::text FROM owned_receipt)
          AND payload->>'campaignId' = (SELECT campaign_id FROM owned_receipt)
        GROUP BY payload->>'eventName'
      )
      SELECT owned_receipt.*, CURRENT_TIMESTAMP AS checked_at,
             (SELECT COUNT(*)::int FROM session_events) AS session_total,
             COALESCE((SELECT SUM(count)::int FROM round_counts), 0) AS round_total,
             COALESCE((SELECT jsonb_agg(jsonb_build_object('eventName', event_name, 'count', count) ORDER BY event_name)
                       FROM round_counts), '[]'::jsonb) AS by_name
      FROM owned_receipt
    `;
    const row = rows[0];
    if (!row) return undefined;
    return {
      receipt: mapParticipation(row),
      roundId: row.idempotency_key,
      checkedAt: row.checked_at.toISOString(),
      eventSummary: {
        sessionTotal: row.session_total,
        roundTotal: row.round_total,
        byName: row.by_name,
      },
    };
  }

  async recordParticipation(
    sessionId: string,
    request: ParticipationRequest,
  ): Promise<ParticipationResponse> {
    return this.sql.begin(async (transaction) => {
      const rows = await transaction<ParticipationRow[]>`
        INSERT INTO participations (participation_id, session_id, campaign_id, interaction, idempotency_key, provider_mode)
        VALUES (${randomUUID()}, ${sessionId}, ${request.campaignId}, ${request.interaction}, ${request.idempotencyKey}, 'mock')
        ON CONFLICT (session_id, campaign_id, idempotency_key) DO NOTHING
        RETURNING participation_id, campaign_id, interaction, provider_mode, created_at
      `;
      const existing =
        rows[0] ??
        (
          await transaction<ParticipationRow[]>`
        SELECT participation_id, campaign_id, interaction, provider_mode, created_at
        FROM participations
        WHERE session_id = ${sessionId} AND campaign_id = ${request.campaignId} AND idempotency_key = ${request.idempotencyKey}
      `
        )[0];
      if (!existing) throw new Error('Participation disappeared after insertion');
      if (existing.interaction !== request.interaction) {
        throw new DomainError(
          'IDEMPOTENCY_CONFLICT',
          409,
          'The idempotency key was already used for a different interaction.',
        );
      }
      return mapParticipation(existing);
    });
  }

  async close(): Promise<void> {
    await this.sql.end({ timeout: 5 });
  }
}
