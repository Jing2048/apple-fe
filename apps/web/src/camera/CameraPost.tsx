import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { CloudPost } from '../post/CloudPost';
import type { CloudPostProps } from '../post/runtime';
import { CameraController } from './controller';
import './camera.css';

const fallbackCopy: Record<string, { title: string; detail: string }> = {
  insecure: {
    title: '当前打开方式无法使用相机',
    detail: '普通玩法不受影响。在支持相机的安全页面中，可以再试一次。',
  },
  unsupported: {
    title: '这台浏览器暂不支持相机',
    detail: '普通玩法不受影响。继续陪小云朵收集星光吧。',
  },
  denied: {
    title: '这次没有获得相机权限',
    detail: '普通玩法不受影响。需要时可在浏览器设置中允许相机，再自行开启。',
  },
  'not-found': {
    title: '没有找到可以使用的相机',
    detail: '普通玩法不受影响。连接可用相机后，可以再试一次。',
  },
  busy: {
    title: '相机可能正在被其他应用使用',
    detail: '普通玩法不受影响。结束其他应用的相机使用后，可以再试一次。',
  },
  ended: {
    title: '相机画面已结束',
    detail: '已经回到普通玩法。需要时可以再次点击开启。',
  },
  playback: {
    title: '暂时无法播放相机画面',
    detail: '相机已关闭，普通玩法不受影响。需要时可以再试一次。',
  },
  unavailable: {
    title: '暂时无法开启相机',
    detail: '普通玩法不受影响。也可以稍后再试。',
  },
};

function CameraIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="m8 6 1.5-2h5L16 6h3a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h3Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="13" r="4" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

/** Camera preview is opt-in; the game, recovery and local cards keep their own state. */
export function CameraPost({ offline, theme }: CloudPostProps = {}) {
  const [camera] = useState(() => new CameraController());
  const snapshot = useSyncExternalStore(camera.subscribe, camera.getSnapshot);
  const [sceneActive, setSceneActive] = useState(false);
  const onSceneActiveChange = useCallback(
    (active: boolean) => {
      setSceneActive(active);
      if (!active) camera.close();
    },
    [camera],
  );

  useEffect(() => camera.bindLifecycle(document, window), [camera]);

  const fallback = fallbackCopy[snapshot.reason ?? 'unavailable'] ?? fallbackCopy.unavailable!;
  const requesting = snapshot.status === 'requesting';
  const active = snapshot.status === 'active';
  const title = active
    ? '相机实景已开启'
    : requesting
      ? '正在等待相机权限与画面…'
      : snapshot.status === 'fallback'
        ? fallback.title
        : '当前使用普通云朵玩法';
  const detail = active
    ? '移动设备可以换一处风景；云朵与星光仍可拖动、点击。'
    : requesting
      ? '只有画面实际开始播放，才会显示已开启。可以随时取消。'
      : snapshot.status === 'fallback'
        ? fallback.detail
        : '相机只会在你点击后开启。画面仅在此设备显示，不拍照、不录制、不上传。';

  return (
    <CloudPost
      {...(offline ? { offline } : {})}
      {...(theme ? { theme } : {})}
      onSceneActiveChange={onSceneActiveChange}
      introNote={
        <p className="camera-intro-note">
          <CameraIcon />
          开始后可选相机实景，把云朵放进眼前的风景。
        </p>
      }
      scene={
        <div className="camera-scene" data-camera-active={active} aria-hidden={!active}>
          <video
            className="camera-scene-video"
            aria-label="相机实景画面"
            ref={camera.setVideoElement}
            muted
            playsInline
          />
        </div>
      }
      controls={
        <section className="camera-controls" aria-label="相机实景设置">
          <div className="camera-control-heading">
            <span className="camera-control-icon">
              <CameraIcon />
            </span>
            <div>
              <h2>换一扇看风景的窗</h2>
              <p>可选相机实景 · 普通玩法始终可用</p>
            </div>
          </div>
          <div className="camera-control-actions">
            {active ? (
              <button type="button" className="camera-action" onClick={camera.close}>
                关闭相机
              </button>
            ) : (
              <button
                type="button"
                className="camera-action"
                disabled={!sceneActive || requesting}
                onClick={() => {
                  void camera.start();
                }}
              >
                {requesting ? '正在开启相机…' : '开启相机实景'}
              </button>
            )}
            {requesting && (
              <button type="button" className="camera-cancel" onClick={camera.close}>
                取消相机开启
              </button>
            )}
          </div>
          <div
            className="camera-status"
            role="status"
            aria-label="相机状态"
            data-camera-state={snapshot.status}
            data-camera-reason={snapshot.reason ?? undefined}
          >
            <strong>{title}</strong>
            <p>{detail}</p>
            {!sceneActive && <p>继续收集后，可以自行开启相机。</p>}
          </div>
        </section>
      }
    />
  );
}
