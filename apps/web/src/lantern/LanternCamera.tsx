import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { CameraController, type CameraReason } from '../camera/controller';
import { LanternApp } from './LanternApp';
import './camera.css';

const fallback: Record<CameraReason, string> = {
  insecure: '当前打开方式不支持相机。可在支持的安全环境中再试，普通纸灯玩法照常可用。',
  unsupported: '这个浏览器暂不支持相机，继续使用纸艺背景也可以完整放飞心愿。',
  denied: '这次没有获得相机权限。你可以继续普通玩法，需要时再自行开启。',
  'not-found': '没有找到可用相机，普通纸灯玩法不受影响。',
  busy: '相机可能被其他应用占用，普通纸灯玩法不受影响。',
  unavailable: '相机暂时无法开启，继续陪这盏纸灯走一程吧。',
  ended: '相机画面已结束，已回到纸艺背景。再次开启需要你点击。',
  playback: '画面暂时无法播放，相机已关闭；普通纸灯玩法仍可继续。',
};

/** Opt-in local preview only; all device lifetime handling stays in the shared controller. */
export function LanternCamera() {
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
  const requesting = snapshot.status === 'requesting';
  const active = snapshot.status === 'active';
  return (
    <LanternApp
      onSceneActiveChange={onSceneActiveChange}
      scene={
        <div className="lantern-camera-scene" data-active={active} aria-hidden={!active}>
          <video ref={camera.setVideoElement} muted playsInline aria-label="纸灯实景画面" />
        </div>
      }
      controls={
        <details
          className="lantern-camera-panel"
          onToggle={(event) => {
            if (!event.currentTarget.open) camera.close();
          }}
        >
          <summary>相机实景（可选）</summary>
          <section className="lantern-camera-controls" aria-label="纸灯相机设置">
            <div className="lantern-camera-heading">
              <span aria-hidden="true">◎</span>
              <div>
                <strong>把纸灯放进眼前的风景</strong>
                <p>可选相机实景 · 普通模式完整可玩</p>
              </div>
            </div>
            <div className="lantern-camera-actions">
              {active ? (
                <button type="button" onClick={camera.close}>
                  关闭相机
                </button>
              ) : (
                <button
                  type="button"
                  disabled={!sceneActive || requesting}
                  onClick={() => {
                    void camera.start();
                  }}
                >
                  {requesting ? '正在开启相机…' : '开启相机实景'}
                </button>
              )}
              {requesting && (
                <button type="button" onClick={camera.close}>
                  取消相机开启
                </button>
              )}
            </div>
            <div
              role="status"
              aria-label="相机状态"
              data-camera-state={snapshot.status}
              className="lantern-camera-status"
            >
              <strong>
                {active
                  ? '相机实景已开启'
                  : requesting
                    ? '正在等待相机权限与画面…'
                    : snapshot.status === 'fallback'
                      ? '已回到普通纸灯模式'
                      : '当前使用纸艺背景'}
              </strong>
              <p>
                {active
                  ? '纸灯叠在此刻的画面上，不进行空间定位，不拍照、不录制、不上传。'
                  : requesting
                    ? '只有实际播放后才显示开启。可以随时取消。'
                    : snapshot.reason
                      ? fallback[snapshot.reason]
                      : '只有你点击后才会申请相机权限；退出时自动关闭。'}
              </p>
            </div>
          </section>
        </details>
      }
    />
  );
}
