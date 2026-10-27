import type { ParticipationResponse } from '@apple/contracts';
import { RequestError } from '../api/client';
import type { InteractionState } from '../interaction/machine';
import type { TelemetryClient } from '../telemetry/client';
import { DatabaseVerification } from './DatabaseVerification';

interface RoundResultsProps {
  state: InteractionState;
  receipt: ParticipationResponse | undefined;
  error: Error | null;
  pending: boolean;
  paused: boolean;
  recovered: boolean;
  telemetry: TelemetryClient;
  onRetry: () => void;
}

export function RoundResults({
  state,
  receipt,
  error,
  pending,
  paused,
  recovered,
  telemetry,
  onRetry,
}: RoundResultsProps) {
  const requestId = error instanceof RequestError ? error.requestId : null;
  return (
    <div className="result-card" aria-label="本轮验证结果">
      <div>
        <span className="result-check" aria-hidden="true">
          ✓
        </span>
        <div>
          <strong>本地交互完成</strong>
          <p>
            {state.steps} 次有效输入 · 活跃用时 {(state.activeMs / 1_000).toFixed(2)} s
          </p>
        </div>
      </div>
      <div className="submission-result" role="status" aria-label="提交状态">
        {recovered && !receipt && (
          <p className="recovery-message">已恢复本轮，正在向服务端重新确认</p>
        )}
        {paused ? (
          <p>当前离线；联网后将使用同一轮次编号继续提交。</p>
        ) : pending ? (
          <p>正在记录到服务端…</p>
        ) : null}
        {receipt && (
          <>
            <strong>服务端已记录</strong>
            <p className="receipt-id">MOCK · {receipt.participationId}</p>
            <small>这是提交回执。下方数据库核验会独立读取已保存记录；真实外部接口仍待联调。</small>
          </>
        )}
        {error && (
          <>
            <strong className="error-text">提交尚未确认</strong>
            <p>{error.message}</p>
            {requestId && <code>请求编号 {requestId}</code>}
            <button type="button" className="button button-secondary" onClick={onRetry}>
              重试提交
            </button>
          </>
        )}
      </div>
      <DatabaseVerification roundId={state.roundId} receipt={receipt} telemetry={telemetry} />
    </div>
  );
}
