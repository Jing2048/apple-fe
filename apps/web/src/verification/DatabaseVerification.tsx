import { useMutation, useQuery } from '@tanstack/react-query';
import type { ParticipationResponse } from '@apple/contracts';
import { api } from '../api/client';
import type { TelemetryClient } from '../telemetry/client';
import { assertSameReceipt, verifyRound, type ExpectedRound } from './round';

const eventLabels = {
  page_view: '浏览页面',
  interaction_started: '开始互动',
  interaction_completed: '完成互动',
  interaction_paused: '暂停互动',
  interaction_resumed: '继续互动',
  interaction_reset: '重开或切换探针',
  resource_failed: '素材加载失败',
} as const;

interface DatabaseVerificationProps {
  roundId: string;
  receipt: ParticipationResponse | undefined;
  telemetry: TelemetryClient;
}

export function DatabaseVerification({ roundId, receipt, telemetry }: DatabaseVerificationProps) {
  const replay = useMutation({
    retry: false,
    mutationFn: async (expected: ExpectedRound) => {
      const receipt = await api.participate({
        campaignId: expected.receipt.campaignId,
        interaction: expected.receipt.interaction,
        idempotencyKey: expected.roundId,
      });
      assertSameReceipt(expected.receipt, receipt);
      return { roundId: expected.roundId, receipt };
    },
  });
  const verification = useQuery({
    queryKey: ['round-verification', roundId, receipt?.participationId ?? null],
    enabled: false,
    retry: false,
    queryFn: ({ signal }) => {
      if (!receipt) throw new Error('请先取得本轮服务端回执。');
      return verifyRound(
        { roundId: roundId, receipt: receipt },
        {
          flush: () => telemetry.flush(),
          deliveryState: telemetry.getSnapshot,
          pendingForRound: (roundId) => telemetry.pendingForRound(roundId),
          read: api.verifyParticipation,
        },
        signal,
      );
    },
  });
  const verified =
    verification.isSuccess && !verification.isFetching && !verification.isPaused
      ? verification.data
      : undefined;
  const replayIsCurrent = replay.variables?.roundId === roundId;
  return (
    <section className="database-verification" aria-labelledby="database-verification-title">
      <div className="verification-heading">
        <h3 id="database-verification-title">数据库读回</h3>
        <span className="quiet-tag">独立 GET 核验</span>
      </div>
      <p className="verification-copy">
        提交成功和本页队列数字不能替代读回。点击后会先尝试发送待确认事件，再从服务端查询本轮记录。
      </p>
      <div className="verification-actions">
        <button
          type="button"
          className="button button-primary"
          disabled={!receipt || verification.isFetching || verification.isPaused}
          onClick={() => {
            void verification.refetch();
          }}
        >
          核验数据库记录
        </button>
        <button
          type="button"
          className="button button-secondary"
          disabled={!receipt || (replayIsCurrent && replay.isPending)}
          onClick={() => {
            if (receipt) replay.mutate({ roundId: roundId, receipt: receipt });
          }}
        >
          重发本轮请求
        </button>
      </div>

      <div className="verification-status" role="status" aria-label="数据库核验状态">
        {verification.isPaused ? (
          <p>当前离线，联网后继续核验数据库记录。</p>
        ) : verification.isFetching ? (
          <p>正在核验；等待数据库读回结果…</p>
        ) : verification.isError ? (
          <>
            <strong className="error-text">数据库核验未完成</strong>
            <p>{verification.error.message}</p>
            <p>可再次点击“核验数据库记录”重试，不需要重做互动。</p>
          </>
        ) : verified ? (
          <>
            <strong className="verification-success">已从数据库读回</strong>
            <dl className="verification-facts">
              <div>
                <dt>本轮编号</dt>
                <dd>
                  <code>{verified.database.roundId}</code>
                </dd>
              </div>
              <div>
                <dt>数据库回执</dt>
                <dd>
                  <code>{verified.database.receipt.participationId}</code>
                </dd>
              </div>
              <div>
                <dt>记录状态</dt>
                <dd>{verified.database.receipt.status} · MOCK</dd>
              </div>
              <div>
                <dt>查询时间</dt>
                <dd>
                  <time dateTime={verified.database.checkedAt}>{verified.database.checkedAt}</time>
                </dd>
              </div>
            </dl>
            {verified.deliveryWarning && (
              <p className="verification-warning">
                部分体验事件可能仍待确认或未送达。
                {verified.pendingRoundEvents > 0 &&
                  `查询发起时，本轮有 ${verified.pendingRoundEvents} 条事件等待确认。`}
                以下只显示本次查询时已经入库的数量，可稍后再次核验。
              </p>
            )}
            <div className="round-event-count" aria-label="本轮已入库事件总数">
              <span>本轮已入库事件</span>
              <strong>{verified.database.eventSummary.roundTotal} 条</strong>
            </div>
            {verified.database.eventSummary.byName.length > 0 ? (
              <table className="round-event-table">
                <caption>本轮已入库事件明细</caption>
                <thead>
                  <tr>
                    <th scope="col">事件</th>
                    <th scope="col">次数</th>
                  </tr>
                </thead>
                <tbody>
                  {verified.database.eventSummary.byName.map(({ eventName, count }) => (
                    <tr key={eventName}>
                      <td>
                        {eventLabels[eventName]}
                        <code>{eventName}</code>
                      </td>
                      <td>{count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p>本次查询未发现本轮已入库事件。拒绝体验埋点不会影响参与记录的保存与核验。</p>
            )}
            <p className="session-event-count">
              当前会话跨活动累计事件：{verified.database.eventSummary.sessionTotal}{' '}
              条，包含其他轮次及未关联轮次的事件。
            </p>
          </>
        ) : (
          <p>
            {receipt
              ? '已取得提交回执，尚未独立核验数据库记录。'
              : '等待本轮服务端回执后，即可核验数据库记录。'}
          </p>
        )}
      </div>

      {replayIsCurrent && (replay.isPending || replay.isError || replay.data) && (
        <div className="replay-status" role="status" aria-label="重发核对状态">
          {replay.isPaused ? (
            <p>当前离线；联网后会用同一本轮编号重发。</p>
          ) : replay.isPending ? (
            <p>正在使用同一本轮编号重发请求…</p>
          ) : replay.isError ? (
            <>
              <strong className="error-text">重发核对未完成</strong>
              <p>{replay.error.message}</p>
              <p>可再次点击“重发本轮请求”重试。</p>
            </>
          ) : replay.data?.roundId === roundId ? (
            <>
              <strong className="verification-success">回执一致</strong>
              <p>同一本轮编号返回了相同回执。</p>
              <code>{replay.data.receipt.participationId}</code>
            </>
          ) : null}
        </div>
      )}
    </section>
  );
}
