import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { labCampaign, type Campaign } from '@apple/contracts';
import { buildApp } from '../src/app.js';
import { CampaignCatalog } from '../src/campaigns.js';
import { MemoryStore } from '../src/store/memory.js';
import { event, participation, secondCampaign, testConfig } from './fixtures.js';

describe('trusted campaign configuration', () => {
  it('rejects invalid or duplicate IDs and invalid interaction sets at startup', () => {
    expect(() => new CampaignCatalog([labCampaign, labCampaign])).toThrow('duplicate IDs');
    for (const id of ['', 'unsafe/path', 'a--b', 'ends-', 'a'.repeat(65)]) {
      expect(() => new CampaignCatalog([{ ...labCampaign, id }])).toThrow('runtime contract');
    }
    for (const interactions of [[], ['timing', 'timing'], ['unknown']]) {
      expect(() => new CampaignCatalog([{ ...labCampaign, interactions } as Campaign])).toThrow(
        'runtime contract',
      );
    }
  });

  it('rejects invalid versions, titles, and asset metadata before serving the campaign', () => {
    const asset = labCampaign.assets[0]!;
    const invalid: Campaign[] = [
      { ...labCampaign, version: '' },
      { ...labCampaign, version: 'invalid version' },
      { ...labCampaign, title: '' },
      { ...labCampaign, assets: [{ ...asset, url: '/assets/../secret.svg' }] },
      { ...labCampaign, assets: [{ ...asset, url: 'https://external.example/image.svg' }] },
      { ...labCampaign, assets: [{ ...asset, bytes: -1 }] },
    ];
    for (const campaign of invalid) {
      expect(() => new CampaignCatalog([campaign])).toThrow('runtime contract');
    }
  });

  it('takes a deeply frozen snapshot instead of retaining mutable caller configuration', () => {
    const source = structuredClone(labCampaign);
    const catalog = new CampaignCatalog([source]);
    source.title = 'mutated outside catalog';
    source.interactions.length = 0;
    const actual = catalog.require('lab');
    expect(actual.title).toBe(labCampaign.title);
    expect(actual.interactions).toEqual(labCampaign.interactions);
    expect(Object.isFrozen(actual)).toBe(true);
    expect(Object.isFrozen(actual.interactions)).toBe(true);
    expect(Object.isFrozen(actual.assets)).toBe(true);
  });
});

