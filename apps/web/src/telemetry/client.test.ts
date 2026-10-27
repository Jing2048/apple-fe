import { describe, expect, it, vi } from 'vitest';
import type { EventProperties } from '@apple/contracts';
import { TelemetryClient, sanitizeProperties } from './client';

function makeClient(fetcher: typeof fetch, maxQueue = 200) {
  let id = 0;
  return new TelemetryClient({
    campaignId: 'lab',
    releaseId: 'test-release',
    fetch: fetcher,
    maxQueue,
    automatic: false,
    makeId: () => `00000000-0000-4000-8000-${String(++id).padStart(12, '0')}`,
    now: () => new Date('2026-01-01T00:00:00Z'),
  });
}

describe('optional first-party telemetry', () => {
  it('rejects an invalid campaign identifier before queueing events', () => {
    for (const campaignId of ['', 'UPPERCASE', 'invalid_campaign', 'x'.repeat(65)]) {
      expect(() => new TelemetryClient({ campaignId, releaseId: 'test-release' })).toThrow(
        'campaign identifier',
      );
    }
  });

  it('uses the explicitly configured campaign instead of the workbench entry', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ accepted: 1, duplicates: 0 })));
    const client = new TelemetryClient({
      campaignId: 'spring-sale',
      releaseId: 'test-release',
      fetch: fetcher,
      automatic: false,
    });
    client.setConsent(true);
    client.track('page_view');
    await client.flush();
    const batch = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)) as {
      events: { campaignId: string }[];
    };
    expect(batch.events).toHaveLength(1);
    expect(batch.events[0]?.campaignId).toBe('spring-sale');
  });

  it('sends nothing until consent and clears unsent data when consent is withdrawn', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const client = makeClient(fetcher);
    expect(client.track('page_view')).toBe(false);
    await client.flush();
    expect(fetcher).not.toHaveBeenCalled();
    client.setConsent(true);
    client.track('page_view');
    client.setConsent(false);
    expect(client.getSnapshot().queued).toBe(0);
    await client.flush();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('retries identical identifiers after failure and removes only acknowledged events', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ accepted: 0, duplicates: 1 })));
    const client = makeClient(fetcher);
    client.setConsent(true);
    client.track('page_view');
    await client.flush();
    expect(client.getSnapshot().queued).toBe(1);
    await client.flush();
    expect(fetcher.mock.calls[0]?.[1]?.body).toBe(fetcher.mock.calls[1]?.[1]?.body);
    expect(client.getSnapshot()).toMatchObject({ queued: 0, accepted: 0, duplicates: 1 });
  });

  it('does not treat beacon acceptance or an invalid acknowledgement as persistence', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}'));
    const client = makeClient(fetcher);
    client.setConsent(true);
    client.track('page_view');
    expect(client.beacon(() => true)).toBe(true);
    expect(client.getSnapshot().queued).toBe(1);
    await client.flush();
    expect(client.getSnapshot()).toMatchObject({ queued: 1, accepted: 0 });
  });

  it('bounds the queue and drops properties outside the contract', () => {
    const client = makeClient(vi.fn<typeof fetch>(), 1);
    client.setConsent(true);
    expect(client.track('page_view')).toBe(true);
    expect(client.track('page_view')).toBe(false);
    expect(client.getSnapshot()).toMatchObject({ queued: 1, dropped: 1 });
    expect(
      sanitizeProperties({
        interaction: 'swipe',
        steps: 3,
        durationMs: -1,
        email: 'do-not-collect@example.invalid',
      } as EventProperties),
    ).toEqual({ interaction: 'swipe', steps: 3 });
  });

  it('retains queued data when the browser rejects a beacon operation', () => {
    const client = makeClient(vi.fn<typeof fetch>());
    client.setConsent(true);
    client.track('page_view');
    expect(
      client.beacon(() => {
        throw new TypeError('Browser rejected beacon');
      }),
    ).toBe(false);
    expect(client.getSnapshot()).toMatchObject({ queued: 1, accepted: 0 });
  });

  it('keeps valid round identifiers and drops invalid or unknown properties', async () => {
    const roundId = '4e8b3ae7-b069-47d0-a3a8-b849ef2519a1';
    expect(sanitizeProperties({ roundId: roundId.toUpperCase(), interaction: 'timing' })).toEqual({
      roundId,
      interaction: 'timing',
    });
    expect(
      sanitizeProperties({
        roundId: 'not-a-round',
        email: 'never-send@example.invalid',
      } as EventProperties),
    ).toEqual({});
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ accepted: 1, duplicates: 0 })));
    const client = makeClient(fetcher);
    expect(client.track('interaction_started', { roundId })).toBe(false);
    client.setConsent(true);
    client.track('interaction_completed', { roundId });
    expect(client.pendingForRound(roundId)).toBe(1);
    expect(client.pendingForRound('other-round')).toBe(0);
    await client.flush();
    const batch = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)) as {
      events: { eventName: string; properties: EventProperties }[];
    };
    expect(batch.events).toHaveLength(1);
    expect(batch.events[0]).toMatchObject({
      eventName: 'interaction_completed',
      properties: { roundId },
    });
    expect(client.pendingForRound(roundId)).toBe(0);
  });

  it('aborts inflight work and ignores a late acknowledgement after withdrawal', async () => {
    let resolve: ((response: Response) => void) | undefined;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const client = makeClient(fetcher);
    client.setConsent(true);
    client.track('page_view');
    const sending = client.flush();
    client.setConsent(false);
    expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    resolve?.(new Response(JSON.stringify({ accepted: 1, duplicates: 0 })));
    await sending;
    expect(client.getSnapshot()).toMatchObject({ consent: false, queued: 0, accepted: 0 });
  });

  it('serializes flush calls and does not lose events added during a request', async () => {
    let resolve: ((response: Response) => void) | undefined;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const client = makeClient(fetcher);
    client.setConsent(true);
    client.track('page_view');
    const sending = client.flush();
    expect(client.flush()).toBe(sending);
    client.track('interaction_started', { interaction: 'timing' });
    resolve?.(new Response(JSON.stringify({ accepted: 1, duplicates: 0 })));
    await sending;
    expect(client.getSnapshot()).toMatchObject({ queued: 1, accepted: 1 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
