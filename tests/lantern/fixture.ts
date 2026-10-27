import { test as base, expect, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const lanternArtifactPath = resolve('.artifacts/offline/paper-lantern-new-year.html');
const auxiliary = process.env.OFFLINE_TEST_BASE_URL;
if (auxiliary) {
  const url = new URL(auxiliary);
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('Lantern HTTP auxiliary acceptance requires an explicit loopback origin.');
}
export const lanternUrl = auxiliary
  ? new URL('paper-lantern-new-year.html', `${auxiliary.replace(/\/$/, '')}/`).href
  : pathToFileURL(lanternArtifactPath).href;

type MediaCounts = {
  requests: number;
  tracks: number;
  ended: number;
  live: number;
  pending: number;
  invalidAudio: number;
};
type MediaControls = { state: () => MediaCounts; grantNext: () => void };
type ProbeWindow = typeof globalThis & { __lanternMedia: MediaControls };

export const mediaCounts = (page: Page): Promise<MediaCounts> =>
  page.evaluate(() => (globalThis as ProbeWindow).__lanternMedia.state());
export const grantMedia = (page: Page): Promise<void> =>
  page.evaluate(() => (globalThis as ProbeWindow).__lanternMedia.grantNext());

export async function reloadLantern(page: Page): Promise<void> {
  if (auxiliary) await page.context().setOffline(false);
  try {
    await page.reload();
  } finally {
    await page.context().setOffline(true);
  }
  expect(await page.evaluate(() => navigator.onLine)).toBe(false);
}

export const test = base.extend<{ mediaPermission: 'grant' | 'denied' | 'deferred' }>({
  mediaPermission: ['grant', { option: true }],
  page: async ({ page, context, mediaPermission }, use) => {
    const errors: string[] = [];
    const attempts: string[] = [];
    const resources: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    context.on('request', (request) => {
      if (
        request.url() !== lanternUrl ||
        !request.isNavigationRequest() ||
        request.frame() !== page.mainFrame()
      )
        resources.push(`${request.resourceType()}:${new URL(request.url()).protocol}`);
    });
    await context.exposeBinding('__lanternNetworkAttempt', (_source, transport: string) => {
      attempts.push(transport);
    });
    await context.addInitScript(
      ({ permission }) => {
        const scope = globalThis as ProbeWindow & {
          __lanternNetworkAttempt: (transport: string) => Promise<void>;
        };
        const report = (transport: string) =>
          void scope.__lanternNetworkAttempt(transport).catch(() => {});
        Object.defineProperty(globalThis, 'fetch', {
          configurable: true,
          value: () => {
            report('fetch');
            return Promise.reject(new Error('The lantern artifact attempted fetch.'));
          },
        });
        for (const name of ['XMLHttpRequest', 'WebSocket'])
          Object.defineProperty(globalThis, name, {
            configurable: true,
            value: function blockedTransport() {
              report(name);
              throw new Error(`The lantern artifact attempted ${name}.`);
            },
          });
        Object.defineProperty(navigator, 'sendBeacon', {
          configurable: true,
          value: () => {
            report('sendBeacon');
            return false;
          },
        });

        let requests = 0;
        let invalidAudio = 0;
        const tracks: MediaStreamTrack[] = [];
        const pending: ((stream: MediaStream) => void)[] = [];
        const synthetic = () => {
          const canvas = document.createElement('canvas');
          canvas.width = 320;
          canvas.height = 240;
          const painter = canvas.getContext('2d');
          if (!painter) throw new Error('Synthetic video canvas is unavailable.');
          let frame = 0;
          const draw = () => {
            painter.fillStyle = frame % 2 ? '#f4d7b0' : '#edd5a5';
            painter.fillRect(0, 0, 320, 240);
            painter.fillStyle = '#5e2023';
            painter.font = 'bold 21px sans-serif';
            painter.fillText('TEST LANTERN CAMERA', 15, 95);
            painter.fillText(String(frame++), 145, 150);
          };
          draw();
          const stream = canvas.captureStream(10);
          const timer = globalThis.setInterval(draw, 100);
          for (const track of stream.getTracks()) {
            tracks.push(track);
            const originalStop = track.stop.bind(track);
            track.stop = () => {
              originalStop();
              if (stream.getTracks().every((item) => item.readyState === 'ended'))
                globalThis.clearInterval(timer);
            };
          }
          return stream;
        };
        // The real getUserMedia function is never read or invoked.
        Object.defineProperty(navigator, 'mediaDevices', {
          configurable: true,
          value: {
            getUserMedia: (constraints?: MediaStreamConstraints): Promise<MediaStream> => {
              requests += 1;
              if (constraints?.audio !== false) invalidAudio += 1;
              if (permission === 'denied')
                return Promise.reject(new DOMException('Synthetic denial.', 'NotAllowedError'));
              if (permission === 'deferred') return new Promise((resolve) => pending.push(resolve));
              return Promise.resolve(synthetic());
            },
          },
        });
        scope.__lanternMedia = {
          state: () => ({
            requests,
            tracks: tracks.length,
            ended: tracks.filter((track) => track.readyState === 'ended').length,
            live: tracks.filter((track) => track.readyState === 'live').length,
            pending: pending.length,
            invalidAudio,
          }),
          grantNext: () => {
            const resolve = pending.shift();
            if (!resolve) throw new Error('No synthetic camera request is pending.');
            resolve(synthetic());
          },
        };
      },
      { permission: mediaPermission },
    );
    try {
      if (auxiliary) await context.setOffline(false);
      try {
        await page.goto(lanternUrl);
      } finally {
        await context.setOffline(true);
      }
      expect(await page.evaluate(() => navigator.onLine)).toBe(false);
      await use(page);
    } finally {
      expect(errors).toEqual([]);
      expect(attempts).toEqual([]);
      expect(resources).toEqual([]);
      expect((await mediaCounts(page)).invalidAudio).toBe(0);
    }
  },
});

export { expect };