describe('API boundaries with an explicit unit-test store', () => {
  let app: FastifyInstance;
  let store: MemoryStore;
  let signedCookie: string;
  const origin = { origin: 'http://localhost:5173' };

  beforeEach(async () => {
    store = new MemoryStore();
    app = await buildApp({ store, config: testConfig(), logger: false });
    signedCookie = await sessionCookie();
  });
  afterEach(async () => {
    await app.close();
  });

  async function sessionCookie(): Promise<string> {
    const result = await app.inject({ method: 'GET', url: '/api/campaigns/lab' });
    return String(result.headers['set-cookie']).split(';')[0]!;
  }

  it('distinguishes liveness and database readiness', async () => {
    expect((await app.inject('/api/health')).json()).toEqual({
      status: 'ok',
      releaseId: 'test-release',
    });
    expect((await app.inject('/api/ready')).statusCode).toBe(200);
    store.available = false;
    const result = await app.inject('/api/ready');
    expect(result.statusCode).toBe(503);
    expect(result.json().error.code).toBe('NOT_READY');
  });

  it('provides a safe anonymous session and explicit campaign metadata', async () => {
    const response = await app.inject('/api/campaigns/lab');
    expect(response.json()).toMatchObject({ id: 'lab', privacy: { analyticsOptional: true } });
    const cookie = String(response.headers['set-cookie']);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Path=/api');
    expect(cookie).toMatch(/campaign_session=[0-9a-f-]{36}\.[A-Za-z0-9+/=_%-]+/);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
  });

  it('does not register test campaigns by default and rejects unknown campaign writes atomically', async () => {
    const headers = { ...origin, cookie: signedCookie };
    expect((await app.inject('/api/campaigns/test-second')).statusCode).toBe(404);
    const unknownParticipation = await app.inject({
      method: 'POST',
      url: '/api/participations',
      headers,
      payload: participation({ campaignId: 'unknown' }),
    });
    expect(unknownParticipation.statusCode).toBe(404);
    const unknownEvents = await app.inject({
      method: 'POST',
      url: '/api/events',
      headers,
      payload: { events: [event(), event({ campaignId: 'unknown' })] },
    });
    expect(unknownEvents.statusCode).toBe(404);
    expect(store.participations.size).toBe(0);
    expect(store.events.size).toBe(0);
  });

  it('serves the original cloud-post demo through the default reusable campaign pipeline', async () => {
    const campaign = await app.inject('/api/campaigns/cloud-post');
    expect(campaign.statusCode).toBe(200);
    expect(campaign.json()).toEqual({
      id: 'cloud-post',
      version: 'cloud-post-v1',
      title: '云朵邮局',
      interactions: ['swipe'],
      assets: [],
      privacy: { analyticsOptional: true },
    });
    expect(campaign.headers['set-cookie']).toContain('HttpOnly');
    const cookie = String(campaign.headers['set-cookie']).split(';')[0]!;
    const headers = { ...origin, cookie };
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
    expect(store.events.size).toBe(0);
    expect(store.participations.size).toBe(0);
    const browserOnlyText = await app.inject({
      method: 'POST',
      url: '/api/participations',
      headers,
      payload: { ...request, blessing: 'browser-only content' },
    });
    expect(browserOnlyText.statusCode).toBe(400);
    expect(store.participations.size).toBe(0);
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
    expect(cloud.json().campaignId).toBe('cloud-post');
    expect(cloud.json().participationId).not.toBe(lab.json().participationId);
    const retried = await app.inject({
      method: 'POST',
      url: '/api/participations',
      headers,
      payload: request,
    });
    expect(retried.json()).toEqual(cloud.json());
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
    expect(store.participations.size).toBe(2);
  });

  it('uses injected campaign configuration and enforces campaign-specific interactions', async () => {
    const configured = await buildApp({
      store,
      config: testConfig(),
      logger: false,
      campaigns: [labCampaign, secondCampaign],
    });
    try {
      const response = await configured.inject('/api/campaigns/test-second');
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(secondCampaign);
      const cookie = String(response.headers['set-cookie']).split(';')[0]!;
      const headers = { ...origin, cookie };
      const unsupported = await configured.inject({
        method: 'POST',
        url: '/api/participations',
        headers,
        payload: participation({ campaignId: secondCampaign.id, interaction: 'timing' }),
      });
      expect(unsupported.statusCode).toBe(400);
      expect(unsupported.json().error.code).toBe('INTERACTION_NOT_SUPPORTED');
      const unsupportedEvents = await configured.inject({
        method: 'POST',
        url: '/api/events',
        headers,
        payload: {
          events: [
            event(),
            event({ campaignId: secondCampaign.id, properties: { interaction: 'timing' } }),
          ],
        },
      });
      expect(unsupportedEvents.statusCode).toBe(400);
      expect(store.events.size).toBe(0);
      expect(store.participations.size).toBe(0);
      const request = participation({ interaction: 'swipe' });
      const first = await configured.inject({
        method: 'POST',
        url: '/api/participations',
        headers,
        payload: request,
      });
      const second = await configured.inject({
        method: 'POST',
        url: '/api/participations',
        headers,
        payload: { ...request, campaignId: secondCampaign.id },
      });
      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      expect(second.json().campaignId).toBe(secondCampaign.id);
      expect(first.json().participationId).not.toBe(second.json().participationId);
      const events = [
        event({ properties: { roundId: request.idempotencyKey } }),
        event({
          campaignId: secondCampaign.id,
          properties: { roundId: request.idempotencyKey, interaction: 'swipe' },
        }),
      ];
      expect(
        (
          await configured.inject({
            method: 'POST',
            url: '/api/events',
            headers,
            payload: { events },
          })
        ).statusCode,
      ).toBe(200);
      for (const receipt of [first, second]) {
        const verified = await configured.inject({
          url: `/api/lab/verification/${receipt.json().participationId}`,
          headers: { cookie },
        });
        expect(verified.json().eventSummary).toEqual({
          sessionTotal: 2,
          roundTotal: 1,
          byName: [{ eventName: 'interaction_completed', count: 1 }],
        });
      }
    } finally {
      await configured.close();
    }
  });

  it('records a participation without claiming an award or real provider result', async () => {
    const cookie = await sessionCookie();
    const result = await app.inject({
      method: 'POST',
      url: '/api/participations',
      headers: { ...origin, cookie },
      payload: participation(),
    });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({
      status: 'recorded',
      providerMode: 'mock',
      interaction: 'timing',
    });
    expect(result.json()).not.toHaveProperty('award');
  });

  it('rejects missing and forged anonymous sessions', async () => {
    for (const cookie of [
      '',
      `campaign_session=${randomUUID()}`,
      'campaign_session=not-a-session',
    ]) {
      const result = await app.inject({
        method: 'POST',
        url: '/api/participations',
        headers: { ...origin, cookie },
        payload: participation(),
      });
      expect(result.statusCode).toBe(401);
      expect(result.json().error.code).toBe('SESSION_REQUIRED');
    }
  });

  it('rejects tampering with a signed session', async () => {
    const cookie = await sessionCookie();
    const tampered = cookie.slice(0, -1) + (cookie.endsWith('x') ? 'y' : 'x');
    const result = await app.inject({
      method: 'POST',
      url: '/api/participations',
      headers: { ...origin, cookie: tampered },
      payload: participation(),
    });
    expect(result.statusCode).toBe(401);
  });

  it('returns the same receipt on retries and conflicts on changed content', async () => {
    const cookie = await sessionCookie();
    const request = participation();
    const submit = (payload: Record<string, unknown>) =>
      app.inject({
        method: 'POST',
        url: '/api/participations',
        headers: { ...origin, cookie },
        payload,
      });
    const first = await submit(request);
    const retry = await submit(request);
    expect(retry.json()).toEqual(first.json());
    expect(store.participations.size).toBe(1);
    const conflict = await submit({ ...request, interaction: 'swipe' });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it.each([undefined, 'https://attacker.example', 'http://localhost:5173.attacker.example'])(
    'rejects unsafe origin %s',
    async (unsafeOrigin) => {
      const headers: Record<string, string> = {};
      if (unsafeOrigin) headers.origin = unsafeOrigin;
      const result = await app.inject({
        method: 'POST',
        url: '/api/events',
        headers,
        payload: { events: [event()] },
      });
      expect(result.statusCode).toBe(403);
      expect(store.events.size).toBe(0);
    },
  );

  it('accepts a valid event only once, including retries within one batch', async () => {
    const item = event();
    const submit = (events: unknown[]) =>
      app.inject({
        method: 'POST',
        url: '/api/events',
        headers: { ...origin, cookie: signedCookie },
        payload: { events },
      });
    expect((await submit([item, item])).json()).toEqual({ accepted: 1, duplicates: 1 });
    expect((await submit([item])).json()).toEqual({ accepted: 0, duplicates: 1 });
    expect(store.events.size).toBe(1);
  });

  it('requires a signed session before accepting analytics events', async () => {
    const result = await app.inject({
      method: 'POST',
      url: '/api/events',
      headers: origin,
      payload: { events: [event()] },
    });
    expect(result.statusCode).toBe(401);
    expect(result.json().error.code).toBe('SESSION_REQUIRED');
    expect(store.events.size).toBe(0);
  });

  it('does not count another signed session event as its own duplicate', async () => {
    const item = event();
    const first = await app.inject({
      method: 'POST',
      url: '/api/events',
      headers: { ...origin, cookie: signedCookie },
      payload: { events: [item] },
    });
    expect(first.json()).toEqual({ accepted: 1, duplicates: 0 });
    const secondCookie = await sessionCookie();
    const second = await app.inject({
      method: 'POST',
      url: '/api/events',
      headers: { ...origin, cookie: secondCookie },
      payload: { events: [item] },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('EVENT_CONFLICT');
    expect(store.events.size).toBe(1);
  });

  it('reads server verification scoped to the signed session and receipt round', async () => {
    const headers = { ...origin, cookie: signedCookie };
    const request = participation();
    const receipt = await app.inject({
      method: 'POST',
      url: '/api/participations',
      headers,
      payload: request,
    });
    const events = [
      event({ eventName: 'interaction_started', properties: { roundId: request.idempotencyKey } }),
      event({
        eventName: 'interaction_completed',
        properties: { roundId: request.idempotencyKey },
      }),
      event({ eventName: 'page_view', properties: {} }),
      event({ eventName: 'interaction_completed', properties: { roundId: randomUUID() } }),
    ];
    expect(
      (await app.inject({ method: 'POST', url: '/api/events', headers, payload: { events } }))
        .statusCode,
    ).toBe(200);
    const response = await app.inject({
      url: `/api/lab/verification/${receipt.json().participationId}`,
      headers: { cookie: signedCookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      receipt: receipt.json(),
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
    expect(Number.isFinite(Date.parse(response.json().checkedAt))).toBe(true);
    expect(response.body).not.toContain('sessionId');
    expect(response.body).not.toContain('clientTime');
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('does not distinguish missing from another session receipts', async () => {
    const request = participation();
    const receipt = await app.inject({
      method: 'POST',
      url: '/api/participations',
      headers: { ...origin, cookie: signedCookie },
      payload: request,
    });
    const url = `/api/lab/verification/${receipt.json().participationId}`;
    const unauthenticated = await app.inject(url);
    expect(unauthenticated.statusCode).toBe(401);
    const secondCookie = await sessionCookie();
    const other = await app.inject({ url, headers: { cookie: secondCookie } });
    const missing = await app.inject({
      url: `/api/lab/verification/${randomUUID()}`,
      headers: { cookie: secondCookie },
    });
    expect(other.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
    expect(other.json().error.message).toBe(missing.json().error.message);
    expect(other.json().error.code).toBe(missing.json().error.code);
  });

  it('compares UUID identifiers case-insensitively without rewriting stored event payloads', async () => {
    const headers = { ...origin, cookie: signedCookie };
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
      headers: { cookie: signedCookie },
    });
    expect(verified.statusCode).toBe(200);
    expect(verified.json().roundId).toBe(request.idempotencyKey);
    expect(verified.json().eventSummary.roundTotal).toBe(1);
    expect(store.events.get(item.eventId)?.event.properties.roundId).toBe(
      request.idempotencyKey.toUpperCase(),
    );
    const changedPayload = await app.inject({
      method: 'POST',
      url: '/api/events',
      headers,
      payload: { events: [{ ...item, eventId: item.eventId.toUpperCase() }] },
    });
    expect(changedPayload.statusCode).toBe(409);
    expect(store.events.size).toBe(1);
  });

  it('does not confuse object key ordering with an event identity conflict', async () => {
    const item = event();
    const reordered = Object.fromEntries(Object.entries(item).reverse());
    const result = await app.inject({
      method: 'POST',
      url: '/api/events',
      headers: { ...origin, cookie: signedCookie },
      payload: { events: [item, reordered] },
    });
    expect(result.json()).toEqual({ accepted: 1, duplicates: 1 });
  });

  it('rolls back the whole batch when an event ID is reused with different content', async () => {
    const item = event();
    await app.inject({
      method: 'POST',
      url: '/api/events',
      headers: { ...origin, cookie: signedCookie },
      payload: { events: [item] },
    });
    const fresh = event();
    const result = await app.inject({
      method: 'POST',
      url: '/api/events',
      headers: { ...origin, cookie: signedCookie },
      payload: { events: [fresh, { ...item, eventName: 'page_view' }] },
    });
    expect(result.statusCode).toBe(409);
    expect(store.events.has(fresh.eventId)).toBe(false);
    expect(store.events.size).toBe(1);
  });

  it.each([
    () => ({ ...event(), email: 'not-collected@example.test' }),
    () => ({ ...event(), properties: { email: 'not-collected@example.test' } }),
    () => ({ ...event(), eventName: 'purchase' }),
    () => ({ ...event(), properties: { steps: -1 } }),
    () => ({ ...event(), eventId: 'not-a-uuid' }),
  ])(
    'rejects undeclared or invalid event attributes instead of silently stripping them',
    async (makeItem) => {
      const result = await app.inject({
        method: 'POST',
        url: '/api/events',
        headers: { ...origin, cookie: signedCookie },
        payload: { events: [makeItem()] },
      });
      expect(result.statusCode).toBe(400);
      expect(result.json().error.code).toBe('VALIDATION_ERROR');
      expect(store.events.size).toBe(0);
    },
  );

  it('enforces batch limits', async () => {
    for (const events of [[], Array.from({ length: 51 }, () => event())]) {
      const result = await app.inject({
        method: 'POST',
        url: '/api/events',
        headers: { ...origin, cookie: signedCookie },
        payload: { events },
      });
      expect(result.statusCode).toBe(400);
    }
  });

  it('rejects an oversized payload before attempting to persist it', async () => {
    const result = await app.inject({
      method: 'POST',
      url: '/api/events',
      headers: { ...origin, cookie: signedCookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ events: [], padding: 'x'.repeat(140_000) }),
    });
    expect(result.statusCode).toBe(413);
    expect(result.json().error.code).toBe('PAYLOAD_TOO_LARGE');
    expect(store.events.size).toBe(0);
  });

  it('applies ingestion rate limits even to otherwise valid retries', async () => {
    const item = event();
    let last;
    for (let attempt = 0; attempt < 121; attempt++) {
      last = await app.inject({
        method: 'POST',
        url: '/api/events',
        headers: { ...origin, cookie: signedCookie },
        payload: { events: [item] },
      });
    }
    expect(last?.statusCode).toBe(429);
    expect(last?.json().error.code).toBe('RATE_LIMITED');
    expect(store.events.size).toBe(1);
  });

  it('rejects a client-supplied score or business result', async () => {
    const cookie = await sessionCookie();
    const result = await app.inject({
      method: 'POST',
      url: '/api/participations',
      headers: { ...origin, cookie },
      payload: { ...participation(), score: 999, winner: true },
    });
    expect(result.statusCode).toBe(400);
    expect(store.participations.size).toBe(0);
  });

  it('provides generated OpenAPI with strict request schemas', async () => {
    const result = await app.inject('/api/openapi.json');
    expect(result.statusCode).toBe(200);
    const spec = result.json();
    expect(spec.paths['/api/events'].post.requestBody).toBeDefined();
    expect(spec.paths['/api/participations'].post.requestBody).toBeDefined();
    expect(spec.info.description).toContain('mock');
  });

  it('generates correlation IDs without trusting arbitrary client header values', async () => {
    const result = await app.inject({
      url: '/missing',
      headers: { 'x-request-id': 'attacker-controlled' },
    });
    expect(result.statusCode).toBe(404);
    expect(result.json().error.requestId).not.toBe('attacker-controlled');
    expect(result.headers['x-request-id']).toBe(result.json().error.requestId);
  });

  it('does not expose internal database errors to clients', async () => {
    store.ingestEvents = async () => {
      throw new Error('postgres://secret-password@internal-database');
    };
    const result = await app.inject({
      method: 'POST',
      url: '/api/events',
      headers: { ...origin, cookie: signedCookie },
      payload: { events: [event()] },
    });
    expect(result.statusCode).toBe(500);
    expect(result.body).not.toContain('secret-password');
    expect(result.json().error.code).toBe('INTERNAL_ERROR');
  });
});
