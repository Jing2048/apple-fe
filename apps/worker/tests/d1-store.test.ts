import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fingerprint as postgresFingerprint } from '../../api/src/store/fingerprint.js';
import { D1Store, type D1Binding, type D1QueryResult, type D1Statement } from '../src/d1-store.js';

type BoundValue = string | number | null;
type Event = Parameters<D1Store['ingestEvents']>[0][number];
type ParticipationRequest = Parameters<D1Store['recordParticipation']>[1];

/** Test-only standard-binding facade. This runs real local SQLite, never remote D1. */
class SqliteStatement implements D1Statement {
  constructor(
    private readonly database: DatabaseSync,
    private readonly source: string,
    private readonly values: BoundValue[] = [],
  ) {}

  bind(...values: BoundValue[]): SqliteStatement {
    return new SqliteStatement(this.database, this.source, values);
  }

  execute<T>(): D1QueryResult<T> {
    return {
      success: true,
      results: this.database.prepare(this.source).all(...this.values) as T[],
    };
  }

  async all<T = Record<string, unknown>>(): Promise<D1QueryResult<T>> {
    return this.execute<T>();
  }
}

class SqliteD1Binding implements D1Binding {
  readonly database: DatabaseSync;

  constructor(path = ':memory:') {
    this.database = new DatabaseSync(path);
  }

  prepare(source: string): D1Statement {
    return new SqliteStatement(this.database, source);
  }

  async batch<T = Record<string, unknown>>(statements: D1Statement[]): Promise<D1QueryResult<T>[]> {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const results = statements.map((statement) => {
        if (!(statement instanceof SqliteStatement))
          throw new Error('Foreign test binding statement.');
        return statement.execute<T>();
      });
      this.database.exec('COMMIT');
      return results;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }
}

function event(overrides: Partial<Event> = {}): Event {
  return {
    eventId: randomUUID(),
    eventName: 'interaction_completed',
    schemaVersion: 1,
    campaignId: 'lab',
    releaseId: 'test-release',
    sessionId: randomUUID(),
    clientTime: '2026-10-27T00:00:00.000Z',
    properties: { interaction: 'swipe', durationMs: 1200, steps: 3 },
    ...overrides,
  };
}

function participation(overrides: Partial<ParticipationRequest> = {}): ParticipationRequest {
  return { campaignId: 'lab', interaction: 'swipe', idempotencyKey: randomUUID(), ...overrides };
}

const schema = await readFile(new URL('../migrations/0001_core.sql', import.meta.url), 'utf8');

