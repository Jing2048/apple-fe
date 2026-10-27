import {
  useEffect,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
  type PointerEvent,
} from 'react';
import './styles.css';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from './api/client';
import { loadCriticalImages } from './assets/loader';
import {
  createInteractionState,
  interactionReducer,
  type Interaction,
  type Phase,
} from './interaction/machine';
import { crossedTargets, type Point, type Target } from './interaction/pointer';
import {
  forgetRound,
  recoverRound,
  rememberRound,
  sessionStorageOrNull,
} from './interaction/recovery';
import { TelemetryClient } from './telemetry/client';
import { RoundResults } from './verification/RoundResults';
import { uuid } from './uuid';

const webReleaseId: string = import.meta.env.VITE_RELEASE_ID ?? 'development';
// This fixed entry is an acceptance workbench, not a general campaign-page renderer.
const labCampaignId = 'lab';
const telemetry = new TelemetryClient({ campaignId: labCampaignId, releaseId: webReleaseId });
const phases: Record<Phase, string> = {
  loading: '正在加载配置',
  ready: '可以开始',
  playing: '验证进行中',
  paused: '已暂停',
  completed: '本轮完成',
  error: '配置加载失败',
};
export function App() {
  const health = useQuery({ queryKey: ['health'], queryFn: ({ signal }) => api.health(signal) });
  const ready = useQuery({
    queryKey: ['ready'],
    queryFn: ({ signal }) => api.ready(signal),
    refetchInterval: 15_000,
  });
  const campaign = useQuery({
    queryKey: ['campaign', labCampaignId],
    queryFn: ({ signal }) => api.campaign(labCampaignId, signal),
  });
  const [recoveryDraft] = useState(() => recoverRound(sessionStorageOrNull()));
  const [loadAttempt, setLoadAttempt] = useState(0);
  const didRestore = useRef(false);
  const [state, dispatch] = useReducer(interactionReducer, undefined, () =>
    createInteractionState(recoveryDraft?.roundId ?? uuid()),
  );
  const analytics = useSyncExternalStore(telemetry.subscribe, telemetry.getSnapshot);
  const participation = useMutation({ mutationFn: api.participate, retry: false });
  const submissionIsCurrent = participation.variables?.idempotencyKey === state.roundId;
  const currentReceipt = submissionIsCurrent ? participation.data : undefined;
  const submissionError = submissionIsCurrent ? participation.error : null;
  const recoveredRound = recoveryDraft?.roundId === state.roundId && didRestore.current;
  const handledCompletion = useRef<string | null>(null);
  const previousState = useRef(state);
  const pauseReason = useRef<'hidden' | 'user'>('user');
  const pointer = useRef<{ id: number; point: Point } | null>(null);
  const arena = useRef<HTMLDivElement>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const backendReady = ready.isSuccess && ready.data?.status === 'ready';

  useEffect(() => {
    const previous = previousState.current;
    previousState.current = state;
    if (state.roundId !== previous.roundId) {
      telemetry.track('interaction_reset', {
        interaction: previous.interaction,
        reason: 'user',
        roundId: previous.roundId,
      });
    } else if (previous.phase === 'ready' && state.phase === 'playing') {
      telemetry.track('interaction_started', {
        interaction: state.interaction,
        roundId: state.roundId,
      });
    } else if (previous.phase === 'playing' && state.phase === 'paused') {
      telemetry.track('interaction_paused', {
        interaction: state.interaction,
        reason: pauseReason.current,
        roundId: state.roundId,
      });
    } else if (previous.phase === 'paused' && state.phase === 'playing') {
      telemetry.track('interaction_resumed', {
        interaction: state.interaction,
        reason: 'user',
        roundId: state.roundId,
      });
    }
  }, [state]);

  useEffect(() => {
    if (campaign.isError) {
      dispatch({ type: 'LOAD_FAILED', message: campaign.error.message });
      return;
    }
    if (!campaign.data || campaign.isFetching || stateRef.current.phase !== 'loading') return;
    const controller = new AbortController();
    void loadCriticalImages(campaign.data, { signal: controller.signal })
      .then(() => {
        if (controller.signal.aborted) return;
        if (recoveryDraft && !didRestore.current) {
          didRestore.current = true;
          dispatch({ type: 'RESTORE', state: recoveryDraft });
        } else {
          dispatch({ type: 'LOADED' });
        }
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        dispatch({
          type: 'LOAD_FAILED',
          message: error instanceof Error ? error.message : '关键素材加载失败',
        });
        telemetry.track('resource_failed', { reason: 'asset', roundId: stateRef.current.roundId });
      });
    return () => controller.abort();
  }, [
    campaign.data,
    campaign.isError,
    campaign.error,
    campaign.isFetching,
    loadAttempt,
    recoveryDraft,
  ]);

  useEffect(() => {
    const onVisibility = () => {
      const current = stateRef.current;
      if (document.visibilityState === 'hidden') {
        pointer.current = null;
        if (current.phase === 'playing') {
          pauseReason.current = 'hidden';
          dispatch({ type: 'PAUSE', now: performance.now() });
        }
        if (typeof navigator.sendBeacon === 'function') {
          telemetry.beacon((url, body) => navigator.sendBeacon(url, body));
        }
      } else {
        void telemetry.flush();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  useEffect(() => {
    if (state.phase !== 'playing') pointer.current = null;
    if (
      state.phase !== 'completed' ||
      !campaign.data ||
      handledCompletion.current === state.roundId
    )
      return;
    rememberRound(sessionStorageOrNull(), state);
    handledCompletion.current = state.roundId;
    // Recovery confirms an old local draft; it must not replay a pre-consent event.
    if (recoveryDraft?.roundId !== state.roundId) {
      telemetry.track('interaction_completed', {
        interaction: state.interaction,
        durationMs: Math.round(state.activeMs),
        steps: state.steps,
        roundId: state.roundId,
      });
    }
    participation.mutate({
      campaignId: labCampaignId,
      interaction: state.interaction,
      idempotencyKey: state.roundId,
    });
  }, [state, campaign.data, participation.mutate, recoveryDraft]);

  const select = (interaction: Interaction) => {
    if (participation.isPending) return;
    forgetRound(sessionStorageOrNull());
    pointer.current = null;
    participation.reset();
    dispatch({ type: 'SELECT', interaction, roundId: uuid() });
  };
  const start = () => {
    if (state.phase !== 'ready' || !backendReady) return;
    dispatch({ type: 'START', now: performance.now() });
  };
  const pause = () => {
    if (state.phase !== 'playing') return;
    pauseReason.current = 'user';
    dispatch({ type: 'PAUSE', now: performance.now() });
  };
  const resume = () => {
    if (state.phase !== 'paused') return;
    dispatch({ type: 'RESUME', now: performance.now() });
  };
  const reset = () => {
    if (participation.isPending) return;
    forgetRound(sessionStorageOrNull());
    participation.reset();
    pointer.current = null;
    dispatch({ type: 'RESET', roundId: uuid() });
  };
  const retryCampaign = () => {
    dispatch({ type: 'RETRY' });
    setLoadAttempt((attempt) => attempt + 1);
    void campaign.refetch();
    void ready.refetch();
    void health.refetch();
  };
  const consent = () => {
    // A successful campaign response establishes the signed server session first.
    if (analytics.consent || !campaign.isSuccess) return;
    telemetry.setConsent(true);
    telemetry.track('page_view');
  };

  const getTargets = (): Target[] =>
    [...(arena.current?.querySelectorAll<HTMLElement>('[data-cell]') ?? [])].map((element) => {
      const rect = element.getBoundingClientRect();
      return {
        id: Number(element.dataset.cell),
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
        radius: rect.width / 2,
      };
    });
  const collect = (from: Point, to: Point) => {
    for (const cell of crossedTargets(from, to, getTargets())) {
      dispatch({ type: 'COLLECT', cell, now: performance.now() });
    }
  };
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (state.phase !== 'playing' || !event.isPrimary || event.button !== 0) return;
    const point = { x: event.clientX, y: event.clientY };
    pointer.current = { id: event.pointerId, point };
    event.currentTarget.setPointerCapture(event.pointerId);
    collect(point, point);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const previous = pointer.current;
    if (!previous || previous.id !== event.pointerId || state.phase !== 'playing') return;
    const next = { x: event.clientX, y: event.clientY };
    collect(previous.point, next);
    pointer.current = { id: event.pointerId, point: next };
  };
  const endPointer = (event: PointerEvent<HTMLDivElement>) => {
    if (pointer.current?.id === event.pointerId) pointer.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };
  const collectNext = () => {
    const cell = [0, 1, 2].find((id) => !state.collected.includes(id));
    if (cell !== undefined) dispatch({ type: 'COLLECT', cell, now: performance.now() });
  };

  return (
    <div className="site-shell">
      <header className="topbar">
        <a className="brand" href="#main" aria-label="活动工程验证台首页">
          <span className="brand-mark" aria-hidden="true">
            ◈
          </span>
          <span>
            Campaign <strong>Lab</strong>
          </span>
        </a>
        <span className="environment-badge">
          <span />
          开发验证环境
        </span>
      </header>

      <main id="main">
        <section className="intro" aria-labelledby="page-title">
          <p className="eyebrow">INTERACTION INFRASTRUCTURE / V0.1</p>
          <h1 id="page-title">
            创意到来之前，
            <br />
            <span>让每一条链路先就绪。</span>
          </h1>
          <p className="intro-copy">
            用轻量探针验证交互、数据与服务端处理。这里是工程验证台，
            <br className="desktop-break" />
            正式活动页面与素材将沿同一条链路接入。
          </p>
          <div className="scope-note">
            <span aria-hidden="true">i</span>
            <p>
              以下为通用技术探针；尚未核对 Keynote
              中的具体玩法。外部系统使用模拟适配器，不涉及真实会员、奖品或 Apple 接口。
            </p>
          </div>
        </section>

        <section className="service-strip" aria-label="基础服务状态">
          <div>
            <span
              className={`status-dot ${health.isError ? 'offline' : health.data ? 'online' : ''}`}
            />
            <span>API 服务</span>
            <strong>{health.isError ? '连接失败' : health.data ? '连接正常' : '检查中'}</strong>
          </div>
          <div>
            <span
              className={`status-dot ${ready.isError ? 'offline' : backendReady ? 'online' : ''}`}
            />
            <span>数据库</span>
            <strong>{ready.isError ? '未就绪' : backendReady ? '已就绪' : '检查中'}</strong>
          </div>
          <div>
            <span className="status-dot mock" />
            <span>外部接口</span>
            <strong>MOCK 模拟</strong>
          </div>
          <div className="release">
            <span>构建版本</span>
            <code>{health.data?.releaseId ?? '等待服务'}</code>
          </div>
        </section>

        <section className="manual-guide" aria-labelledby="manual-guide-title">
          <div className="manual-guide-heading">
            <p className="eyebrow">MANUAL CHECK / 3 STEPS</p>
            <h2 id="manual-guide-title">按这三步，手动走通链路</h2>
          </div>
          <ol>
            <li>
              <span>01</span>
              <div>
                <strong>选择是否启用体验埋点</strong>
                <p>可选；拒绝也能完成互动和服务端核验。</p>
                <a href="#telemetry-title">前往埋点设置 ↗</a>
              </div>
            </li>
            <li>
              <span>02</span>
              <div>
                <strong>开始任一探针，完成三次操作</strong>
                <p>点击圆心三次，或滑过三个目标。</p>
                <a href="#probe-title">前往交互探针 ↗</a>
              </div>
            </li>
            <li>
              <span>03</span>
              <div>
                <strong>核验数据库，再重发同一请求</strong>
                <p>在完成结果中读回记录，检查回执是否一致。</p>
                <small>回执与埋点计数分别核验</small>
              </div>
            </li>
          </ol>
        </section>

        <div className="workspace">
          <section className="probe-panel panel" aria-labelledby="probe-title">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">01 / INTERACTION</p>
                <h2 id="probe-title">交互探针</h2>
              </div>
              <span className="quiet-tag">无正式素材</span>
            </div>
            <div className="probe-tabs" role="group" aria-label="选择交互探针">
              <button
                type="button"
                aria-pressed={state.interaction === 'timing'}
                disabled={
                  participation.isPending || state.phase === 'loading' || state.phase === 'error'
                }
                onClick={() => select('timing')}
              >
                时序点击<span>Timing</span>
              </button>
              <button
                type="button"
                aria-pressed={state.interaction === 'swipe'}
                disabled={
                  participation.isPending || state.phase === 'loading' || state.phase === 'error'
                }
                onClick={() => select('swipe')}
              >
                滑动收集<span>Pointer</span>
              </button>
            </div>

            <div className={`scene scene-${state.interaction} phase-${state.phase}`}>
              <div className="scene-top">
                <span>{state.interaction === 'timing' ? 'TIMING PROBE' : 'POINTER PROBE'}</span>
                <span>{String(state.steps).padStart(2, '0')} / 03</span>
              </div>
              {state.interaction === 'timing' ? (
                <button
                  type="button"
                  className="timing-target"
                  aria-label="记录节奏"
                  disabled={state.phase !== 'playing'}
                  onClick={() => dispatch({ type: 'HIT', now: performance.now() })}
                  onKeyDown={(event) => {
                    if (event.repeat && (event.key === ' ' || event.key === 'Enter'))
                      event.preventDefault();
                  }}
                >
                  <span className="timing-orbit orbit-one" aria-hidden="true" />
                  <span className="timing-orbit orbit-two" aria-hidden="true" />
                  <span className="target-center">
                    {!['loading', 'error'].includes(state.phase) &&
                      campaign.data?.assets.find((asset) => asset.kind === 'image') && (
                        <img
                          className="marker-asset"
                          src={campaign.data.assets.find((asset) => asset.kind === 'image')?.url}
                          width="30"
                          height="30"
                          alt="几何形占位素材"
                        />
                      )}
                    <strong>{state.phase === 'completed' ? '完成' : '点击'}</strong>
                  </span>
                </button>
              ) : (
                <div
                  ref={arena}
                  className="swipe-arena"
                  role="group"
                  aria-label="滑动验证区域"
                  onPointerDown={onPointerDown}
                  onPointerMove={onPointerMove}
                  onPointerUp={endPointer}
                  onPointerCancel={endPointer}
                  onLostPointerCapture={() => {
                    pointer.current = null;
                  }}
                >
                  <div className="swipe-track" aria-hidden="true" />
                  {[0, 1, 2].map((id) => (
                    <span
                      key={id}
                      data-cell={id}
                      className={`swipe-cell ${state.collected.includes(id) ? 'collected' : ''}`}
                      aria-label={`目标 ${id + 1}${state.collected.includes(id) ? '已收集' : ''}`}
                    >
                      {state.collected.includes(id) ? '✓' : `0${id + 1}`}
                    </span>
                  ))}
                  <span className="swipe-hint">沿路径滑过三个目标</span>
                </div>
              )}
              <div className="scene-bottom">
                <span>输入反馈 · 状态迁移 · 后台恢复</span>
                <span aria-hidden="true">↗</span>
              </div>
            </div>

            <div className="probe-detail">
              <div>
                <h3>
                  {state.interaction === 'timing' ? '连续记录三次输入' : '一条路径，三个目标'}
                </h3>
                <p>
                  {state.interaction === 'timing'
                    ? '开始后点击圆心，或聚焦圆心使用空格 / Enter。记录本地输入时序，不参与资格或权益判定。'
                    : '开始后按住并滑过目标；快速滑动也会检测经过的目标。使用键盘时，可逐次激活下方替代按钮。'}
                </p>
              </div>
              <div className={`phase-indicator ${state.phase}`} role="status" aria-label="交互状态">
                <span />
                {phases[state.phase]}
              </div>
            </div>
            <div className="action-row">
              {state.phase === 'ready' && (
                <button
                  className="button button-primary"
                  type="button"
                  onClick={start}
                  disabled={!backendReady}
                >
                  开始验证<span aria-hidden="true">↗</span>
                </button>
              )}
              {state.phase === 'playing' && (
                <button className="button button-secondary" type="button" onClick={pause}>
                  暂停
                </button>
              )}
              {state.phase === 'paused' && (
                <button className="button button-primary" type="button" onClick={resume}>
                  继续验证
                </button>
              )}
              {state.phase === 'error' && (
                <button className="button button-primary" type="button" onClick={retryCampaign}>
                  重试加载
                </button>
              )}
              {state.interaction === 'swipe' && state.phase === 'playing' && (
                <button className="button button-secondary" type="button" onClick={collectNext}>
                  完成一次滑动<span className="key-hint">键盘替代</span>
                </button>
              )}
              {!['loading', 'error', 'ready'].includes(state.phase) && (
                <button
                  className="button button-text"
                  type="button"
                  onClick={reset}
                  disabled={participation.isPending}
                >
                  重新开始
                </button>
              )}
              {state.phase === 'loading' && <span className="subtle-copy">正在读取活动配置…</span>}
              {state.phase === 'ready' && ready.error && (
                <button
                  className="button button-text"
                  type="button"
                  onClick={() => {
                    void ready.refetch();
                  }}
                >
                  重新检查服务
                </button>
              )}
            </div>
            {state.error && (
              <p className="inline-error" role="alert">
                {state.error}
              </p>
            )}
            {state.phase === 'ready' && ready.error && (
              <p className="inline-error" role="alert">
                数据库尚未就绪。完成服务准备后可开始验证。
              </p>
            )}

            {state.phase === 'completed' && (
              <RoundResults
                key={state.roundId}
                state={state}
                receipt={currentReceipt}
                error={submissionError}
                pending={submissionIsCurrent && participation.isPending}
                paused={submissionIsCurrent && participation.isPaused}
                recovered={recoveredRound}
                telemetry={telemetry}
                onRetry={() =>
                  participation.mutate({
                    campaignId: labCampaignId,
                    interaction: state.interaction,
                    idempotencyKey: state.roundId,
                  })
                }
              />
            )}
          </section>

          <aside className="side-stack">
            <section className="panel telemetry-panel" aria-labelledby="telemetry-title">
              <div className="panel-heading">
                <div>
                  <p className="eyebrow">02 / OBSERVABILITY</p>
                  <h2 id="telemetry-title">事件链路</h2>
                </div>
                <span className={`quiet-tag ${analytics.consent ? 'tag-green' : ''}`}>
                  {analytics.consent ? '已启用' : '未启用'}
                </span>
              </div>
              <p className="panel-copy">
                可选体验埋点默认关闭。仅发送本验证台的交互类型、步骤和用时；不采集姓名、手机号、指纹或页面查询参数。
              </p>
              <div className="consent-actions">
                <button
                  type="button"
                  className="button button-primary"
                  onClick={consent}
                  disabled={analytics.consent || !campaign.isSuccess}
                >
                  同意体验埋点
                </button>
                <button
                  type="button"
                  className="button button-text"
                  onClick={() => telemetry.setConsent(false)}
                >
                  拒绝体验埋点
                </button>
              </div>
              <p className="privacy-note">
                拒绝不影响交互。选择仅在本次页面内有效；撤销后清空未发送事件，并中断正在进行的请求，已送达事件不会自动撤回。
              </p>
              <div className="metric-grid">
                <div>
                  <strong>{analytics.queued.toString().padStart(2, '0')}</strong>
                  <span>等待确认</span>
                </div>
                <div>
                  <strong>{analytics.accepted.toString().padStart(2, '0')}</strong>
                  <span>服务端接收</span>
                </div>
                <div>
                  <strong>{analytics.duplicates.toString().padStart(2, '0')}</strong>
                  <span>重复已去除</span>
                </div>
              </div>
              <p className="privacy-note">
                以上为本页 SDK
                的累计发送状态，不是数据库读回证据。本轮已入库事件请在完成后的“数据库读回”中核验。
              </p>
              <div className="event-pipeline">
                <div>
                  <span className="pipeline-icon">01</span>
                  <p>
                    <strong>交互状态</strong>
                    <span>明确的事件触发点</span>
                  </p>
                  <span className="pipeline-state">本地</span>
                </div>
                <div>
                  <span className="pipeline-icon">02</span>
                  <p>
                    <strong>批量队列</strong>
                    <span>失败保留原事件编号</span>
                  </p>
                  <span className="pipeline-state">{analytics.sending ? '发送中' : '待命'}</span>
                </div>
                <div>
                  <span className="pipeline-icon">03</span>
                  <p>
                    <strong>持久化确认</strong>
                    <span>收到确认后才移出队列</span>
                  </p>
                  <span className="pipeline-state">ACK</span>
                </div>
              </div>
              <button
                type="button"
                className="button button-secondary flush-button"
                disabled={!analytics.consent || analytics.queued === 0 || analytics.sending}
                onClick={() => {
                  void telemetry.flush();
                }}
              >
                立即发送待确认事件<span aria-hidden="true">↗</span>
              </button>
              <div className="telemetry-status" role="status" aria-label="事件发送状态">
                {analytics.lastError ??
                  (analytics.consent
                    ? '队列已启用，事件由第一方接口接收。'
                    : '尚未同意，不创建或发送体验事件。')}
                {analytics.dropped > 0 && <span> 已丢弃 {analytics.dropped} 条事件。</span>}
                {analytics.beaconAttempted && (
                  <span> 页面隐藏时已尝试发送；该尝试不代表持久化成功。</span>
                )}
              </div>
            </section>
            <section className="panel boundary-panel" aria-labelledby="boundary-title">
              <p className="eyebrow">03 / TRUST BOUNDARIES</p>
              <h2 id="boundary-title">每层有自己的证据</h2>
              <ul>
                <li>
                  <span>浏览器</span>
                  <p>验证输入与画面状态</p>
                </li>
                <li>
                  <span>服务端</span>
                  <p>验证会话、幂等与持久化</p>
                </li>
                <li>
                  <span>接口提供方</span>
                  <p>真实联调尚待接入</p>
                </li>
              </ul>
              <p className="privacy-note">
                必要会话 Cookie 用于服务端识别重复提交；它与可选体验埋点相互独立。
              </p>
            </section>
          </aside>
        </div>
        <section className="delivery-note" aria-label="工程说明">
          <span className="delivery-symbol" aria-hidden="true">
            ⌘
          </span>
          <div>
            <strong>素材、规则、接口分别演进。</strong>
            <p>
              本台保留交互状态、埋点契约与服务端边界。正式素材和玩法到位后，再逐项建立验收对应。
            </p>
          </div>
          <code>web · {webReleaseId}</code>
        </section>
      </main>
      <footer>
        <span>Campaign infrastructure · Development lab</span>
        <span>自有资源 / 第一方数据 / 可复核链路</span>
      </footer>
    </div>
  );
}
