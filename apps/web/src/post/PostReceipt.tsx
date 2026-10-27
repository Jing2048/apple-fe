import { useEffect, useRef } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import type { TelemetryClient } from '../telemetry/client';
import { verifyRound } from '../verification/round';

interface PostReceiptProps {
  roundId: string;
  sessionReady: boolean;
  telemetry: TelemetryClient;
  recovered: boolean;
}

/** A round-keyed component keeps delayed responses away from a freshly started letter. */
export function PostReceipt({ roundId, sessionReady, telemetry, recovered }: PostReceiptProps) {
  const started = useRef(false);
  const submission = useMutation({ mutationFn: api.participate, retry: false });
  const receipt = submission.variables?.idempotencyKey === roundId ? submission.data : undefined;
  const submit = () =>
    submission.mutate({ campaignId: 'cloud-post', interaction: 'swipe', idempotencyKey: roundId });
  useEffect(() => {
    if (!sessionReady || started.current) return;
    started.current = true;
    submission.mutate({ campaignId: 'cloud-post', interaction: 'swipe', idempotencyKey: roundId });
  }, [roundId, sessionReady, submission.mutate]);
  const verification = useQuery({
    queryKey: ['cloud-post-verification', roundId, receipt?.participationId ?? null],
    enabled: false,
    retry: false,
    queryFn: ({ signal }) => {
      if (!receipt) throw new Error('本轮尚未收到服务端确认。');
      return verifyRound(
        { roundId, receipt },
        {
          flush: () => telemetry.flush(),
          deliveryState: telemetry.getSnapshot,
          pendingForRound: (id) => telemetry.pendingForRound(id),
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
  return (
    <div className="post-receipt">
      <div className="post-save-status" role="status" aria-label="祝福保存状态">
        {receipt ? (
          <>
            <span className="post-save-check" aria-hidden="true">
              ✓
            </span>
            <strong>这封星光已保存</strong>
            <p>互动记录已保存。祝福卡留在本机，不会发送真实邮件。</p>
          </>
        ) : submission.isPaused ? (
          <>
            <strong>星光先留在你手里</strong>
            <p>当前离线，联网后会继续保存同一封信。</p>
          </>
        ) : submission.isError ? (
          <>
            <strong>信封还在，星光也在</strong>
            <p>这次还没有收到保存确认，可以用同一封信重试。</p>
            <button
              type="button"
              onClick={submit}
              className="post-small-button"
              disabled={!sessionReady}
            >
              重试保存祝福
            </button>
          </>
        ) : (
          <>
            <strong>
              {recovered ? '已找回这封星光，正在重新确认' : '正在为这次相遇盖上邮戳…'}
            </strong>
            <p>收到服务端回执后，才会显示已保存。</p>
          </>
        )}
      </div>
      <details className="post-diagnostics">
        <summary>验收记录</summary>
        <div className="post-diagnostics-body">
          <p>
            祝福文字只在本机切换。以下核验的是本次互动记录与已入库事件，外部业务接口仍为模拟适配器。
          </p>
          <dl>
            <div>
              <dt>本轮编号</dt>
              <dd>
                <code>{roundId}</code>
              </dd>
            </div>
            <div>
              <dt>提交回执</dt>
              <dd>
                <code>{receipt?.participationId ?? '等待确认'}</code>
              </dd>
            </div>
          </dl>
          <button
            type="button"
            className="post-small-button"
            disabled={!receipt || verification.isFetching || verification.isPaused}
            onClick={() => {
              void verification.refetch();
            }}
          >
            核验数据库记录
          </button>
          <div role="status" aria-label="邮局数据库核验状态">
            {verification.isPaused ? (
              <p>当前离线，联网后继续核验。</p>
            ) : verification.isFetching ? (
              <p>正在独立读取数据库记录…</p>
            ) : verification.isError ? (
              <p>核验未完成：{verification.error.message} 可再次点击按钮重试。</p>
            ) : verified ? (
              <>
                <strong>已从数据库读回</strong>
                <p>本轮已入库事件：{verified.database.eventSummary.roundTotal} 条</p>
                <p>
                  查询时间：
                  <time dateTime={verified.database.checkedAt}>{verified.database.checkedAt}</time>
                </p>
                {verified.deliveryWarning && (
                  <p>部分体验事件可能仍待确认；数量只取自本次数据库读回。</p>
                )}
                <ul>
                  {verified.database.eventSummary.byName.map(({ eventName, count }) => (
                    <li key={eventName}>
                      <code>{eventName}</code>
                      <span>{count} 条</span>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p>提交回执与数据库读回分别验证；此处尚未执行独立核验。</p>
            )}
          </div>
        </div>
      </details>
    </div>
  );
}
