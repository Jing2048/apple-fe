import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type PointerEvent,
  type ReactNode,
} from 'react';
import { uuid } from '../uuid';
import { LanternArt } from './LanternArt';
import {
  createLanternState,
  lanternReducer,
  normalizeWish,
  isLanternWish,
  lanternWishLimit,
  type LanternAction,
  type LanternColor,
  type LanternPattern,
  type LanternPhase,
} from './model';
import { LanternStore } from './storage';
import './lantern.css';

export interface LanternAppProps {
  scene?: ReactNode;
  controls?: ReactNode;
  onSceneActiveChange?: (active: boolean) => void;
}

const phases: Record<LanternPhase, string> = {
  wish: '写下心愿',
  unfold: '拉开纸灯',
  decorate: '装饰纸灯',
  launch: '准备放飞',
  flying: '心愿正在升起',
  keepsake: '心愿已放上天',
};
const presets = [
  { label: '平安常在', wish: '愿所爱的人，平安常在。' },
  { label: '常有欢喜', wish: '愿新的一年，常有欢喜。' },
  { label: '热爱发光', wish: '愿心里的热爱，慢慢发光。' },
];
const colors: { value: LanternColor; label: string }[] = [
  { value: 'red', label: '朱砂红' },
  { value: 'apricot', label: '暖杏' },
  { value: 'ivory', label: '米白' },
];
const patterns: { value: LanternPattern; label: string; mark: string }[] = [
  { value: 'blossom', label: '花开', mark: '✿' },
  { value: 'window', label: '窗花', mark: '◇' },
  { value: 'ripple', label: '涟漪', mark: '≈' },
];
const steps = ['写愿', '展开', '装饰', '放飞', '留念'];
const stepForPhase: Record<LanternPhase, number> = {
  wish: 0,
  unfold: 1,
  decorate: 2,
  launch: 3,
  flying: 3,
  keepsake: 4,
};
type Gesture = {
  pointerId: number;
  roundId: string;
  kind: 'unfold' | 'launch';
  startY: number;
  startProgress: number;
};