describe('D1 SQL adapter against real local SQLite (not remote D1)', () => {
  let binding: SqliteD1Binding;
  let store: D1Store;
  const owner = randomUUID();

  beforeEach(() => {
    binding = new SqliteD1Binding();
    binding.database.exec(schema);
    store = new D1Store(binding);
  });
  afterEach(() => {
    binding.database.close();
  });

  it('checks the actual migrated schema and does not close a platform-owned binding', async () => {
    expect(await store.ready()).toBe(true);
    await store.close();
    expect(await new D1Store(binding).ready()).toBe(true);
    const empty = new SqliteD1Binding();
    try {
      expect(await new D1Store(empty).ready()).toBe(false);
    } finally {
      empty.database.close();
    }
  });

  it('retains one stable receipt under concurrent idempotent retries', async () => {
    const request = participation();
    const results = await Promise.all(
      Array.from({ length: 30 }, () => store.recordParticipation(owner, request)),
    );
    expect(new Set(results.map((row) => row.participationId)).size).toBe(1);
    expect(results.every((row) => JSON.stringify(row) === JSON.stringify(results[0]))).toBe(true);
    expect(
      binding.database.prepare('SELECT participation_id FROM participations').all(),
    ).toHaveLength(1);
    expect(results[0]).toMatchObject({
      campaignId: 'lab',
      status: 'recorded',
      providerMode: 'mock',
    });
  });

  it('rejects changed interaction under the same key without changing the original receipt', async () => {
    const request = participation();
    const first = await store.recordParticipation(owner, request);
    await expect(
      store.recordParticipation(owner, { ...request, interaction: 'timing' }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT', statusCode: 409 });
    expect(await store.recordParticipation(owner, request)).toEqual(first);
    expect(binding.database.prepare('SELECT conflict_guard FROM participations').get()).toEqual({
      conflict_guard: 1,
    });
  });

  it('scopes a shared idempotency key independently by verified owner and campaign', async () => {
    const request = participation();
    const other = randomUUID();
    const results = await Promise.all([
      store.recordParticipation(owner, request),
      store.recordParticipation(other, request),
      store.recordParticipation(owner, { ...request, campaignId: 'cloud-post' }),
      store.recordParticipation(other, { ...request, campaignId: 'cloud-post' }),
    ]);
    expect(new Set(results.map((row) => row.participationId)).size).toBe(4);
    expect(
      binding.database.prepare('SELECT participation_id FROM participations').all(),
    ).toHaveLength(4);
  });

  it('counts first delivery versus duplicates using SQL RETURNING, including one batch', async () => {
    const first = event();
    const second = event();
    expect(await store.ingestEvents([first, first, second], owner)).toEqual({
      accepted: 2,
      duplicates: 1,
    });
    expect(await store.ingestEvents([first, second], owner)).toEqual({
      accepted: 0,
      duplicates: 2,
    });
    const rows = binding.database
      .prepare('SELECT event_id, delivery_count FROM analytics_events ORDER BY event_id')
      .all();
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.delivery_count).sort()).toEqual([2, 3]);
  });

  it('deduplicates concurrent delivery persistently instead of keeping a JavaScript event map', async () => {
    const item = event();
    const results = await Promise.all(
      Array.from({ length: 30 }, () => store.ingestEvents([item], owner)),
    );
    expect(results.reduce((count, result) => count + result.accepted, 0)).toBe(1);
    expect(results.reduce((count, result) => count + result.duplicates, 0)).toBe(29);
    expect(binding.database.prepare('SELECT delivery_count FROM analytics_events').get()).toEqual({
      delivery_count: 30,
    });
  });

  it('uses the PostgreSQL-compatible SHA256 canonical fingerprint without rewriting payload', async () => {
    const item = event();
    const reordered = Object.fromEntries(Object.entries(item).reverse()) as Event;
    expect(await store.ingestEvents([item, reordered], owner)).toEqual({
      accepted: 1,
      duplicates: 1,
    });
    const row = binding.database.prepare('SELECT payload, fingerprint FROM analytics_events').get();
    expect(row?.payload).toBe(JSON.stringify(item));
    expect(row?.fingerprint).toBe(postgresFingerprint(item));
  });

  it('rolls back fresh writes and retry counters when a later event conflicts', async () => {
    const existing = event({ eventId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' });
    await store.ingestEvents([existing], owner);
    const fresh = event({ eventId: '00000000-0000-4000-8000-000000000001' });
    await expect(
      store.ingestEvents([fresh, existing, { ...existing, eventName: 'page_view' }], owner),
    ).rejects.toMatchObject({ code: 'EVENT_CONFLICT', statusCode: 409 });
    expect(
      binding.database
        .prepare('SELECT event_id, payload, delivery_count, conflict_guard FROM analytics_events')
        .all(),
    ).toEqual([
      {
        event_id: existing.eventId,
        payload: JSON.stringify(existing),
        delivery_count: 1,
        conflict_guard: 1,
      },
    ]);
  });

  it('rejects cross-owner event reuse and never counts it as the other owner duplicate', async () => {
    const item = event();
    await store.ingestEvents([item], owner);
    await expect(store.ingestEvents([item], randomUUID())).rejects.toMatchObject({
      code: 'EVENT_CONFLICT',
      statusCode: 409,
    });
    expect(
      binding.database
        .prepare('SELECT owner_session_id, delivery_count FROM analytics_events')
        .get(),
    ).toEqual({ owner_session_id: owner, delivery_count: 1 });
  });

  it('does not adopt legacy events with NULL owner from client-supplied sessionId', async () => {
    const item = event({ sessionId: owner });
    binding.database
      .prepare('INSERT INTO analytics_events (event_id, payload, fingerprint) VALUES (?, ?, ?)')
      .run(item.eventId, JSON.stringify(item), postgresFingerprint(item));
    await expect(store.ingestEvents([item], owner)).rejects.toMatchObject({
      code: 'EVENT_CONFLICT',
    });
    const saved = await store.recordParticipation(owner, participation());
    expect((await store.verification(owner, saved.participationId))?.eventSummary).toEqual({
      sessionTotal: 0,
      roundTotal: 0,
      byName: [],
    });
    expect(
      binding.database.prepare('SELECT owner_session_id FROM analytics_events').get()
        ?.owner_session_id,
    ).toBeNull();
  });

  it('reads live SQL facts scoped by owner, campaign, and round without exposing raw events', async () => {
    const request = participation();
    const other = randomUUID();
    const lab = await store.recordParticipation(owner, request);
    const cloud = await store.recordParticipation(owner, { ...request, campaignId: 'cloud-post' });
    const browserSession = randomUUID();
    await store.ingestEvents(
      [
        event({
          sessionId: browserSession,
          eventName: 'interaction_started',
          properties: { roundId: request.idempotencyKey },
        }),
        event({
          sessionId: browserSession,
          eventName: 'interaction_completed',
          properties: { roundId: request.idempotencyKey },
        }),
        event({
          sessionId: browserSession,
          campaignId: 'cloud-post',
          properties: { roundId: request.idempotencyKey },
        }),
        event({ sessionId: browserSession, eventName: 'page_view', properties: {} }),
      ],
      owner,
    );
    await store.ingestEvents(
      [event({ sessionId: browserSession, properties: { roundId: request.idempotencyKey } })],
      other,
    );
    const verified = await store.verification(owner, lab.participationId);
    expect(verified).toMatchObject({
      receipt: lab,
      roundId: request.idempotencyKey,
      eventSummary: {
        sessionTotal: 4,
        roundTotal: 2,
        byName: [
          { eventName: 'interaction_completed', count: 1 },
          { eventName: 'interaction_started', count: 1 },
        ],
      },
    });
    expect(Number.isFinite(Date.parse(verified!.checkedAt))).toBe(true);
    expect((await store.verification(owner, cloud.participationId))?.eventSummary).toEqual({
      sessionTotal: 4,
      roundTotal: 1,
      byName: [{ eventName: 'interaction_completed', count: 1 }],
    });
    expect(await store.verification(other, lab.participationId)).toBeUndefined();
    expect(await store.verification(owner, randomUUID())).toBeUndefined();
    expect(JSON.stringify(verified)).not.toContain(browserSession);
    expect(JSON.stringify(verified)).not.toContain('sessionId');
    expect(JSON.stringify(verified)).not.toContain('clientTime');
    const late = event({ properties: { roundId: request.idempotencyKey } });
    binding.database
      .prepare(
        'INSERT INTO analytics_events (event_id, payload, fingerprint, owner_session_id) VALUES (?, ?, ?, ?)',
      )
      .run(late.eventId, JSON.stringify(late), postgresFingerprint(late), owner);
    expect((await store.verification(owner, lab.participationId))?.eventSummary.roundTotal).toBe(3);
  });

  it('canonicalizes UUID lookup text while preserving original payload and immutable identity', async () => {
    const session = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const request = participation({ idempotencyKey: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff' });
    const saved = await store.recordParticipation(session.toUpperCase(), {
      ...request,
      idempotencyKey: request.idempotencyKey.toUpperCase(),
    });
    expect(await store.recordParticipation(session, request)).toEqual(saved);
    const item = event({
      eventId: 'cccccccc-dddd-4eee-8fff-aaaaaaaaaaaa'.toUpperCase(),
      properties: { roundId: request.idempotencyKey.toUpperCase() },
    });
    expect(await store.ingestEvents([item], session.toUpperCase())).toEqual({
      accepted: 1,
      duplicates: 0,
    });
    expect(await store.ingestEvents([item], session)).toEqual({ accepted: 0, duplicates: 1 });
    const verified = await store.verification(
      session.toUpperCase(),
      saved.participationId.toUpperCase(),
    );
    expect(verified?.roundId).toBe(request.idempotencyKey);
    expect(verified?.eventSummary.roundTotal).toBe(1);
    const row = binding.database.prepare('SELECT event_id, payload FROM analytics_events').get();
    expect(row?.event_id).toBe(item.eventId.toLowerCase());
    expect(JSON.parse(String(row?.payload)).eventId).toBe(item.eventId);
    await expect(
      store.ingestEvents([{ ...item, eventId: item.eventId.toLowerCase() }], session),
    ).rejects.toMatchObject({ code: 'EVENT_CONFLICT' });
  });

  it('survives reopening a file-backed database and a new adapter instance', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'apple-d1-sqlite-'));
    const path = join(directory, 'test.sqlite');
    const first = new SqliteD1Binding(path);
    const second = new SqliteD1Binding(path);
    try {
      first.database.exec(schema);
      const firstStore = new D1Store(first);
      const secondStore = new D1Store(second);
      const request = participation();
      const saved = await firstStore.recordParticipation(owner, request);
      const item = event();
      await firstStore.ingestEvents([item], owner);
      expect(await secondStore.recordParticipation(owner, request)).toEqual(saved);
      expect(await secondStore.ingestEvents([item], owner)).toEqual({ accepted: 0, duplicates: 1 });
      first.database.close();
      second.database.close();
      const reopened = new SqliteD1Binding(path);
      try {
        const reopenedStore = new D1Store(reopened);
        expect(await reopenedStore.recordParticipation(owner, request)).toEqual(saved);
        expect(await reopenedStore.ingestEvents([item], owner)).toEqual({
          accepted: 0,
          duplicates: 1,
        });
      } finally {
        reopened.database.close();
      }
    } finally {
      if (first.database.isOpen) first.database.close();
      if (second.database.isOpen) second.database.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
