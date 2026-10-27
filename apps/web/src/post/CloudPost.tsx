import { useEffect, useRef, useState, useSyncExternalStore, type PointerEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { loadCriticalImages } from '../assets/loader';
import type { InteractionAction, Phase } from '../interaction/machine';
import { crossedTargets, type Point, type Target } from '../interaction/pointer';
import { TelemetryClient, type TelemetrySnapshot } from '../telemetry/client';
import { uuid } from '../uuid';
import { CloudFriend, PaperPlane, Star } from './art';
import { activeStarIds, createPostState, postReducer, STAR_GROUPS } from './logic';
import { getPostStorage, readPostDraft, savePostDraft, type BlessingIndex } from './recovery';
import { PostReceipt } from './PostReceipt';
import type { CloudPostProps } from './runtime';
import { POST_THEMES } from './themes';
import './post.css';
import './new-year.css';

const campaignId = 'cloud-post';
const releaseId: string = import.meta.env.VITE_RELEASE_ID ?? 'development';
const disabledTelemetry: TelemetrySnapshot = {
  consent: false,
  queued: 0,
  accepted: 0,
  duplicates: 0,
  dropped: 0,
  sending: false,
  lastError: null,
  beaconAttempted: false,
};
const subscribeWithoutTelemetry = () => () => {};
const getDisabledTelemetry = () => disabledTelemetry;
const phaseLabels: Record<Phase, string> = {
  loading: '正在打开云朵邮局',
  ready: '准备收集星光',
  playing: '正在收集星光',
  paused: '星光收集已暂停',
  completed: '星光已收集完成',
  error: '邮局暂时没有打开',
};
export const POST_BLESSINGS = POST_THEMES.classic.blessings;

export function CloudPost({
  offline,
  theme = POST_THEMES.classic,
  scene,
  controls,
  introNote,
  onSceneActiveChange,
}: CloudPostProps = {}) {
  const draftStorage = offline ? offline.draftStorage : getPostStorage();
  const [telemetry] = useState(() =>
    offline ? null : new TelemetryClient({ campaignId, releaseId }),
  );
  const analytics = useSyncExternalStore(
    telemetry?.subscribe ?? subscribeWithoutTelemetry,
    telemetry?.getSnapshot ?? getDisabledTelemetry,
  );
  const campaign = useQuery({
    queryKey: offline
      ? ['campaign', campaignId, 'offline', offline.campaign.version]
      : ['campaign', campaignId],
    queryFn: ({ signal }) =>
      offline ? Promise.resolve(offline.campaign) : api.campaign(campaignId, signal),
    networkMode: offline ? 'always' : 'online',
  });
  const [draft] = useState(() => readPostDraft(draftStorage));
  const [state, setState] = useState(() => createPostState(draft?.state.roundId ?? uuid()));
  const [blessingIndex, setBlessingIndex] = useState<BlessingIndex>(draft?.blessingIndex ?? 0);
  const [cloudPoint, setCloudPoint] = useState<Point>({ x: 50, y: 74 });
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [storageWorks, setStorageWorks] = useState(true);
  const stateRef = useRef(state);
  const blessingRef = useRef(blessingIndex);
  const restored = useRef(false);
  const stage = useRef<HTMLDivElement>(null);
  const page = useRef<HTMLDivElement>(null);
  const completeTitle = useRef<HTMLHeadingElement>(null);
  const keyboardInput = useRef(false);
  const pointer = useRef<{ id: number; point: Point } | null>(null);
  stateRef.current = state;
  blessingRef.current = blessingIndex;

  useEffect(() => {
    onSceneActiveChange?.(state.phase === 'playing');
    return () => onSceneActiveChange?.(false);
  }, [state.phase, onSceneActiveChange]);

  useEffect(() => {
    if (state.phase === 'completed') {
      completeTitle.current?.focus({ preventScroll: true });
      return;
    }
    if (!keyboardInput.current && state.phase !== 'paused') return;
    const selector =
      state.phase === 'playing'
        ? '[data-post-star]:not(:disabled)'
        : state.phase === 'paused'
          ? '.post-pause-paper button'
          : state.phase === 'ready'
            ? '.post-start'
            : null;
    if (selector)
      page.current?.querySelector<HTMLElement>(selector)?.focus({ preventScroll: true });
  }, [state.phase, state.steps, state.roundId]);

  const sendRef = useRef<(action: InteractionAction, reason?: 'hidden' | 'user') => void>(() => {});
  sendRef.current = (action, reason = 'user') => {
    const previous = stateRef.current;
    const next = postReducer(previous, action);
    if (next === previous) return;
    stateRef.current = next;
    // Persist before completion can mount the receipt component and submit.
    const snapshot =
      next.phase === 'playing'
        ? postReducer(next, { type: 'PAUSE', now: performance.now() })
        : next;
    if (!['loading', 'error'].includes(next.phase))
      setStorageWorks(savePostDraft(draftStorage, snapshot, blessingRef.current));
    setState(next);
    if (
      action.type === 'RESTORE' ||
      action.type === 'LOADED' ||
      action.type === 'LOAD_FAILED' ||
      action.type === 'RETRY'
    )
      return;
    const properties = { roundId: previous.roundId, interaction: 'swipe' as const };
    if (action.type === 'RESET') telemetry?.track('interaction_reset', { ...properties, reason });
    else if (previous.phase === 'ready' && next.phase === 'playing')
      telemetry?.track('interaction_started', properties);
    else if (previous.phase === 'playing' && next.phase === 'paused')
      telemetry?.track('interaction_paused', { ...properties, reason });
    else if (previous.phase === 'paused' && next.phase === 'playing')
      telemetry?.track('interaction_resumed', { ...properties, reason });
    else if (next.phase === 'completed' && previous.phase !== 'completed')
      telemetry?.track('interaction_completed', {
        ...properties,
        durationMs: Math.round(next.activeMs),
        steps: next.steps,
      });
  };

  useEffect(() => {
    if (campaign.isFetching) return;
    if (campaign.isError) {
      sendRef.current({ type: 'LOAD_FAILED', message: campaign.error.message });
      return;
    }
    if (!campaign.data || stateRef.current.phase !== 'loading') return;
    const controller = new AbortController();
    // Standalone artwork is inline; offline mode never fetches even injected asset URLs.
    const resourcesReady = offline
      ? Promise.resolve()
      : loadCriticalImages(campaign.data, { signal: controller.signal });
    void resourcesReady
      .then(() => {
        if (controller.signal.aborted) return;
        if (draft && !restored.current) {
          restored.current = true;
          sendRef.current({ type: 'RESTORE', state: draft.state });
        } else sendRef.current({ type: 'LOADED' });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        sendRef.current({
          type: 'LOAD_FAILED',
          message: error instanceof Error ? error.message : '信件还在路上，请再试一次。',
        });
        telemetry?.track('resource_failed', { roundId: stateRef.current.roundId, reason: 'asset' });
      });
    return () => controller.abort();
  }, [
    campaign.data,
    campaign.isFetching,
    campaign.isError,
    campaign.error,
    draft,
    loadAttempt,
    telemetry,
    offline,
  ]);

  useEffect(() => {
    const saveAndPause = () => {
      pointer.current = null;
      if (stateRef.current.phase === 'playing')
        sendRef.current({ type: 'PAUSE', now: performance.now() }, 'hidden');
      if (telemetry && typeof navigator.sendBeacon === 'function')
        telemetry.beacon((url, body) => navigator.sendBeacon(url, body));
    };
    const visibility = () => {
      if (document.visibilityState === 'hidden') saveAndPause();
      else void telemetry?.flush();
    };
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('pagehide', saveAndPause);
    return () => {
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('pagehide', saveAndPause);
      telemetry?.stop();
    };
  }, [telemetry]);

  const collectStar = (id: number) =>
    sendRef.current({ type: 'COLLECT', cell: id, now: performance.now() });
  const collectSegment = (from: Point, to: Point) => {
    const available = new Set(activeStarIds(stateRef.current));
    const targets: Target[] = [
      ...(stage.current?.querySelectorAll<HTMLElement>('[data-post-star]') ?? []),
    ]
      .filter((element) => available.has(Number(element.dataset.postStar)))
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          id: Number(element.dataset.postStar),
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
          radius: rect.width / 2 + 18,
        };
      });
    for (const id of crossedTargets(from, to, targets)) collectStar(id);
  };
  const moveCloud = (point: Point) => {
    const rect = stage.current?.getBoundingClientRect();
    if (!rect) return;
    setCloudPoint({
      x: Math.max(9, Math.min(91, ((point.x - rect.left) / rect.width) * 100)),
      y: Math.max(15, Math.min(86, ((point.y - rect.top) / rect.height) * 100)),
    });
  };
  const pointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (
      stateRef.current.phase !== 'playing' ||
      !event.isPrimary ||
      event.button !== 0 ||
      (event.target as Element).closest('[data-post-star]')
    )
      return;
    keyboardInput.current = false;
    const point = { x: event.clientX, y: event.clientY };
    pointer.current = { id: event.pointerId, point };
    event.currentTarget.setPointerCapture(event.pointerId);
    moveCloud(point);
    collectSegment(point, point);
  };
  const pointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (
      !pointer.current ||
      pointer.current.id !== event.pointerId ||
      stateRef.current.phase !== 'playing'
    )
      return;
    const next = { x: event.clientX, y: event.clientY };
    collectSegment(pointer.current.point, next);
    pointer.current = { id: event.pointerId, point: next };
    moveCloud(next);
  };
  const pointerEnd = (event: PointerEvent<HTMLDivElement>) => {
    if (pointer.current?.id === event.pointerId) pointer.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const pointerCaptureLost = (event: PointerEvent<HTMLDivElement>) => {
    // An older pointer losing capture must not cancel a different active gesture.
    if (
      pointer.current?.id === event.pointerId &&
      !event.currentTarget.hasPointerCapture(event.pointerId)
    )
      pointer.current = null;
  };
  const reset = () => {
    pointer.current = null;
    setCloudPoint({ x: 50, y: 74 });
    sendRef.current({ type: 'RESET', roundId: uuid() });
  };
  const chooseBlessing = (index: BlessingIndex) => {
    blessingRef.current = index;
    setBlessingIndex(index);
    setStorageWorks(savePostDraft(draftStorage, stateRef.current, index));
  };
  const consent = () => {
    if (!telemetry || !campaign.isSuccess || analytics.consent) return;
    telemetry.setConsent(true);
    telemetry.track('page_view');
  };
  const groupIndex = Math.min(2, Math.floor(state.steps / 2));
  const group = STAR_GROUPS[groupIndex]!;
  const station = theme.stations[groupIndex]!;
  const blessings = theme.blessings;
  const blessing = blessings[blessingIndex];
  const journey = state.phase === 'playing' || state.phase === 'paused';

  return (
    <div className="post-page" data-post-theme={theme.id} id="cloud-post" ref={page}>
      <header className="post-header">
        <a
          href={offline ? '#cloud-post' : '/'}
          className="post-brand"
          aria-label={`${theme.brand}首页`}
        >
          <span className="post-brand-icon" aria-hidden="true">
            ☁
          </span>
          <span>
            {theme.brand}
            <small>{theme.brandEnglish}</small>
          </span>
        </a>
        <span className={`post-header-note${offline ? ' post-offline-label' : ''}`}>
          {offline ? '本机试玩中' : '今日营业中'} <span aria-hidden="true">✦</span>
        </span>
      </header>
      <main className="post-main">
        <div className="post-status-line">
          <span className="post-mini-star" aria-hidden="true">
            ✦
          </span>
          <span role="status" aria-label="星光收集状态">
            {phaseLabels[state.phase]}
          </span>
          {journey && (
            <span className="post-progress-text" role="status" aria-label="星光数量">
              {state.steps} / 6 颗星光
            </span>
          )}
        </div>

        {state.phase !== 'completed' && !journey && (
          <section className="post-welcome" aria-labelledby="post-welcome-title">
            <p className="post-kicker">{theme.heroKicker}</p>
            <h1 id="post-welcome-title">
              {theme.heroTitle[0]}
              <br />
              {theme.heroTitle[1]}
              <span className="post-title-dot">。</span>
            </h1>
            <p className="post-intro">
              {theme.heroIntro[0]}
              <br />
              {theme.heroIntro[1]}
            </p>
            <div className="post-hero-art" aria-hidden="true">
              <div className="post-sun" />
              <div className="post-distant-cloud post-distant-one" />
              <div className="post-distant-cloud post-distant-two" />
              <svg className="post-flight-path" viewBox="0 0 760 300">
                <path
                  d="M100 211c99 62 180-151 278-112s88 161 188 73 112-43 135-8"
                  fill="none"
                  stroke="var(--post-route, #9fc1d1)"
                  strokeWidth="2"
                  strokeDasharray="4 8"
                  strokeLinecap="round"
                />
              </svg>
              <PaperPlane className="post-hero-plane" />
              <Star className="post-hero-star post-hero-star-one" />
              <Star className="post-hero-star post-hero-star-two" />
              <Star className="post-hero-star post-hero-star-three" />
              <CloudFriend className="post-hero-cloud" />
              <div className="post-floating-envelope">
                <span>{theme.envelopeTo}</span>
                <i>♡</i>
              </div>
              <span className="post-hero-caption">{theme.heroCaption}</span>
            </div>
            {state.phase === 'error' ? (
              <div className="post-load-error" role="alert">
                <p>邮差还在路上。我们再敲一次门吧。</p>
                <button
                  type="button"
                  className="post-primary"
                  onClick={() => {
                    sendRef.current({ type: 'RETRY' });
                    setLoadAttempt((value) => value + 1);
                    void campaign.refetch();
                  }}
                >
                  重新打开邮局
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="post-primary post-start"
                disabled={state.phase !== 'ready'}
                onClick={(event) => {
                  keyboardInput.current = event.detail === 0;
                  sendRef.current({ type: 'START', now: performance.now() });
                }}
              >
                {state.phase === 'loading' ? '正在打开邮局…' : '开始收集星光'}
                <span aria-hidden="true">↗</span>
              </button>
            )}
            <p className="post-gentle-note">没有倒计时，也没有输赢。只收集一点开心。</p>
            {introNote}
          </section>
        )}

        {journey && (
          <section className="post-journey" aria-labelledby="post-journey-title">
            <div className="post-journey-heading">
              <div>
                <p className="post-kicker">第 {groupIndex + 1} 站 / 共三站</p>
                <h1 id="post-journey-title">{station.label}</h1>
                <p>{station.hint}</p>
              </div>
              <button
                type="button"
                className="post-pause-button"
                disabled={state.phase !== 'playing'}
                onClick={() => {
                  pointer.current = null;
                  sendRef.current({ type: 'PAUSE', now: performance.now() });
                }}
                aria-label="暂停收集"
              >
                <span aria-hidden="true">Ⅱ</span>
              </button>
            </div>
            <div
              className="post-play-field"
              ref={stage}
              role="group"
              aria-label="拖动云朵收集星光"
              onPointerDown={pointerDown}
              onPointerMove={pointerMove}
              onPointerUp={pointerEnd}
              onPointerCancel={pointerEnd}
              onLostPointerCapture={pointerCaptureLost}
            >
              {scene}
              <div className="post-field-cloud post-field-cloud-one" aria-hidden="true" />
              <div className="post-field-cloud post-field-cloud-two" aria-hidden="true" />
              <div className="post-hill post-hill-one" aria-hidden="true" />
              <div className="post-hill post-hill-two" aria-hidden="true" />
              <svg
                className="post-constellation"
                viewBox="0 0 800 450"
                preserveAspectRatio="none"
                aria-hidden="true"
              >
                <path
                  d="M70 330Q160 120 360 230T750 140"
                  stroke="var(--post-route, #b2cedd)"
                  strokeWidth="1.5"
                  strokeDasharray="3 10"
                  fill="none"
                />
              </svg>
              {group.stars.map(({ id, x, y }) => (
                <button
                  key={id}
                  type="button"
                  data-post-star={id}
                  className={`post-star-button ${state.collected.includes(id) ? 'post-star-collected' : ''}`}
                  style={{ left: `${x}%`, top: `${y}%` }}
                  aria-label={`收集第${id + 1}颗星光`}
                  disabled={state.phase !== 'playing' || state.collected.includes(id)}
                  onClick={(event) => {
                    keyboardInput.current = event.detail === 0;
                    collectStar(id);
                  }}
                  onKeyDown={(event) => {
                    if (event.repeat && (event.key === 'Enter' || event.key === ' '))
                      event.preventDefault();
                  }}
                >
                  <Star />
                  <span>{state.collected.includes(id) ? '✓' : '✦'}</span>
                </button>
              ))}
              <div
                className="post-player-cloud"
                // Only the painted courier receives input; its transparent frame
                // and caption must leave nearby active stars reachable.
                style={{
                  left: `${cloudPoint.x}%`,
                  top: `${cloudPoint.y}%`,
                  pointerEvents: 'none',
                }}
                aria-hidden="true"
              >
                <CloudFriend
                  sleepy={state.phase === 'paused'}
                  className={state.phase === 'playing' ? 'post-cloud-drag-handle' : ''}
                />
                <span>小云朵</span>
              </div>
              <div className="post-field-label" aria-hidden="true">
                晴天航线 · CLOUD ROUTE {String(groupIndex + 1).padStart(2, '0')}
              </div>
              {state.phase === 'paused' && (
                <div className="post-pause-overlay">
                  <div className="post-pause-paper">
                    <span className="post-pause-moon" aria-hidden="true">
                      ☾
                    </span>
                    <h2>云朵也需要歇一歇</h2>
                    <p>星光还在这里，准备好了再出发。</p>
                    <button
                      type="button"
                      className="post-primary"
                      onClick={(event) => {
                        keyboardInput.current = event.detail === 0;
                        sendRef.current({ type: 'RESUME', now: performance.now() });
                      }}
                    >
                      继续收集<span aria-hidden="true">↗</span>
                    </button>
                  </div>
                </div>
              )}
            </div>
            {controls}
            <div className="post-journey-footer">
              <div className="post-star-pocket" aria-label={`已收集${state.steps}颗星光`}>
                {Array.from({ length: 6 }, (_, index) => (
                  <Star key={index} className={index < state.steps ? 'post-pocket-filled' : ''} />
                ))}
              </div>
              <p>
                拖动云朵靠近星光，也可以轻点星星
                <br />
                <span>键盘可用 Tab 选中星星，按 Enter 收集。</span>
              </p>
            </div>
            <button type="button" className="post-text-button" onClick={reset}>
              重新寄一封
            </button>
          </section>
        )}

        {state.phase === 'completed' && (
          <section className="post-complete" aria-labelledby="post-complete-title">
            <p className="post-kicker">{theme.completionKicker}</p>
            <h1 id="post-complete-title" tabIndex={-1} ref={completeTitle}>
              {theme.completionTitle[0]}
              <br />
              {theme.completionTitle[1]}
            </h1>
            <p className="post-complete-intro">{theme.completionIntro}</p>
            <div className="post-card-wrap">
              <Star className="post-card-spark post-card-spark-one" />
              <Star className="post-card-spark post-card-spark-two" />
              <article className="post-blessing-card" aria-label="星光祝福卡">
                <div className="post-card-top">
                  <span>
                    {theme.cardLabel}
                    <small>{theme.cardEnglish}</small>
                  </span>
                  <div className="post-stamp" aria-hidden="true">
                    <CloudFriend />
                    <span>CLOUD POST</span>
                  </div>
                </div>
                <div className="post-card-message">
                  <span className="post-card-to">{theme.cardTo}</span>
                  <h2>{blessing.title}</h2>
                  <p>
                    {blessing.lines[0]}
                    <br />
                    {blessing.lines[1]}
                  </p>
                </div>
                <div className="post-card-bottom">
                  <span>{theme.cardClosing}</span>
                  <span className="post-postmark" aria-hidden="true">
                    {theme.postmark}
                    <small>WITH LOVE</small>
                  </span>
                </div>
              </article>
            </div>
            <div className="post-blessing-picker" role="group" aria-label="选择祝福">
              {blessings.map((item, index) => (
                <button
                  type="button"
                  key={item.name}
                  aria-pressed={blessingIndex === index}
                  onClick={() => chooseBlessing(index as BlessingIndex)}
                >
                  {item.name}
                </button>
              ))}
            </div>
            {offline
              ? offline.renderReceipt({ roundId: state.roundId, blessingIndex })
              : telemetry && (
                  <PostReceipt
                    key={state.roundId}
                    roundId={state.roundId}
                    sessionReady={campaign.isSuccess}
                    telemetry={telemetry}
                    recovered={draft?.state.roundId === state.roundId}
                  />
                )}
            <button type="button" className="post-primary post-again" onClick={reset}>
              重新寄一封<span aria-hidden="true">↗</span>
            </button>
          </section>
        )}

        {!offline && (
          <section className="post-privacy" aria-label="体验统计选择">
            <span className="post-privacy-icon" aria-hidden="true">
              ♡
            </span>
            <div>
              <strong>让下一次相遇，再好一点点</strong>
              <p>可以选择发送匿名交互统计。不包含祝福文字；不启用也一样能玩。</p>
              {!campaign.isSuccess && <small>邮局连接成功后可选择。</small>}
            </div>
            <div className="post-privacy-actions">
              <button
                type="button"
                className="post-text-button"
                onClick={consent}
                disabled={!campaign.isSuccess || analytics.consent}
              >
                {analytics.consent ? '已同意体验统计' : '同意体验统计'}
              </button>
              <button
                type="button"
                className="post-text-button"
                onClick={() => telemetry?.setConsent(false)}
              >
                暂不启用统计
              </button>
            </div>
          </section>
        )}
        {!storageWorks && (
          <p className="post-storage-note" role="status">
            {offline
              ? '这份离线演示暂时无法保存草稿，关闭后可能找不回进度。当前仍然可以继续玩。'
              : '这台浏览器未允许本机保存，关闭页面后可能无法找回进度。当前仍然可以继续玩。'}
          </p>
        )}
      </main>
      <footer className="post-footer">
        <span>{theme.footer}</span>
        <span>
          {offline ? (
            '原创离线演示 · 祝福留在本机'
          ) : (
            <>
              原创互动演示 <i aria-hidden="true">✦</i> <a href="/lab">工程验证台</a>
            </>
          )}
        </span>
      </footer>
    </div>
  );
}
