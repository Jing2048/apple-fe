import { DomainError } from '../../api/src/errors.js';
import type { Store } from '../../api/src/store/types.js';

type Event = Parameters<Store['ingestEvents']>[0][number];
type ParticipationRequest = Parameters<Store['recordParticipation']>[1];
type ParticipationResponse = Awaited<ReturnType<Store['recordParticipation']>>;
type VerificationResponse = NonNullable<Awaited<ReturnType<Store['verification']>>>;

/** The subset of the standard D1 binding used by this adapter, without platform credentials. */
export interface D1QueryResult<T = Record<string, unknown>> {
  success: boolean;
  results: T[];
  error?: string;
}

export interface D1Statement {
  bind(...values: (string | number | null)[]): D1Statement;
  all<T = Record<string, unknown>>(): Promise<D1QueryResult<T>>;
}

export interface D1Binding {
  prepare(sql: string): D1Statement;
  /** Must execute all statements as one transaction and roll back every write on failure. */
  batch<T = Record<string, unknown>>(statements: D1Statement[]): Promise<D1QueryResult<T>[]>;
}

interface ParticipationRow {
  participation_id: string;
  campaign_id: string;
  interaction: ParticipationResponse['interaction'];
  provider_mode: 'mock';
  created_at: string;
}

function receipt(row: ParticipationRow): ParticipationResponse {
  return {
    participationId: row.participation_id,
    campaignId: row.campaign_id,
    interaction: row.interaction,
    status: 'recorded',
    providerMode: row.provider_mode,
    createdAt: row.created_at,
  };
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

async function fingerprint(value: unknown): Promise<string> {
  const encoded = new TextEncoder().encode(JSON.stringify(canonicalize(value)));
  const digest = await crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function requireSuccess<T>(result: D1QueryResult<T>): D1QueryResult<T> {
  if (!result.success) throw new Error(result.error ?? 'D1 statement failed.');
  return result;
}

function isGuardConflict(error: unknown, guard: string): boolean {
  return error instanceof Error && error.message.includes(guard);
}

/** Persistent SQL adapter; it does not own/close the platform-provided D1 binding. */
export class D1Store implements Store {
  constructor(private readonly database: D1Binding) {}

  async ready(): Promise<boolean> {
    try {
      const result = requireSuccess(
        await this.database
          .prepare(
            `
        SELECT
          (SELECT COUNT(*) FROM (SELECT event_id, fingerprint, owner_session_id, delivery_count, conflict_guard
                                FROM analytics_events LIMIT 0)) AS events,
          (SELECT COUNT(*) FROM (SELECT participation_id, session_id, campaign_id, idempotency_key, conflict_guard
                                FROM participations LIMIT 0)) AS receipts
      `,
          )
          .all(),
      );
      return result.results.length === 1;
    } catch {
      return false;
    }
  }

  async ingestEvents(events: Event[], sessionId: string): ReturnType<Store['ingestEvents']> {
    if (!events.length) return { accepted: 0, duplicates: 0 };
    const snapshots = events.map((event) => {
      const payload = JSON.stringify(event);
      return { event: JSON.parse(payload) as Event, payload };
    });
    const prepared = await Promise.all(
      snapshots.map(async ({ event, payload }) => ({
        eventId: event.eventId.toLowerCase(),
        payload,
        hash: await fingerprint(event),
      })),
    );
    prepared.sort((a, b) => a.eventId.localeCompare(b.eventId));
    const statements = prepared.map((event) =>
      this.database
        .prepare(
          `
      INSERT INTO analytics_events (event_id, payload, fingerprint, owner_session_id)
      VALUES (?, ?, ?, ?)
      ON CONFLICT (event_id) DO UPDATE SET
        conflict_guard = CASE
          WHEN analytics_events.fingerprint = excluded.fingerprint
           AND analytics_events.owner_session_id = excluded.owner_session_id THEN 1 ELSE 0 END,
        delivery_count = analytics_events.delivery_count + 1
      RETURNING delivery_count
    `,
        )
        .bind(event.eventId, event.payload, event.hash, sessionId.toLowerCase()),
    );
    try {
      const results = await this.database.batch<{ delivery_count: number }>(statements);
      if (results.length !== statements.length) throw new Error('Incomplete D1 batch result.');
      let accepted = 0;
      let duplicates = 0;
      for (const result of results) {
        const row = requireSuccess(result).results[0];
        if (!row) throw new Error('D1 event write returned no receipt.');
        if (row.delivery_count === 1) accepted++;
        else duplicates++;
      }
      return { accepted, duplicates };
    } catch (error) {
      if (isGuardConflict(error, 'event_identity_guard')) {
        throw new DomainError(
          'EVENT_CONFLICT',
          409,
          'An event ID was already used for different content.',
        );
      }
      throw error;
    }
  }

  async recordParticipation(
    sessionId: string,
    request: ParticipationRequest,
  ): Promise<ParticipationResponse> {
    const statement = this.database
      .prepare(
        `
      INSERT INTO participations
        (participation_id, session_id, campaign_id, interaction, idempotency_key, provider_mode, created_at)
      VALUES (?, ?, ?, ?, ?, 'mock', ?)
      ON CONFLICT (session_id, campaign_id, idempotency_key) DO UPDATE SET
        conflict_guard = CASE WHEN participations.interaction = excluded.interaction THEN 1 ELSE 0 END
      RETURNING participation_id, campaign_id, interaction, provider_mode, created_at
    `,
      )
      .bind(
        crypto.randomUUID(),
        sessionId.toLowerCase(),
        request.campaignId,
        request.interaction,
        request.idempotencyKey.toLowerCase(),
        new Date().toISOString(),
      );
    try {
      const results = await this.database.batch<ParticipationRow>([statement]);
      const result = results[0];
      const row = result && requireSuccess(result).results[0];
      if (!row) throw new Error('D1 participation write returned no receipt.');
      return receipt(row);
    } catch (error) {
      if (isGuardConflict(error, 'participation_idempotency_guard')) {
        throw new DomainError(
          'IDEMPOTENCY_CONFLICT',
          409,
          'The idempotency key was already used for a different interaction.',
        );
      }
      throw error;
    }
  }

  async verification(
    sessionId: string,
    participationId: string,
  ): Promise<VerificationResponse | undefined> {
    interface VerificationRow extends ParticipationRow {
      idempotency_key: string;
      checked_at: string;
      session_total: number;
      round_total: number;
      by_name: string;
    }
    const result = requireSuccess(
      await this.database
        .prepare(
          `
      WITH owned_receipt AS (
        SELECT participation_id, campaign_id, interaction, provider_mode, created_at, idempotency_key
        FROM participations WHERE participation_id = ? AND session_id = ?
      ), session_events AS (
        SELECT payload FROM analytics_events
        WHERE owner_session_id = ? AND EXISTS (SELECT 1 FROM owned_receipt)
      ), round_counts AS (
        SELECT json_extract(payload, '$.eventName') AS event_name, COUNT(*) AS count
        FROM session_events
        WHERE lower(json_extract(payload, '$.properties.roundId')) = (SELECT idempotency_key FROM owned_receipt)
          AND json_extract(payload, '$.campaignId') = (SELECT campaign_id FROM owned_receipt)
        GROUP BY json_extract(payload, '$.eventName')
      )
      SELECT owned_receipt.*, strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS checked_at,
             (SELECT COUNT(*) FROM session_events) AS session_total,
             COALESCE((SELECT SUM(count) FROM round_counts), 0) AS round_total,
             (SELECT json_group_array(json_object('eventName', event_name, 'count', count))
              FROM (SELECT event_name, count FROM round_counts ORDER BY event_name)) AS by_name
      FROM owned_receipt
    `,
        )
        .bind(participationId.toLowerCase(), sessionId.toLowerCase(), sessionId.toLowerCase())
        .all<VerificationRow>(),
    );
    const row = result.results[0];
    if (!row) return undefined;
    return {
      receipt: receipt(row),
      roundId: row.idempotency_key,
      checkedAt: row.checked_at,
      eventSummary: {
        sessionTotal: row.session_total,
        roundTotal: row.round_total,
        byName: JSON.parse(row.by_name) as VerificationResponse['eventSummary']['byName'],
      },
    };
  }

  async close(): Promise<void> {
    // The binding lifetime belongs to the Worker platform, not an individual request/store.
  }
}
