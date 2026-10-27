import { describe, expect, it, vi } from 'vitest';
import type { VerificationResponse } from '@apple/contracts';
import { assertSameReceipt, assertRoundVerification, verifyRound } from './round';

const receipt = {
  participationId: 'c941ad64-a313-43f1-90f0-2844528c9896',
  campaignId: 'lab',
  interaction: 'timing',
  status: 'recorded',
  providerMode: 'mock',
  createdAt: '2026-10-27T00:00:00.000Z',
} as const;
const roundId = '4e8b3ae7-b069-47d0-a3a8-b849ef2519a1';
const database: VerificationResponse = {
  receipt,
  roundId,
  checkedAt: '2026-10-27T00:00:01.000Z',
  eventSummary: {
    sessionTotal: 7,
    roundTotal: 2,
    byName: [
      { eventName: 'interaction_started', count: 1 },
      { eventName: 'interaction_completed', count: 1 },
    ],
  },
};

describe('database read-back evidence', () => {
  it('requires the database response to match both the round and the original receipt', () => {
    expect(() => assertRoundVerification({ roundId, receipt }, database)).not.toThrow();
    expect(() =>
      assertRoundVerification(
        { roundId, receipt },
        { ...database, roundId: receipt.participationId },
      ),
    ).toThrow('轮次');
    expect(() =>
      assertSameReceipt(receipt, { ...receipt, createdAt: '2026-10-27T00:00:02.000Z' }),
    ).toThrow('回执');
    expect(() => assertSameReceipt(receipt, { ...receipt, campaignId: 'spring-sale' })).toThrow(
      '回执',
    );
    expect(() =>
      assertRoundVerification({ roundId: roundId.toUpperCase(), receipt }, database),
    ).not.toThrow();
    expect(() =>
      assertRoundVerification(
        { roundId, receipt },
        {
          ...database,
          eventSummary: { ...database.eventSummary, roundTotal: 99 },
        },
      ),
    ).toThrow('统计');
  });

  it('flushes pending batches before reading, but only returns the actual GET evidence', async () => {
    let queued = 2;
    const sequence: string[] = [];
    const result = await verifyRound(
      { roundId, receipt },
      {
        flush: async () => {
          sequence.push('ack');
          queued -= 1;
        },
        deliveryState: () => ({ queued, dropped: 0, lastError: null }),
        pendingForRound: () => queued,
        read: async () => {
          sequence.push('read');
          return database;
        },
      },
    );
    expect(sequence).toEqual(['ack', 'ack', 'read']);
    expect(result).toEqual({ database, pendingRoundEvents: 0, deliveryWarning: false });
    expect(result.database.eventSummary.roundTotal).toBe(2);
    expect(result.database.eventSummary.sessionTotal).toBe(7);
  });

  it('reads when delivery fails, keeping real database counts and a pending-event warning', async () => {
    const flush = vi.fn().mockRejectedValue(new Error('offline'));
    const read = vi.fn().mockResolvedValue({
      ...database,
      eventSummary: { sessionTotal: 1, roundTotal: 0, byName: [] },
    });
    const result = await verifyRound(
      { roundId, receipt },
      {
        flush,
        read,
        deliveryState: () => ({ queued: 3, dropped: 0, lastError: 'not acknowledged' }),
        pendingForRound: () => 2,
      },
    );
    expect(flush).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      pendingRoundEvents: 2,
      deliveryWarning: true,
      database: { eventSummary: { roundTotal: 0 } },
    });
  });

  it('does not read a stale round after cancellation during a flush', async () => {
    const controller = new AbortController();
    const read = vi.fn();
    await expect(
      verifyRound(
        { roundId, receipt },
        {
          flush: async () => {
            controller.abort();
          },
          read,
          deliveryState: () => ({ queued: 1, dropped: 0, lastError: null }),
          pendingForRound: () => 1,
        },
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(read).not.toHaveBeenCalled();
  });

  it('does not replace a failed read with client acknowledgements', async () => {
    await expect(
      verifyRound(
        { roundId, receipt },
        {
          flush: vi.fn(),
          read: vi.fn().mockRejectedValue(new Error('database unavailable')),
          deliveryState: () => ({ queued: 0, dropped: 0, lastError: null }),
          pendingForRound: () => 0,
        },
      ),
    ).rejects.toThrow('database unavailable');
  });
});
