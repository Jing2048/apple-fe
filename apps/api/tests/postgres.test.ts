import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import postgres from 'postgres';
import { labCampaign, type Campaign } from '@apple/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/migrate.js';
import { buildApp } from '../src/app.js';
import { PostgresStore } from '../src/store/postgres.js';
import { fingerprint } from '../src/store/fingerprint.js';
import { event, participation, secondCampaign, testConfig } from './fixtures.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    'Real PostgreSQL integration tests require DATABASE_URL. Start the documented database and rerun test:integration.',
  );
}

describe('real PostgreSQL persistence and concurrency', () => {
  const schema = `api_test_${randomUUID().replaceAll('-', '')}`;
  const admin = postgres(databaseUrl, { max: 1, connect_timeout: 5, onnotice: () => {} });
  let sql: postgres.Sql;
  let store: PostgresStore;
  const eventOwner = randomUUID();

  beforeAll(async () => {
    await admin`CREATE SCHEMA ${admin(schema)}`;
    sql = postgres(databaseUrl, {
      max: 10,
      connect_timeout: 5,
      onnotice: () => {},
      connection: { search_path: schema },
    });
    await migrate(sql);
    store = new PostgresStore(sql);
  }, 20_000);
  beforeEach(async () => {
    await sql`TRUNCATE analytics_events, participations`;
  });
  afterAll(async () => {
    if (sql) await sql.end({ timeout: 5 });
    await admin`DROP SCHEMA IF EXISTS ${admin(schema)} CASCADE`;
    await admin.end({ timeout: 5 });
  });

  it('applies migrations repeatably and verifies readiness', async () => {
    await migrate(sql);
    expect(await store.ready()).toBe(true);
    const migrations = await sql`SELECT name FROM schema_migrations`;
    expect(migrations).toHaveLength(3);
  });

  it('does not report readiness when migration registration is missing', async () => {
    await sql`DELETE FROM schema_migrations WHERE name = '001_initial'`;
    try {
      expect(await store.ready()).toBe(false);
    } finally {
      await migrate(sql);
    }
  });

  it('requires the ownership migration before reporting readiness', async () => {
    await sql`DELETE FROM schema_migrations WHERE name = '002_event_ownership'`;
    try {
      expect(await store.ready()).toBe(false);
    } finally {
      await migrate(sql);
    }
  });

  it('requires the campaign migration and enforces the database slug constraint', async () => {
    await sql`DELETE FROM schema_migrations WHERE name = '003_campaign_catalog'`;
    try {
      expect(await store.ready()).toBe(false);
    } finally {
      await migrate(sql);
    }
    for (const campaignId of ['', 'bad--slug', 'ends-', 'a'.repeat(65)]) {
      await expect(
        store.recordParticipation(randomUUID(), participation({ campaignId })),
      ).rejects.toMatchObject({ code: '23514' });
    }
    expect(await sql`SELECT participation_id FROM participations`).toHaveLength(0);
  });

  it('upgrades legacy events without inferring ownership from their client sessionId', async () => {
    const legacySchema = `${schema}_legacy`;
    await admin`CREATE SCHEMA ${admin(legacySchema)}`;
    const legacy = postgres(databaseUrl, {
      max: 1,
      connection: { search_path: legacySchema },
      onnotice: () => {},
    });
    try {
      const source = await readFile(
        new URL('../migrations/001_initial.sql', import.meta.url),
        'utf8',
      );
      await legacy.unsafe(source);
      await legacy`CREATE TABLE schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`;
      await legacy`INSERT INTO schema_migrations (name, checksum) VALUES ('001_initial', ${createHash('sha256').update(source).digest('hex')})`;
      const oldEvent = event({ sessionId: eventOwner });
      await legacy`INSERT INTO analytics_events (event_id, payload, fingerprint) VALUES (${oldEvent.eventId}, ${legacy.json(oldEvent)}, ${fingerprint(oldEvent)})`;
      await migrate(legacy);
      const migrated =
        await legacy`SELECT owner_session_id FROM analytics_events WHERE event_id = ${oldEvent.eventId}`;
      expect(migrated).toHaveLength(1);
      expect(migrated[0]?.owner_session_id).toBeNull();
      const legacyStore = new PostgresStore(legacy);
      expect(await legacyStore.ready()).toBe(true);
      const receipt = await legacyStore.recordParticipation(eventOwner, participation());
      expect(
        (await legacyStore.verification(eventOwner, receipt.participationId))?.eventSummary,
      ).toEqual({ sessionTotal: 0, roundTotal: 0, byName: [] });
      await expect(legacyStore.ingestEvents([oldEvent], eventOwner)).rejects.toThrow(
        'different content',
      );
      expect(
        (await legacy`SELECT owner_session_id FROM analytics_events`)[0]?.owner_session_id,
      ).toBeNull();
    } finally {
      await legacy.end({ timeout: 5 });
      await admin`DROP SCHEMA IF EXISTS ${admin(legacySchema)} CASCADE`;
    }
  });

  it('detects modified applied migration metadata', async () => {
    await sql`UPDATE schema_migrations SET checksum = 'tampered' WHERE name = '001_initial'`;
    try {
      await expect(migrate(sql)).rejects.toThrow('checksum mismatch');
    } finally {
      // Restore through the known tested migration, only inside this run's isolated schema.
      await sql`DELETE FROM schema_migrations WHERE name = '001_initial'`;
      await migrate(sql);
    }
  });

  it('deduplicates concurrent event delivery and persists the actual payload', async () => {
    const item = event();
    const outcomes = await Promise.all(
      Array.from({ length: 30 }, () => store.ingestEvents([item], eventOwner)),
    );
    expect(outcomes.reduce((sum, item) => sum + item.accepted, 0)).toBe(1);
    expect(outcomes.reduce((sum, item) => sum + item.duplicates, 0)).toBe(29);
    const rows = await sql`SELECT payload FROM analytics_events WHERE event_id = ${item.eventId}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload).toEqual(item);
  });

  it('deduplicates repeated events inside one batch', async () => {
    const item = event();
    expect(await store.ingestEvents([item, item], eventOwner)).toEqual({
      accepted: 1,
      duplicates: 1,
    });
  });

  it('avoids deadlocks for concurrent overlapping batches in opposite orders', async () => {
    const first = event();
    const second = event();
    const outcomes = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        store.ingestEvents(index % 2 ? [first, second] : [second, first], eventOwner),
      ),
    );
    expect(outcomes.reduce((sum, result) => sum + result.accepted, 0)).toBe(2);
    expect(outcomes.reduce((sum, result) => sum + result.duplicates, 0)).toBe(38);
    expect(await sql`SELECT event_id FROM analytics_events`).toHaveLength(2);
  });

  it('bounds readiness latency when a database lock blocks its query', async () => {
    const blocker = postgres(databaseUrl, { max: 1, connection: { search_path: schema } });
    let releaseLock: () => void = () => {};
    let notifyLocked: () => void = () => {};
    const released = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const locked = new Promise<void>((resolve) => {
      notifyLocked = resolve;
    });
    const blocking = blocker.begin(async (transaction) => {
      await transaction`LOCK TABLE schema_migrations IN ACCESS EXCLUSIVE MODE`;
      notifyLocked();
      await released;
    });
    try {
      await locked;
      const started = Date.now();
      expect(await store.ready()).toBe(false);
      expect(Date.now() - started).toBeLessThan(3000);
    } finally {
      releaseLock();
      await blocking;
      await blocker.end({ timeout: 5 });
    }
    expect(await store.ready()).toBe(true);
  }, 10_000);

  it('rolls back earlier writes in a conflicting event batch', async () => {
    const existing = event({ eventId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' });
    await store.ingestEvents([existing], eventOwner);
    const fresh = event({ eventId: '00000000-0000-4000-8000-000000000001' });
    await expect(
      store.ingestEvents([fresh, { ...existing, eventName: 'page_view' }], eventOwner),
    ).rejects.toThrow('different content');
    const rows = await sql`SELECT event_id FROM analytics_events`;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.event_id).toBe(existing.eventId);
  });

  it('keeps receipt stable under concurrent retries', async () => {
    const session = randomUUID();
    const request = participation();
    const results = await Promise.all(
      Array.from({ length: 30 }, () => store.recordParticipation(session, request)),
    );
    expect(new Set(results.map((item) => item.participationId)).size).toBe(1);
    expect(results.every((item) => JSON.stringify(item) === JSON.stringify(results[0]))).toBe(true);
    expect(await sql`SELECT participation_id FROM participations`).toHaveLength(1);
  });

  it('rejects conflicting payloads for the same scoped idempotency key', async () => {
    const session = randomUUID();
    const request = participation();
    await store.recordParticipation(session, request);
    await expect(
      store.recordParticipation(session, { ...request, interaction: 'swipe' }),
    ).rejects.toThrow('different interaction');
    expect(await sql`SELECT participation_id FROM participations`).toHaveLength(1);
  });

  it('isolates anonymous sessions when idempotency keys happen to match', async () => {
    const request = participation();
    const first = await store.recordParticipation(randomUUID(), request);
    const second = await store.recordParticipation(randomUUID(), request);
    expect(first.participationId).not.toBe(second.participationId);
    expect(await sql`SELECT participation_id FROM participations`).toHaveLength(2);
  });

  it('continues to deduplicate after opening a new store connection', async () => {
    const item = event();
    await store.ingestEvents([item], eventOwner);
    const reopened = new PostgresStore(
      postgres(databaseUrl, { max: 1, connection: { search_path: schema } }),
    );
    try {
      expect(await reopened.ingestEvents([item], eventOwner)).toEqual({
        accepted: 0,
        duplicates: 1,
      });
    } finally {
      await reopened.close();
    }
  });

  function createHttpApp(campaigns?: readonly Campaign[]) {
    const client = postgres(databaseUrl!, {
      max: 3,
      connect_timeout: 5,
      connection: { search_path: schema, statement_timeout: 5000 },
    });
    return buildApp({
      store: new PostgresStore(client),
      config: testConfig(),
      logger: false,
      ...(campaigns ? { campaigns } : {}),
    });
  }

  it('persists the original default cloud-post demo without mixing lab rounds or accepting blessing text', async () => {
    const app = await createHttpApp();
    try {
      const campaign = await app.inject('/api/campaigns/cloud-post');
      expect(campaign.statusCode).toBe(200);
      expect(campaign.json()).toMatchObject({
        id: 'cloud-post',
        title: '云朵邮局',
        version: 'cloud-post-v1',
        interactions: ['swipe'],
        assets: [],
      });
      expect(campaign.headers['set-cookie']).toContain('HttpOnly');
      const cookie = String(campaign.headers['set-cookie']).split(';')[0]!;
      const headers = { origin: testConfig().appOrigin, cookie };
      const request = participation({ campaignId: 'cloud-post', interaction: 'swipe' });
      const timing = await app.inject({
        method: 'POST',
        url: '/api/participations',
        headers,
        payload: { ...request, interaction: 'timing' },
      });
      expect(timing.statusCode).toBe(400);
      expect(timing.json().error.code).toBe('INTERACTION_NOT_SUPPORTED');
      const timingEvents = await app.inject({
        method: 'POST',
        url: '/api/events',
        headers,
        payload: {
          events: [event({ campaignId: 'cloud-post', properties: { interaction: 'timing' } })],
        },
      });
      expect(timingEvents.statusCode).toBe(400);
      const text = await app.inject({
        method: 'POST',
        url: '/api/participations',
        headers,
        payload: { ...request, blessing: 'browser-only content' },
      });
      expect(text.statusCode).toBe(400);
      expect(await sql`SELECT participation_id FROM participations`).toHaveLength(0);
      expect(await sql`SELECT event_id FROM analytics_events`).toHaveLength(0);
      const cloud = await app.inject({
        method: 'POST',
        url: '/api/participations',
        headers,
        payload: request,
      });
      const lab = await app.inject({
        method: 'POST',
        url: '/api/participations',
        headers,
        payload: { ...request, campaignId: 'lab' },
      });
      expect(cloud.statusCode).toBe(200);
      expect(lab.statusCode).toBe(200);
      expect(cloud.json().participationId).not.toBe(lab.json().participationId);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/participations',
            headers,
            payload: request,
          })
        ).json(),
      ).toEqual(cloud.json());
      const receipts =
        await sql`SELECT campaign_id, session_id, idempotency_key FROM participations ORDER BY campaign_id`;
      expect(receipts).toHaveLength(2);
      expect(receipts.map((row) => row.campaign_id)).toEqual(['cloud-post', 'lab']);
      expect(receipts[0]?.session_id).toBe(receipts[1]?.session_id);
      expect(receipts[0]?.idempotency_key).toBe(receipts[1]?.idempotency_key);
      const events = [
        event({
          campaignId: 'cloud-post',
          eventName: 'interaction_started',
          properties: { interaction: 'swipe', roundId: request.idempotencyKey },
        }),
        event({
          campaignId: 'cloud-post',
          eventName: 'interaction_completed',
          properties: { interaction: 'swipe', roundId: request.idempotencyKey },
        }),
        event({
          campaignId: 'lab',
          eventName: 'interaction_completed',
          properties: { interaction: 'swipe', roundId: request.idempotencyKey },
        }),
      ];
      expect(
        (
          await app.inject({ method: 'POST', url: '/api/events', headers, payload: { events } })
        ).json(),
      ).toEqual({ accepted: 3, duplicates: 0 });
      expect(await sql`SELECT event_id FROM analytics_events`).toHaveLength(3);
      const verified = await app.inject({
        url: `/api/lab/verification/${cloud.json().participationId}`,
        headers: { cookie },
      });
      expect(verified.statusCode).toBe(200);
      expect(verified.json()).toMatchObject({
        receipt: cloud.json(),
        roundId: request.idempotencyKey,
        eventSummary: {
          sessionTotal: 3,
          roundTotal: 2,
          byName: [
            { eventName: 'interaction_completed', count: 1 },
            { eventName: 'interaction_started', count: 1 },
          ],
        },
      });
      const labVerified = await app.inject({
        url: `/api/lab/verification/${lab.json().participationId}`,
        headers: { cookie },
      });
      expect(labVerified.json().eventSummary).toEqual({
        sessionTotal: 3,
        roundTotal: 1,
        byName: [{ eventName: 'interaction_completed', count: 1 }],
      });
      expect(verified.body).not.toContain('browser-only content');
    } finally {
      await app.close();
    }
  });

  it('isolates receipts and round event counts for two configured campaigns in one signed session', async () => {
    const app = await createHttpApp([labCampaign, secondCampaign]);
    try {
      const campaign = await app.inject(`/api/campaigns/${secondCampaign.id}`);
      expect(campaign.statusCode).toBe(200);
      expect(campaign.json()).toEqual(secondCampaign);
      const cookie = String(campaign.headers['set-cookie']).split(';')[0]!;
      const headers = { origin: testConfig().appOrigin, cookie };
      const request = participation({ interaction: 'swipe' });
      const first = await app.inject({
        method: 'POST',
        url: '/api/participations',
        headers,
        payload: request,
      });
      const second = await app.inject({
        method: 'POST',
        url: '/api/participations',
        headers,
        payload: { ...request, campaignId: secondCampaign.id },
      });
      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      expect(first.json().participationId).not.toBe(second.json().participationId);
      expect(second.json().campaignId).toBe(secondCampaign.id);
      const secondRetry = await app.inject({
        method: 'POST',
        url: '/api/participations',
        headers,
        payload: { ...request, campaignId: secondCampaign.id },
      });
      expect(secondRetry.json()).toEqual(second.json());
      const rows =
        await sql`SELECT campaign_id, idempotency_key, session_id FROM participations ORDER BY campaign_id`;
      expect(rows).toHaveLength(2);
      expect(rows[0]?.session_id).toBe(rows[1]?.session_id);
      expect(rows.map((row) => row.campaign_id)).toEqual(['lab', secondCampaign.id]);
      expect(rows[0]?.idempotency_key).toBe(rows[1]?.idempotency_key);
      const events = [
        event({
          eventName: 'interaction_started',
          properties: { roundId: request.idempotencyKey, interaction: 'swipe' },
        }),
        event({
          eventName: 'interaction_completed',
          properties: { roundId: request.idempotencyKey, interaction: 'swipe' },
        }),
        event({
          campaignId: secondCampaign.id,
          eventName: 'interaction_completed',
          properties: { roundId: request.idempotencyKey, interaction: 'swipe' },
        }),
      ];
      expect(
        (
          await app.inject({ method: 'POST', url: '/api/events', headers, payload: { events } })
        ).json(),
      ).toEqual({ accepted: 3, duplicates: 0 });
      const firstVerified = await app.inject({
        url: `/api/lab/verification/${first.json().participationId}`,
        headers: { cookie },
      });
      const secondVerified = await app.inject({
        url: `/api/lab/verification/${second.json().participationId}`,
        headers: { cookie },
      });
      expect(firstVerified.json().eventSummary).toEqual({
        sessionTotal: 3,
        roundTotal: 2,
        byName: [
          { eventName: 'interaction_completed', count: 1 },
          { eventName: 'interaction_started', count: 1 },
        ],
      });
      expect(secondVerified.json().eventSummary).toEqual({
        sessionTotal: 3,
        roundTotal: 1,
        byName: [{ eventName: 'interaction_completed', count: 1 }],
      });
      expect(secondVerified.json().receipt.campaignId).toBe(secondCampaign.id);
    } finally {
      await app.close();
    }
  });

  it('rejects unknown campaigns and disabled interactions before any real database write', async () => {
    const app = await createHttpApp([labCampaign, secondCampaign]);
    try {
      const campaign = await app.inject('/api/campaigns/lab');
      const cookie = String(campaign.headers['set-cookie']).split(';')[0]!;
      const headers = { origin: testConfig().appOrigin, cookie };
      const unknown = await app.inject('/api/campaigns/unknown');
      expect(unknown.statusCode).toBe(404);
      expect(unknown.headers['set-cookie']).toBeUndefined();
      for (const [campaignId, interaction, expected] of [
        ['unknown', 'timing', 404],
        [secondCampaign.id, 'timing', 400],
      ] as const) {
        const receipt = await app.inject({
          method: 'POST',
          url: '/api/participations',
          headers,
          payload: participation({ campaignId, interaction }),
        });
        expect(receipt.statusCode).toBe(expected);
        const events = await app.inject({
          method: 'POST',
          url: '/api/events',
          headers,
          payload: { events: [event(), event({ campaignId, properties: { interaction } })] },
        });
        expect(events.statusCode).toBe(expected);
      }
      expect(await sql`SELECT participation_id FROM participations`).toHaveLength(0);
      expect(await sql`SELECT event_id FROM analytics_events`).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it('connects validated HTTP events and signed-session participations to database facts', async () => {
    const app = await createHttpApp();
    try {
      const ready = await app.inject('/api/ready');
      expect(ready.statusCode).toBe(200);
      expect(ready.json().providerMode).toBe('mock');
      const campaign = await app.inject('/api/campaigns/lab');
      const cookie = String(campaign.headers['set-cookie']).split(';')[0]!;
      const headers = { origin: testConfig().appOrigin, cookie };
      const request = participation();
      const response = await app.inject({
        method: 'POST',
        url: '/api/participations',
        headers,
        payload: request,
      });
      expect(response.statusCode).toBe(200);
      const duplicate = await app.inject({
        method: 'POST',
        url: '/api/participations',
        headers,
        payload: request,
      });
      expect(duplicate.json()).toEqual(response.json());
      const rows = await sql`SELECT participation_id, provider_mode FROM participations`;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.participation_id).toBe(response.json().participationId);
      expect(rows[0]?.provider_mode).toBe('mock');
      const item = event();
      const events = await app.inject({
        method: 'POST',
        url: '/api/events',
        headers,
        payload: { events: [item, item] },
      });
      expect(events.statusCode).toBe(200);
      expect(events.json()).toEqual({ accepted: 1, duplicates: 1 });
      const persisted =
        await sql`SELECT payload FROM analytics_events WHERE event_id = ${item.eventId}`;
      expect(persisted[0]?.payload).toEqual(item);
    } finally {
      await app.close();
    }
  });

  it('rejects unsafe HTTP writes before they can reach the real database', async () => {
    const app = await createHttpApp();
    try {
      const denied = await app.inject({
        method: 'POST',
        url: '/api/events',
        headers: { origin: 'https://attacker.example' },
        payload: { events: [event()] },
      });
      expect(denied.statusCode).toBe(403);
      const invalid = await app.inject({
        method: 'POST',
        url: '/api/events',
        headers: { origin: testConfig().appOrigin },
        payload: { events: [{ ...event(), properties: { email: 'do-not-store@example.test' } }] },
      });
      expect(invalid.statusCode).toBe(400);
      expect(await sql`SELECT event_id FROM analytics_events`).toHaveLength(0);
      expect(await sql`SELECT participation_id FROM participations`).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it('preserves signed-session idempotency across independent API instances', async () => {
    const request = participation();
    const first = await createHttpApp();
    const campaign = await first.inject('/api/campaigns/lab');
    const cookie = String(campaign.headers['set-cookie']).split(';')[0]!;
    const headers = { origin: testConfig().appOrigin, cookie };
    const original = await first.inject({
      method: 'POST',
      url: '/api/participations',
      headers,
      payload: request,
    });
    await first.close();
    const second = await createHttpApp();
    try {
      const retried = await second.inject({
        method: 'POST',
        url: '/api/participations',
        headers,
        payload: request,
      });
      expect(retried.statusCode).toBe(200);
      expect(retried.json()).toEqual(original.json());
      expect(await sql`SELECT participation_id FROM participations`).toHaveLength(1);
    } finally {
      await second.close();
    }
  });

  it('reads live database facts by signed owner and round without exposing other sessions or raw events', async () => {
    const app = await createHttpApp();
    try {
      const aCampaign = await app.inject('/api/campaigns/lab');
      const bCampaign = await app.inject('/api/campaigns/lab');
      const aCookie = String(aCampaign.headers['set-cookie']).split(';')[0]!;
      const bCookie = String(bCampaign.headers['set-cookie']).split(';')[0]!;
      const aHeaders = { origin: testConfig().appOrigin, cookie: aCookie };
      const bHeaders = { origin: testConfig().appOrigin, cookie: bCookie };
      const round = participation();
      const aReceipt = await app.inject({
        method: 'POST',
        url: '/api/participations',
        headers: aHeaders,
        payload: round,
      });
      const bReceipt = await app.inject({
        method: 'POST',
        url: '/api/participations',
        headers: bHeaders,
        payload: round,
      });
      expect(aReceipt.statusCode).toBe(200);
      expect(bReceipt.statusCode).toBe(200);
      const clientSession = randomUUID();
      const aEvents = [
        event({ sessionId: clientSession, eventName: 'page_view', properties: {} }),
        event({
          sessionId: clientSession,
          eventName: 'interaction_started',
          properties: { roundId: round.idempotencyKey },
        }),
        event({
          sessionId: clientSession,
          eventName: 'interaction_completed',
          properties: { roundId: round.idempotencyKey },
        }),
        event({
          sessionId: clientSession,
          eventName: 'interaction_reset',
          properties: { roundId: randomUUID() },
        }),
      ];
      const bEvent = event({
        sessionId: clientSession,
        eventName: 'interaction_completed',
        properties: { roundId: round.idempotencyKey },
      });
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/events',
            headers: aHeaders,
            payload: { events: aEvents },
          })
        ).json(),
      ).toEqual({ accepted: 4, duplicates: 0 });
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/events',
            headers: bHeaders,
            payload: { events: [bEvent] },
          })
        ).json(),
      ).toEqual({ accepted: 1, duplicates: 0 });
      const legacy = event({
        sessionId: clientSession,
        properties: { roundId: round.idempotencyKey },
      });
      await sql`INSERT INTO analytics_events (event_id, payload, fingerprint) VALUES (${legacy.eventId}, ${sql.json(legacy)}, ${fingerprint(legacy)})`;
      const aUrl = `/api/lab/verification/${aReceipt.json().participationId}`;
      const bUrl = `/api/lab/verification/${bReceipt.json().participationId}`;
      const verified = await app.inject({ url: aUrl, headers: { cookie: aCookie } });
      expect(verified.statusCode).toBe(200);
      expect(verified.json()).toMatchObject({
        receipt: aReceipt.json(),
        roundId: round.idempotencyKey,
        eventSummary: {
          sessionTotal: 4,
          roundTotal: 2,
          byName: [
            { eventName: 'interaction_completed', count: 1 },
            { eventName: 'interaction_started', count: 1 },
          ],
        },
      });
      expect(verified.headers['cache-control']).toBe('no-store');
      expect(verified.body).not.toContain(clientSession);
      expect(verified.body).not.toContain('sessionId');
      expect(verified.body).not.toContain('clientTime');
      expect(verified.body).not.toContain(aEvents[0]!.eventId);
      const bVerified = await app.inject({ url: bUrl, headers: { cookie: bCookie } });
      expect(bVerified.json().eventSummary).toEqual({
        sessionTotal: 1,
        roundTotal: 1,
        byName: [{ eventName: 'interaction_completed', count: 1 }],
      });
      const denied = await app.inject({ url: bUrl, headers: { cookie: aCookie } });
      const missing = await app.inject({
        url: `/api/lab/verification/${randomUUID()}`,
        headers: { cookie: aCookie },
      });
      expect(denied.statusCode).toBe(404);
      expect(missing.statusCode).toBe(404);
      expect(denied.json().error.code).toBe(missing.json().error.code);
      expect(denied.json().error.message).toBe(missing.json().error.message);
      expect((await app.inject(aUrl)).statusCode).toBe(401);
      const stolenDuplicate = await app.inject({
        method: 'POST',
        url: '/api/events',
        headers: bHeaders,
        payload: { events: [aEvents[0]] },
      });
      expect(stolenDuplicate.statusCode).toBe(409);
      const owner = (
        await sql`SELECT session_id FROM participations WHERE participation_id = ${aReceipt.json().participationId}`
      )[0]!.session_id as string;
      const late = event({ properties: { roundId: round.idempotencyKey } });
      await sql`INSERT INTO analytics_events (event_id, payload, fingerprint, owner_session_id) VALUES (${late.eventId}, ${sql.json(late)}, ${fingerprint(late)}, ${owner})`;
      const reread = await app.inject({ url: aUrl, headers: { cookie: aCookie } });
      expect(reread.json().eventSummary).toEqual({
        sessionTotal: 5,
        roundTotal: 3,
        byName: [
          { eventName: 'interaction_completed', count: 2 },
          { eventName: 'interaction_started', count: 1 },
        ],
      });
      expect(
        (
          await sql`SELECT COUNT(*)::int AS count FROM analytics_events WHERE owner_session_id IS NULL`
        )[0]?.count,
      ).toBe(1);
    } finally {
      await app.close();
    }
  });

  it('matches uppercase round and URL UUIDs while preserving original payload and stable idempotency', async () => {
    const app = await createHttpApp();
    try {
      const campaign = await app.inject('/api/campaigns/lab');
      const cookie = String(campaign.headers['set-cookie']).split(';')[0]!;
      const headers = { origin: testConfig().appOrigin, cookie };
      const request = participation({ idempotencyKey: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' });
      const receipt = await app.inject({
        method: 'POST',
        url: '/api/participations',
        headers,
        payload: request,
      });
      const retried = await app.inject({
        method: 'POST',
        url: '/api/participations',
        headers,
        payload: { ...request, idempotencyKey: request.idempotencyKey.toUpperCase() },
      });
      expect(retried.json()).toEqual(receipt.json());
      const item = event({
        eventId: 'ffffffff-aaaa-4bbb-8ccc-dddddddddddd',
        properties: { roundId: request.idempotencyKey.toUpperCase() },
      });
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/events',
            headers,
            payload: { events: [item] },
          })
        ).statusCode,
      ).toBe(200);
      const verified = await app.inject({
        url: `/api/lab/verification/${String(receipt.json().participationId).toUpperCase()}`,
        headers: { cookie },
      });
      expect(verified.statusCode).toBe(200);
      expect(verified.json().roundId).toBe(request.idempotencyKey);
      expect(verified.json().eventSummary).toEqual({
        sessionTotal: 1,
        roundTotal: 1,
        byName: [{ eventName: 'interaction_completed', count: 1 }],
      });
      expect(
        (await sql`SELECT payload FROM analytics_events WHERE event_id = ${item.eventId}`)[0]
          ?.payload.properties.roundId,
      ).toBe(request.idempotencyKey.toUpperCase());
      const changedPayload = await app.inject({
        method: 'POST',
        url: '/api/events',
        headers,
        payload: { events: [{ ...item, eventId: item.eventId.toUpperCase() }] },
      });
      expect(changedPayload.statusCode).toBe(409);
      expect(await sql`SELECT event_id FROM analytics_events`).toHaveLength(1);
    } finally {
      await app.close();
    }
  });
});
