import type { ParticipationResponse, VerificationResponse } from '@apple/contracts';

export interface ExpectedRound {
  roundId: string;
  receipt: ParticipationResponse;
}

export interface VerifiedRound {
  database: VerificationResponse;
  pendingRoundEvents: number;
  deliveryWarning: boolean;
}

interface VerificationDependencies {
  flush: () => Promise<void>;
  deliveryState: () => { queued: number; dropped: number; lastError: string | null };
  pendingForRound: (roundId: string) => number;
  read: (participationId: string, signal?: AbortSignal) => Promise<VerificationResponse>;
}

function sameReceipt(expected: ParticipationResponse, actual: ParticipationResponse): boolean {
  return (
    expected.participationId.toLowerCase() === actual.participationId.toLowerCase() &&
    expected.campaignId === actual.campaignId &&
    expected.interaction === actual.interaction &&
    expected.status === actual.status &&
    expected.providerMode === actual.providerMode &&
    expected.createdAt === actual.createdAt
  );
}

export function assertSameReceipt(
  expected: ParticipationResponse,
  actual: ParticipationResponse,
): void {
  if (!sameReceipt(expected, actual)) throw new Error('回执与本轮原始回执不一致，幂等核对未通过。');
}

export function assertRoundVerification(
  expected: ExpectedRound,
  actual: VerificationResponse,
): void {
  if (actual.roundId.toLowerCase() !== expected.roundId.toLowerCase())
    throw new Error('数据库返回的轮次与当前轮次不一致。');
  assertSameReceipt(expected.receipt, actual.receipt);
  const { roundTotal, sessionTotal, byName } = actual.eventSummary;
  if (
    roundTotal > sessionTotal ||
    byName.reduce((sum, item) => sum + item.count, 0) !== roundTotal ||
    new Set(byName.map((item) => item.eventName)).size !== byName.length
  ) {
    throw new Error('数据库事件统计不一致，无法确认本轮事件数量。');
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Verification cancelled', 'AbortError');
}

/** Queue acknowledgements only improve freshness. The GET response is the read-back evidence. */
export async function verifyRound(
  expected: ExpectedRound,
  dependencies: VerificationDependencies,
  signal?: AbortSignal,
): Promise<VerifiedRound> {
  throwIfAborted(signal);
  let flushFailed = false;
  // The SDK has a bounded 200-event queue and 50-event batches. Stop if a batch
  // makes no progress; a failed request must not become an unbounded retry loop.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const before = dependencies.deliveryState().queued;
    if (before === 0) break;
    try {
      await dependencies.flush();
    } catch {
      flushFailed = true;
      break;
    }
    throwIfAborted(signal);
    if (dependencies.deliveryState().queued >= before) break;
  }
  throwIfAborted(signal);
  const delivery = dependencies.deliveryState();
  const pendingRoundEvents = dependencies.pendingForRound(expected.roundId);
  const database = await dependencies.read(expected.receipt.participationId, signal);
  throwIfAborted(signal);
  assertRoundVerification(expected, database);
  return {
    database,
    pendingRoundEvents,
    deliveryWarning:
      flushFailed || pendingRoundEvents > 0 || delivery.lastError !== null || delivery.dropped > 0,
  };
}
