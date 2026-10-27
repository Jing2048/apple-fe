import {
  Component,
  StrictMode,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Campaign } from '@apple/contracts';
import { POST_THEMES } from '../post/themes';
import { CameraPost } from '../camera/CameraPost';
import type { OfflinePostRuntime } from '../post/runtime';
import type { BlessingIndex } from '../post/recovery';
import { OfflineRecords } from './records';
import { getOfflineDraftStorage } from './storage';
import '../entry.css';
import './offline.css';

const themeId = import.meta.env.VITE_POST_THEME === 'new-year' ? 'new-year' : 'classic';
const theme = POST_THEMES[themeId];
const campaign: Campaign = {
  id: 'cloud-post',
  version: themeId === 'classic' ? 'cloud-post-offline-v1' : 'cloud-post-offline-new-year-v1',
  title: `${theme.brand} · 离线演示`,
  interactions: ['swipe'],
  assets: [],
  privacy: { analyticsOptional: true },
};
const records = new OfflineRecords(undefined, themeId);
const draftStorage = getOfflineDraftStorage(undefined, themeId);
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      networkMode: 'always',
      retry: false,
      staleTime: Infinity,
      refetchOnWindowFocus: false,
    },
    mutations: { networkMode: 'always', retry: false },
  },
});

function OfflineReceipt({
  roundId,
  blessingIndex,
}: {
  roundId: string;
  blessingIndex: BlessingIndex;
}) {
  const snapshot = useSyncExternalStore(
    records.subscribe,
    records.getSnapshot,
    records.getSnapshot,
  );
  useEffect(() => {
    records.record(roundId, blessingIndex);
  }, [roundId, blessingIndex]);
  const record = snapshot.records.find((item) => item.roundId === roundId);
  return (
    <div className="post-receipt">
      <div className="post-save-status" role="status" aria-label="祝福保存状态">
        <span className="post-save-check" aria-hidden="true">
          ✓
        </span>
        <strong>
          {!record
            ? '正在收好这颗星光…'
            : snapshot.persistence === 'local'
              ? '星光已留在本机'
              : '星光暂存在这次打开中'}
        </strong>
        <p>
          {snapshot.persistence === 'local'
            ? '记录只保存在当前浏览器。没有上传，也不是服务端保存回执。'
            : '浏览器没有允许本地保存，当前记录仅在内存中，关闭或刷新后可能丢失。'}
        </p>
      </div>
    </div>
  );
}

class OfflineBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (this.state.failed)
      return (
        <main className="entry-fallback" role="alert">
          <h1>离线演示暂时没有打开</h1>
          <p>请使用支持 JavaScript 的现代浏览器打开完整 HTML 文件。</p>
          <button type="button" onClick={() => location.reload()}>
            重新打开离线演示
          </button>
        </main>
      );
    return this.props.children;
  }
}

function OfflineExperience() {
  const snapshot = useSyncExternalStore(
    records.subscribe,
    records.getSnapshot,
    records.getSnapshot,
  );
  const [generation, setGeneration] = useState(0);
  const [activeDraftStorage, setActiveDraftStorage] = useState(() => draftStorage);
  const [showRecords, setShowRecords] = useState(false);
  const [notice, setNotice] = useState('');
  const runtime = useMemo<OfflinePostRuntime>(
    () => ({
      campaign,
      draftStorage: activeDraftStorage,
      renderReceipt: (args) => <OfflineReceipt {...args} />,
    }),
    [activeDraftStorage],
  );
  const clear = () => {
    records.clear();
    // A failed deletion must not immediately restore an old completed draft.
    if (records.getSnapshot().persistence === 'memory') setActiveDraftStorage(null);
    setGeneration((value) => value + 1);
    setNotice(
      records.getSnapshot().persistence === 'local'
        ? '已清除本机记录和旅程草稿，可以重新开始。'
        : '当前列表已清空。浏览器存储不可用，无法确认旧的持久记录已清除。',
    );
  };
  return (
    <div className="offline-experience" data-post-theme={theme.id}>
      <aside className="offline-note" aria-label="离线演示说明">
        <div>
          <strong>离线演示</strong>
          <p>
            {themeId === 'new-year'
              ? '一封放在本机的新岁祝福。无需联网，没有数据上传。'
              : '一封放在本机的星光。无需联网，没有数据上传。'}
          </p>
          <span>
            {snapshot.persistence === 'local'
              ? '本机记录可用 · 仅限当前浏览器'
              : '当前仅在本次打开中暂存'}
          </span>
        </div>
        <div className="offline-actions">
          <button
            type="button"
            aria-expanded={showRecords}
            aria-controls="offline-records"
            onClick={() => setShowRecords((value) => !value)}
          >
            {showRecords ? '收起本机记录' : '查看本机记录'}
          </button>
          <button type="button" onClick={clear}>
            清除本机记录
          </button>
        </div>
      </aside>
      <p className="offline-clear-status" role="status" aria-label="记录清除状态">
        {notice}
      </p>
      {showRecords && (
        <section id="offline-records" className="offline-records" aria-label="本机记录">
          <h2>留在这台设备的小小星光</h2>
          <p role="status" aria-label="本机记录数量">
            {snapshot.records.length} 封星光
          </p>
          <p>仅保留最近 20 封。分享或移动这个文件不会带走浏览器里的历史记录。</p>
          {snapshot.records.length ? (
            <ul>
              {snapshot.records.map((item) => (
                <li key={item.id}>
                  <span aria-hidden="true">✦</span>
                  <div>
                    <strong>{theme.blessings[item.blessingIndex].name}</strong>
                    <p>{theme.blessings[item.blessingIndex].title}</p>
                  </div>
                  <time dateTime={item.createdAt}>
                    {new Date(item.createdAt).toLocaleString('zh-CN')}
                  </time>
                </li>
              ))}
            </ul>
          ) : (
            <p>还没有完成的信。陪小云朵走一程吧。</p>
          )}
        </section>
      )}
      <CameraPost key={generation} offline={runtime} theme={theme} />
    </div>
  );
}

document.title = `${theme.brand} · 离线演示`;
const root = document.getElementById('root');
if (!root) throw new Error('Offline application root is missing');
createRoot(root).render(
  <StrictMode>
    <OfflineBoundary>
      <QueryClientProvider client={queryClient}>
        <OfflineExperience />
      </QueryClientProvider>
    </OfflineBoundary>
  </StrictMode>,
);