export function LanternApp({ scene, controls, onSceneActiveChange }: LanternAppProps = {}) {
  const [store] = useState(() => new LanternStore());
  const records = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [state, setState] = useState(() => store.readDraft() ?? createLanternState(uuid()));
  const [releaseProgress, setReleaseProgress] = useState(0);
  const [clearNotice, setClearNotice] = useState('');
  const [cardError, setCardError] = useState(false);
  const stateRef = useRef(state);
  const gesture = useRef<Gesture | null>(null);
  const handle = useRef<HTMLButtonElement>(null);
  const workbench = useRef<HTMLElement>(null);
  const keyboardInput = useRef(false);
  const confirmTouch = useRef<{ id: number; x: number; y: number } | null>(null);
  stateRef.current = state;

  const send = useRef<(action: LanternAction) => void>(() => {});
  send.current = (action) => {
    const previous = stateRef.current;
    const next = lanternReducer(previous, action);
    if (next === previous) return;
    stateRef.current = next;
    store.saveDraft(next);
    setState(next);
  };

  const sceneActive = state.phase !== 'wish' && state.phase !== 'keepsake';
  useEffect(() => {
    onSceneActiveChange?.(sceneActive);
    return () => onSceneActiveChange?.(false);
  }, [sceneActive, onSceneActiveChange]);

  useEffect(() => {
    if (state.phase !== 'flying') return;
    const roundId = state.id;
    const timer = setTimeout(() => {
      if (stateRef.current.id === roundId && stateRef.current.phase === 'flying')
        send.current({ type: 'FINISH_FLIGHT' });
    }, 2_200);
    return () => clearTimeout(timer);
  }, [state.phase, state.id]);

  useEffect(() => {
    setCardError(state.phase === 'keepsake' && store.saveCard(state) === null);
  }, [state, store]);

  useEffect(() => {
    gesture.current = null;
    setReleaseProgress(0);
    if (keyboardInput.current)
      workbench.current?.querySelector<HTMLElement>('h2')?.focus({ preventScroll: true });
  }, [state.phase, state.id]);

  useEffect(() => {
    const cancel = () => {
      const active = gesture.current;
      gesture.current = null;
      setReleaseProgress(0);
      if (active && handle.current?.hasPointerCapture(active.pointerId))
        handle.current.releasePointerCapture(active.pointerId);
    };
    const visibility = () => {
      if (document.visibilityState === 'hidden') cancel();
    };
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('pagehide', cancel);
    return () => {
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('pagehide', cancel);
      cancel();
    };
  }, []);

  const updateGesture = (event: PointerEvent<HTMLButtonElement>, active: Gesture) => {
    if (active.roundId !== stateRef.current.id || stateRef.current.phase !== active.kind) return;
    const distance = Math.max(0, active.startY - event.clientY);
    if (active.kind === 'unfold')
      send.current({ type: 'OPEN_PROGRESS', progress: active.startProgress + distance / 180 });
    else setReleaseProgress(Math.min(1, distance / 80));
  };
  const pointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    const current = stateRef.current;
    if (
      !event.isPrimary ||
      event.button !== 0 ||
      (current.phase !== 'unfold' && current.phase !== 'launch') ||
      gesture.current
    )
      return;
    keyboardInput.current = false;
    gesture.current = {
      pointerId: event.pointerId,
      roundId: current.id,
      kind: current.phase,
      startY: event.clientY,
      startProgress: current.openProgress,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const pointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    const active = gesture.current;
    if (active?.pointerId === event.pointerId) updateGesture(event, active);
  };
  const finishPointer = (event: PointerEvent<HTMLButtonElement>, cancelled: boolean) => {
    const active = gesture.current;
    if (active?.pointerId !== event.pointerId) return;
    if (!cancelled) updateGesture(event, active);
    gesture.current = null;
    setReleaseProgress(0);
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    if (
      !cancelled &&
      active.kind === 'launch' &&
      active.roundId === stateRef.current.id &&
      stateRef.current.phase === 'launch' &&
      active.startY - event.clientY >= 80
    )
      send.current({ type: 'RELEASE' });
  };
  const captureLost = (event: PointerEvent<HTMLButtonElement>) => {
    if (
      gesture.current?.pointerId === event.pointerId &&
      !event.currentTarget.hasPointerCapture(event.pointerId)
    ) {
      gesture.current = null;
      setReleaseProgress(0);
    }
  };
  const restart = () => {
    const active = gesture.current;
    gesture.current = null;
    if (active && handle.current?.hasPointerCapture(active.pointerId))
      handle.current.releasePointerCapture(active.pointerId);
    setReleaseProgress(0);
    const next = createLanternState(uuid());
    stateRef.current = next;
    store.saveDraft(next);
    setState(next);
  };
  const clear = () => {
    store.clear();
    gesture.current = null;
    setReleaseProgress(0);
    const next = createLanternState(uuid());
    stateRef.current = next;
    setState(next);
    setClearNotice(
      store.getSnapshot().persistence === 'local'
        ? '本机记录与制作草稿已清除。'
        : '本次记录已清空；浏览器存储不可用，无法确认旧持久记录已清除。',
    );
  };
  const activate = (action: LanternAction, detail: number) => {
    keyboardInput.current = detail === 0;
    send.current(action);
  };
  const confirmTouchDown = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.pointerType !== 'touch' || !event.isPrimary) return;
    event.preventDefault();
    confirmTouch.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
  };
  const confirmTouchMove = (event: PointerEvent<HTMLButtonElement>) => {
    const tap = confirmTouch.current;
    if (
      tap?.id === event.pointerId &&
      Math.hypot(event.clientX - tap.x, event.clientY - tap.y) > 10
    )
      confirmTouch.current = null;
  };
  const confirmTouchUp = (event: PointerEvent<HTMLButtonElement>) => {
    const tap = confirmTouch.current;
    confirmTouch.current = null;
    if (
      !tap ||
      tap.id !== event.pointerId ||
      Math.hypot(event.clientX - tap.x, event.clientY - tap.y) > 10
    )
      return;
    const box = event.currentTarget.getBoundingClientRect();
    if (
      event.clientX < box.left ||
      event.clientX > box.right ||
      event.clientY < box.top ||
      event.clientY > box.bottom
    )
      return;
    event.preventDefault();
    if (stateRef.current.phase === 'unfold' && stateRef.current.openProgress === 1)
      activate({ type: 'CONFIRM_OPEN' }, 1);
  };
  const count = Array.from(state.wish).length;
  const colorLabel = colors.find((item) => item.value === state.color)!.label;
  const patternLabel = patterns.find((item) => item.value === state.pattern)!.label;
  const currentCard = records.cards.find(
    (card) =>
      card.id === state.id &&
      card.wish === state.wish &&
      card.color === state.color &&
      card.pattern === state.pattern,
  );

  return (
    <div className="lantern-page" data-lantern-phase={state.phase} id="lantern-app">
      <header className="lantern-header">
        <a href="#lantern-app" className="lantern-brand">
          <span className="lantern-brand-seal" aria-hidden="true">
            愿
          </span>
          <span>
            新春造灯所<small>A LITTLE WISH, A LITTLE LIGHT</small>
          </span>
        </a>
        <span className="lantern-header-note">
          离线演示 · 一盏心意 <i aria-hidden="true">✦</i>
        </span>
      </header>
      <main className="lantern-layout">
        <section className="lantern-introduction" aria-labelledby="lantern-title">
          <p className="lantern-eyebrow">把心里的光，交给温柔的风</p>
          <h1 id="lantern-title">
            把愿望
            <br />
            放上天<span>。</span>
          </h1>
          <p className="lantern-lead">
            写一句心愿，亲手展开一盏纸灯。
            <br />
            选上喜欢的颜色，让它带着心意升起。
          </p>
          <ol className="lantern-steps" aria-label="制作步骤">
            {steps.map((label, index) => (
              <li
                key={label}
                aria-current={stepForPhase[state.phase] === index ? 'step' : undefined}
                data-done={index < stepForPhase[state.phase]}
              >
                <span>{String(index + 1).padStart(2, '0')}</span>
                {label}
              </li>
            ))}
          </ol>
          <p className="lantern-phase" role="status" aria-label="纸灯制作状态">
            <span />
            {phases[state.phase]}
          </p>
        </section>

        <div className="lantern-stage-column">
          <div
            className="lantern-stage"
            role="group"
            aria-label="纸灯制作与放飞场景"
            data-phase={state.phase}
            data-open-progress={state.openProgress}
          >
            {sceneActive && scene}
            <div className="lantern-stage-grain" aria-hidden="true" />
            <div className="lantern-stage-orbit" aria-hidden="true" />
            <span className="lantern-scene-mark" aria-hidden="true">
              心愿手作 / WISH ATELIER
            </span>
            {state.phase !== 'keepsake' ? (
              <>
                <div
                  className={`lantern-object ${state.phase === 'flying' ? 'lantern-object-flying' : ''}`}
                >
                  <LanternArt
                    open={state.openProgress}
                    color={state.color}
                    pattern={state.pattern}
                    flying={state.phase === 'flying'}
                    lit={state.phase === 'launch' || state.phase === 'flying'}
                  />
                </div>
                {(state.phase === 'unfold' || state.phase === 'launch') && (
                  <>
                    <div className="lantern-gesture-hint" aria-hidden="true">
                      <span>↑</span>
                      {state.phase === 'unfold' ? '按住红色提环，向上拉开' : '向上轻推，松手放飞'}
                    </div>
                    <button
                      ref={handle}
                      type="button"
                      className={`lantern-gesture-handle ${state.phase === 'unfold' ? 'lantern-pull-handle' : 'lantern-release-handle'}`}
                      aria-label={state.phase === 'unfold' ? '向上拉开纸灯' : '向上轻推放飞纸灯'}
                      onPointerDown={pointerDown}
                      onPointerMove={pointerMove}
                      onPointerUp={(event) => finishPointer(event, false)}
                      onPointerCancel={(event) => finishPointer(event, true)}
                      onLostPointerCapture={captureLost}
                      onClick={(event) => {
                        if (event.detail !== 0) return;
                        keyboardInput.current = true;
                        if (stateRef.current.phase === 'unfold')
                          send.current({
                            type: 'OPEN_PROGRESS',
                            progress: stateRef.current.openProgress + 0.25,
                          });
                        else if (stateRef.current.phase === 'launch')
                          send.current({ type: 'RELEASE' });
                      }}
                      onKeyDown={(event) => {
                        if (event.repeat && (event.key === 'Enter' || event.key === ' '))
                          event.preventDefault();
                      }}
                    >
                      <span
                        className="lantern-handle-ring"
                        style={{
                          opacity: state.phase === 'launch' ? 0.6 + releaseProgress * 0.4 : 1,
                        }}
                        aria-hidden="true"
                      >
                        ↑
                      </span>
                    </button>
                  </>
                )}
                <div className="lantern-stage-caption" aria-hidden="true">
                  <span>
                    {state.phase === 'wish'
                      ? '一句小小的心愿，等你写上来。'
                      : state.phase === 'unfold'
                        ? '慢慢展开，进度会替你记住。'
                        : state.phase === 'decorate'
                          ? '颜色与纹样，都听你的。'
                          : state.phase === 'launch'
                            ? '准备好了，就把心愿交给风。'
                            : '愿这一盏，带着你的心意走得很远。'}
                  </span>
                  <small>纸艺灵感 · 无需点火</small>
                </div>
              </>
            ) : (
              <article className="lantern-keepsake" aria-label="新年心愿纪念卡">
                <div className="lantern-card-top">
                  <span>
                    心愿留念<small>A WISH TO KEEP</small>
                  </span>
                  <span className="lantern-card-seal" aria-hidden="true">
                    新<br />意
                  </span>
                </div>
                <div className="lantern-card-art" aria-hidden="true">
                  <LanternArt open={1} color={state.color} pattern={state.pattern} />
                </div>
                <blockquote>{state.wish}</blockquote>
                <p className="lantern-card-closing">愿这一盏，照亮新的好光景。</p>
                <div className="lantern-card-bottom">
                  <span>
                    {colorLabel} · {patternLabel}
                  </span>
                  <span>把愿望放上天 ✦</span>
                </div>
              </article>
            )}
          </div>
          {sceneActive && controls}
        </div>

        <section className="lantern-workbench" ref={workbench} aria-label="纸灯制作操作">
          {state.phase === 'wish' && (
            <>
              <p className="lantern-step-kicker">01 / 写一句心愿</p>
              <h2 tabIndex={-1}>把小小的盼望，写在这里。</h2>
              <label className="lantern-wish-label" htmlFor="lantern-wish">
                新年心愿
                <span>
                  {count} / {lanternWishLimit}
                </span>
              </label>
              <textarea
                id="lantern-wish"
                aria-label="新年心愿"
                rows={2}
                value={state.wish}
                placeholder="愿新的一年……"
                onChange={(event) => send.current({ type: 'SET_WISH', value: event.target.value })}
              />
              <div className="lantern-presets" role="group" aria-label="选一句心愿">
                {presets.map((preset) => (
                  <button
                    key={preset.label}
                    type="button"
                    onClick={() => send.current({ type: 'SET_WISH', value: preset.wish })}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
              <button
                type="button"
                className="lantern-primary"
                disabled={!isLanternWish(normalizeWish(state.wish))}
                onClick={(event) => activate({ type: 'START' }, event.detail)}
              >
                写下这个心愿<span aria-hidden="true">↗</span>
              </button>
              <p className="lantern-reassurance">最多 32 个字。心愿只在本机，不会上传。</p>
            </>
          )}
          {state.phase === 'unfold' && (
            <>
              <p className="lantern-step-kicker">02 / 让纸灯舒展开</p>
              <h2 tabIndex={-1}>拉一拉，纸里的光就醒了。</h2>
              <p className="lantern-instruction">
                按住场景中的红色提环向上拉。
                <br />
                可以松手再拉，每一小段进度都会保留。
              </p>
              <div className="lantern-open-meter">
                <progress
                  aria-label="纸灯展开进度"
                  max={100}
                  value={Math.round(state.openProgress * 100)}
                />
                <span>{Math.round(state.openProgress * 100)}%</span>
              </div>
              <div className="lantern-action-row">
                <button
                  type="button"
                  className="lantern-primary"
                  disabled={state.openProgress < 1}
                  onPointerDown={confirmTouchDown}
                  onPointerMove={confirmTouchMove}
                  onPointerUp={confirmTouchUp}
                  onPointerCancel={() => {
                    confirmTouch.current = null;
                  }}
                  onPointerLeave={() => {
                    confirmTouch.current = null;
                  }}
                  onLostPointerCapture={() => {
                    confirmTouch.current = null;
                  }}
                  onClick={(event) => activate({ type: 'CONFIRM_OPEN' }, event.detail)}
                >
                  开始装饰<span aria-hidden="true">↗</span>
                </button>
                <button
                  type="button"
                  className="lantern-secondary"
                  disabled={state.openProgress === 1}
                  onClick={() => send.current({ type: 'OPEN_PROGRESS', progress: 1 })}
                >
                  展开纸灯
                </button>
              </div>
              <p className="lantern-reassurance">也可以点击“展开纸灯”，或用键盘激活红色提环。</p>
            </>
          )}
          {state.phase === 'decorate' && (
            <>
              <p className="lantern-step-kicker">03 / 留一点自己的喜欢</p>
              <h2 tabIndex={-1}>挑一抹颜色，添一枚心意。</h2>
              <fieldset className="lantern-option-group">
                <legend>纸色</legend>
                <div className="lantern-color-options">
                  {colors.map((color) => (
                    <button
                      type="button"
                      key={color.value}
                      aria-pressed={state.color === color.value}
                      onClick={() => send.current({ type: 'SET_COLOR', color: color.value })}
                    >
                      <span
                        className={`lantern-color-swatch lantern-color-${color.value}`}
                        aria-hidden="true"
                      />
                      {color.label}
                    </button>
                  ))}
                </div>
              </fieldset>
              <fieldset className="lantern-option-group">
                <legend>纹样</legend>
                <div className="lantern-pattern-options">
                  {patterns.map((pattern) => (
                    <button
                      type="button"
                      key={pattern.value}
                      aria-pressed={state.pattern === pattern.value}
                      onClick={() => send.current({ type: 'SET_PATTERN', pattern: pattern.value })}
                    >
                      <span aria-hidden="true">{pattern.mark}</span>
                      {pattern.label}
                    </button>
                  ))}
                </div>
              </fieldset>
              <button
                type="button"
                className="lantern-primary"
                onClick={(event) => activate({ type: 'PREPARE' }, event.detail)}
              >
                准备放飞<span aria-hidden="true">↗</span>
              </button>
            </>
          )}
          {state.phase === 'launch' && (
            <>
              <p className="lantern-step-kicker">04 / 心意准备好了吗</p>
              <h2 tabIndex={-1}>让风，替你带一程。</h2>
              <p className="lantern-wish-preview">“{state.wish}”</p>
              <p className="lantern-instruction">
                向上轻推红色提环，松手放飞。
                <br />
                也可以直接点击下方按钮。
              </p>
              <button
                type="button"
                className="lantern-primary"
                onClick={(event) => activate({ type: 'RELEASE' }, event.detail)}
              >
                放飞心愿<span aria-hidden="true">↑</span>
              </button>
              <p className="lantern-reassurance">这是屏幕里的纸灯，不需要点火。</p>
            </>
          )}
          {state.phase === 'flying' && (
            <>
              <p className="lantern-step-kicker">心愿正在升起</p>
              <h2 tabIndex={-1}>不必着急，风会接住它。</h2>
              <p className="lantern-instruction">
                把这一刻的温柔，
                <br />
                留给认真许愿的自己。
              </p>
              <span className="lantern-flight-dots" aria-hidden="true">
                · · ·
              </span>
            </>
          )}
          {state.phase === 'keepsake' && (
            <>
              <p className="lantern-step-kicker">05 / 把这一刻留下</p>
              <h2 tabIndex={-1}>心意升起，也有回响。</h2>
              <p className="lantern-instruction">
                这一盏独属于你的新年纸灯，
                <br />
                已经变成一张小小的纪念卡。
              </p>
              <p
                className="lantern-local-save"
                data-save-state={currentCard ? 'saved' : cardError ? 'error' : 'pending'}
                role="status"
                aria-label="纸灯保存状态"
              >
                {currentCard
                  ? records.persistence === 'local'
                    ? '纪念卡已留在本机'
                    : '纪念卡暂存在这次打开中'
                  : cardError
                    ? '这张纪念卡尚未确认保存，可以重新制作。'
                    : '正在收好这张纪念卡…'}
              </p>
              <button type="button" className="lantern-primary" onClick={restart}>
                再做一盏<span aria-hidden="true">↗</span>
              </button>
            </>
          )}
          {state.phase !== 'wish' && state.phase !== 'keepsake' && (
            <button type="button" className="lantern-text-button" onClick={restart}>
              重新制作
            </button>
          )}
        </section>
      </main>

      <section className="lantern-local-records" aria-label="本机心愿记录">
        <p className="lantern-storage-hint">仅本机虚拟放飞，不会真实寄送，也不是多人实时场景。</p>
        <p className="lantern-storage-hint">
          {records.persistence === 'local'
            ? '心愿与纪念卡只保存在当前浏览器，不会随文件分享。'
            : '浏览器没有允许持久保存；当前仅在这次打开中暂存，刷新后可能丢失。'}
        </p>
        <details>
          <summary>
            留在本机的灯
            <span role="status" aria-label="本机纸灯数量">
              {records.cards.length} 盏纸灯
            </span>
          </summary>
          <div className="lantern-records-body">
            {records.cards.length ? (
              <ul aria-label="本机纸灯记录">
                {records.cards.map((card) => (
                  <li key={card.id}>
                    <span
                      className={`lantern-record-dot lantern-color-${card.color}`}
                      aria-hidden="true"
                    />
                    <div>
                      <strong>{card.wish}</strong>
                      <p>
                        {colors.find((color) => color.value === card.color)!.label} ·{' '}
                        {patterns.find((pattern) => pattern.value === card.pattern)!.label}
                      </p>
                    </div>
                    <time dateTime={card.createdAt}>
                      {new Date(card.createdAt).toLocaleDateString('zh-CN')}
                    </time>
                  </li>
                ))}
              </ul>
            ) : (
              <p>还没有完成的纸灯。先为自己许一个愿吧。</p>
            )}
            <button type="button" className="lantern-text-button" onClick={clear}>
              清除本机记录
            </button>
          </div>
        </details>
        <p role="status" aria-label="纸灯记录清除状态" className="lantern-clear-notice">
          {clearNotice}
        </p>
      </section>
      <footer className="lantern-footer">
        <span>新春造灯所 · 把愿望放上天</span>
        <span>
          原创纸艺互动 <i aria-hidden="true">✦</i> 心意留在本机
        </span>
      </footer>
    </div>
  );
}
