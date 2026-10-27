import { Component, lazy, StrictMode, Suspense, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import './entry.css';

const Lab = lazy(() => import('./App').then(({ App }) => ({ default: App })));
const Post = lazy(() =>
  import('./post/CloudPost').then(({ CloudPost }) => ({ default: CloudPost })),
);
const isLab = location.pathname === '/lab' || location.pathname.startsWith('/lab/');
document.title = isLab ? '互动工程验证台' : '云朵邮局 · 寄一封星光';

class PageBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (this.state.failed)
      return (
        <main className="entry-fallback" role="alert">
          <span aria-hidden="true">☁</span>
          <h1>云朵暂时迷了路</h1>
          <p>页面没有打开成功。检查网络后，再试一次吧。</p>
          <button type="button" onClick={() => location.reload()}>
            重新打开页面
          </button>
        </main>
      );
    return this.props.children;
  }
}

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 30_000, refetchOnWindowFocus: false } },
});

const root = document.getElementById('root');
if (!root) throw new Error('Application root is missing');
createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <PageBoundary>
        <Suspense
          fallback={
            <main className="entry-fallback" role="status">
              <span aria-hidden="true">☁</span>
              <p>正在打开一封来自云端的信…</p>
            </main>
          }
        >
          {isLab ? <Lab /> : <Post />}
        </Suspense>
      </PageBoundary>
    </QueryClientProvider>
  </StrictMode>,
);
