import { Component, StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { LanternCamera } from './LanternCamera';
import '../entry.css';

class LanternBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (this.state.failed)
      return (
        <main className="lantern-recovery" role="alert">
          <h1>纸灯暂时没有打开</h1>
          <p>请使用支持 JavaScript 的现代浏览器打开完整文件。</p>
          <button type="button" onClick={() => location.reload()}>
            重新打开纸灯
          </button>
        </main>
      );
    return this.props.children;
  }
}

document.title = '把愿望放上天 · 新年纸灯';
const root = document.getElementById('root');
if (!root) throw new Error('Lantern application root is missing');
createRoot(root).render(
  <StrictMode>
    <LanternBoundary>
      <LanternCamera />
    </LanternBoundary>
  </StrictMode>,
);
