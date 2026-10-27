import { test as base, expect, type CDPSession, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

type Probe = {
  requests: number;
  grants: number;
  tracksCreated: number;
  tracksEnded: number;
  liveTracks: number;
  stopCalls: number;
  pendingGrants: number;
  pendingPlay: number;
  invalidConstraints: number;
};
type Controls = {
  state: () => Probe;
  grantNext: () => void;
  resolvePlay: () => void;
};
type ProbeWindow = typeof globalThis & { __syntheticCamera: Controls };

const auxiliary = process.env.OFFLINE_TEST_BASE_URL;
const target = auxiliary
  ? new URL('cloud-post-offline.html', `${auxiliary.replace(/\/$/, '')}/`).href
  : pathToFileURL(resolve('.artifacts/offline/cloud-post-offline.html')).href;
const camera = (page: Page) => page.getByRole('status', { name: '相机状态', exact: true });
const video = (page: Page) => page.getByLabel('相机实景画面', { exact: true });
const openCamera = (page: Page) => page.getByRole('button', { name: '开启相机实景', exact: true });
const closeCamera = (page: Page) => page.getByRole('button', { name: '关闭相机', exact: true });
const probe = (page: Page) =>
  page.evaluate(() => (globalThis as ProbeWindow).__syntheticCamera.state());

const test = base.extend<{
  permission: 'grant' | 'denied' | 'deferred';
  capability: 'synthetic' | 'missing' | 'insecure';
  deferPlay: boolean;
}>({
  permission: ['grant', { option: true }],
  capability: ['synthetic', { option: true }],
  deferPlay: [false, { option: true }],
  page: async ({ page, context, permission, capability, deferPlay }, use) => {
    const errors: string[] = [];
    const network: string[] = [];
    const resources: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    context.on('request', (request) => {
      if (
        request.url() !== target ||
        !request.isNavigationRequest() ||
        request.frame() !== page.mainFrame()
      )
        resources.push(`${request.resourceType()}:${new URL(request.url()).protocol}`);
    });
    await context.exposeBinding('__cameraNetworkAttempt', (_source, transport: string) => {
      network.push(transport);
    });
    await context.addInitScript(
      ({ permission, capability, deferPlay }) => {
        const scope = globalThis as ProbeWindow & {
          __cameraNetworkAttempt: (transport: string) => Promise<void>;
        };
        const report = (transport: string) =>
          void scope.__cameraNetworkAttempt(transport).catch(() => {});
        Object.defineProperty(globalThis, 'fetch', {
          configurable: true,
          value: () => {
            report('fetch');
            return Promise.reject(new Error('Camera acceptance must not use the network.'));
          },
        });
        for (const name of ['XMLHttpRequest', 'WebSocket']) {
          Object.defineProperty(globalThis, name, {
            configurable: true,
            value: function blockedTransport() {
              report(name);
              throw new Error('Camera acceptance must not use the network.');
            },
          });
        }
        Object.defineProperty(navigator, 'sendBeacon', {
          configurable: true,
          value: () => {
            report('sendBeacon');
            return false;
          },
        });

        let requests = 0;
        let grants = 0;
        let stopCalls = 0;
        let invalidConstraints = 0;
        const tracks: MediaStreamTrack[] = [];
        const pendingGrants: ((stream: MediaStream) => void)[] = [];
        const pendingPlay: (() => void)[] = [];
        const syntheticStream = () => {
          const canvas = document.createElement('canvas');
          canvas.width = 320;
          canvas.height = 240;
          const painter = canvas.getContext('2d');
          if (!painter) throw new Error('Synthetic canvas context is unavailable.');
          let frame = 0;
          const draw = () => {
            painter.fillStyle = frame % 2 === 0 ? '#b9dce4' : '#d4e9da';
            painter.fillRect(0, 0, canvas.width, canvas.height);
            painter.fillStyle = '#183944';
            painter.font = 'bold 26px sans-serif';
            painter.fillText('TEST CAMERA', 35, 100);
            painter.fillText(String(frame++), 140, 150);
          };
          draw();
          const stream = canvas.captureStream(10);
          const timer = globalThis.setInterval(draw, 100);
          grants += 1;
          for (const track of stream.getTracks()) {
            tracks.push(track);
            const originalStop = track.stop.bind(track);
            track.stop = () => {
              stopCalls += 1;
              originalStop();
              if (stream.getTracks().every((item) => item.readyState === 'ended'))
                globalThis.clearInterval(timer);
            };
          }
          return stream;
        };
        // Never read or call the real getUserMedia implementation.
        Object.defineProperty(navigator, 'mediaDevices', {
          configurable: true,
          value:
            capability === 'missing'
              ? undefined
              : {
                  getUserMedia: (constraints?: MediaStreamConstraints): Promise<MediaStream> => {
                    requests += 1;
                    const input = constraints?.video;
                    const mode = typeof input === 'object' ? input.facingMode : undefined;
                    if (
                      constraints?.audio !== false ||
                      typeof mode !== 'object' ||
                      mode === null ||
                      !('ideal' in mode) ||
                      mode.ideal !== 'environment'
                    )
                      invalidConstraints += 1;
                    if (permission === 'denied')
                      return Promise.reject(
                        new DOMException('Synthetic denial.', 'NotAllowedError'),
                      );
                    if (permission === 'deferred')
                      return new Promise((resolve) => pendingGrants.push(resolve));
                    return Promise.resolve(syntheticStream());
                  },
                },
        });
        if (capability === 'insecure')
          Object.defineProperty(globalThis, 'isSecureContext', {
            configurable: true,
            value: false,
          });
        if (deferPlay) {
          const actualPlay = HTMLMediaElement.prototype.play;
          HTMLMediaElement.prototype.play = async function () {
            await actualPlay.call(this);
            await new Promise<void>((resolve) => pendingPlay.push(resolve));
          };
        }
        scope.__syntheticCamera = {
          state: () => ({
            requests,
            grants,
            tracksCreated: tracks.length,
            tracksEnded: tracks.filter((track) => track.readyState === 'ended').length,
            liveTracks: tracks.filter((track) => track.readyState === 'live').length,
            stopCalls,
            pendingGrants: pendingGrants.length,
            pendingPlay: pendingPlay.length,
            invalidConstraints,
          }),
          grantNext: () => {
            const resolve = pendingGrants.shift();
            if (!resolve) throw new Error('No synthetic permission request is pending.');
            resolve(syntheticStream());
          },
          resolvePlay: () => {
            const resolve = pendingPlay.shift();
            if (!resolve) throw new Error('No synthetic play completion is pending.');
            resolve();
          },
        };
      },
      { permission, capability, deferPlay },
    );
    try {
      if (auxiliary) await context.setOffline(false);
      try {
        await page.goto(target);
      } finally {
        await context.setOffline(true);
      }
      await expect(page.getByRole('status', { name: '星光收集状态' })).toContainText(
        '准备收集星光',
      );
      expect((await probe(page)).requests).toBe(0);
      await expect(openCamera(page)).toHaveCount(0);
      await page.getByRole('button', { name: '开始收集星光', exact: true }).click();
      await expect(openCamera(page)).toBeEnabled();
      await use(page);
    } finally {
      expect(errors).toEqual([]);
      expect(network).toEqual([]);
      expect(resources).toEqual([]);
      expect((await probe(page)).invalidConstraints).toBe(0);
    }
  },
});

async function expectActive(page: Page): Promise<void> {
  await expect(camera(page)).toHaveAttribute('data-camera-state', 'active');
  await expect(camera(page)).toContainText('相机实景已开启');
  await expect
    .poll(() =>
      video(page).evaluate((element: HTMLVideoElement) => ({
        playable: element.readyState >= 2 && element.videoWidth > 0 && !element.paused,
        muted: element.muted,
        inline: element.playsInline,
        hasStream: element.srcObject instanceof MediaStream,
      })),
    )
    .toEqual({ playable: true, muted: true, inline: true, hasStream: true });
}

async function expectStopped(page: Page, created: number): Promise<void> {
  await expect.poll(async () => (await probe(page)).liveTracks).toBe(0);
  expect((await probe(page)).tracksCreated).toBe(created);
  expect((await probe(page)).tracksEnded).toBe(created);
  if (await video(page).count())
    expect(
      await video(page).evaluate((element: HTMLVideoElement) => element.srcObject === null),
    ).toBe(true);
}

async function collectOrdinarily(page: Page): Promise<void> {
  for (let index = 1; index <= 6; index++)
    await page.getByRole('button', { name: `收集第${index}颗星光`, exact: true }).click();
  await expect(page.getByRole('status', { name: '祝福保存状态' })).toContainText('星光已留在本机');
}

async function dragAll(page: Page, mobile: boolean): Promise<void> {
  const touch: CDPSession | undefined = mobile
    ? await page.context().newCDPSession(page)
    : undefined;
  try {
    for (let index = 1; index <= 6; index++) {
      const cloud = await page.locator('.post-player-cloud').boundingBox();
      const star = await page
        .getByRole('button', { name: `收集第${index}颗星光`, exact: true })
        .boundingBox();
      if (!cloud || !star) throw new Error('Camera background displaced the actual drag scene.');
      const from = { x: cloud.x + cloud.width / 2, y: cloud.y + cloud.height / 2 };
      const to = { x: star.x + star.width / 2, y: star.y + star.height / 2 };
      if (touch) {
        await touch.send('Input.dispatchTouchEvent', {
          type: 'touchStart',
          touchPoints: [{ ...from, id: 1 }],
        });
        await touch.send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: [{ ...to, id: 1 }],
        });
        await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      } else {
        await page.mouse.move(from.x, from.y);
        await page.mouse.down();
        await page.mouse.move(to.x, to.y, { steps: 6 });
        await page.mouse.up();
      }
      if (index < 6)
        await expect(page.getByRole('status', { name: '星光数量' })).toHaveText(
          `${index} / 6 颗星光`,
        );
    }
    await expect(page.getByRole('status', { name: '祝福保存状态' })).toContainText(
      '星光已留在本机',
    );
  } finally {
    if (touch) await touch.detach();
  }
}

test('合成视频真实播放、重复开关、视频背景不拦拖星且完成自动停轨', async ({ page, isMobile }) => {
  await openCamera(page).click();
  await expectActive(page);
  if (!isMobile) {
    await mkdir('.artifacts/offline-http', { recursive: true });
    await page
      .getByRole('group', { name: '拖动云朵收集星光', exact: true })
      .scrollIntoViewIfNeeded();
    await page.screenshot({ path: '.artifacts/offline-http/camera-synthetic.png', fullPage: true });
  }
  await closeCamera(page).click();
  await expectStopped(page, 1);
  await openCamera(page).click();
  await expectActive(page);
  expect((await probe(page)).requests).toBe(2);
  await dragAll(page, isMobile);
  await expect(video(page)).toHaveCount(0);
  await expectStopped(page, 2);
});

test.describe('模拟权限拒绝', () => {
  test.use({ permission: 'denied' });
  test('说明拒绝且普通玩法仍可完成，不自动再次请求', async ({ page }) => {
    await openCamera(page).click();
    await expect(camera(page)).toHaveAttribute('data-camera-state', 'fallback');
    await expect(camera(page)).toContainText('这次没有获得相机权限');
    await expect(camera(page)).toContainText('普通玩法不受影响');
    expect((await probe(page)).requests).toBe(1);
    await collectOrdinarily(page);
    expect((await probe(page)).requests).toBe(1);
    await expectStopped(page, 0);
  });
});

test.describe('模拟迟到的授权', () => {
  test.use({ permission: 'deferred' });
  test('取消pending后迟到流立即停止，再次显式开启可成功', async ({ page }) => {
    await openCamera(page).click();
    await expect(camera(page)).toHaveAttribute('data-camera-state', 'requesting');
    await page.getByRole('button', { name: '取消相机开启', exact: true }).click();
    await expect(camera(page)).toHaveAttribute('data-camera-state', 'idle');
    await page.evaluate(() => (globalThis as ProbeWindow).__syntheticCamera.grantNext());
    await expectStopped(page, 1);
    await expect(camera(page)).toHaveAttribute('data-camera-state', 'idle');
    await openCamera(page).click();
    await expect(camera(page)).toHaveAttribute('data-camera-state', 'requesting');
    await page.evaluate(() => (globalThis as ProbeWindow).__syntheticCamera.grantNext());
    await expectActive(page);
    await closeCamera(page).click();
    await expectStopped(page, 2);
  });
});

test.describe('模拟迟到的play完成', () => {
  test.use({ deferPlay: true });
  test('真实视频已播放但play承诺延后，取消后完成不得重新激活', async ({ page }) => {
    await openCamera(page).click();
    await expect.poll(async () => (await probe(page)).pendingPlay).toBe(1);
    expect(await video(page).evaluate((element: HTMLVideoElement) => element.videoWidth > 0)).toBe(
      true,
    );
    await page.getByRole('button', { name: '取消相机开启', exact: true }).click();
    await expectStopped(page, 1);
    await page.evaluate(() => (globalThis as ProbeWindow).__syntheticCamera.resolvePlay());
    await expect(camera(page)).toHaveAttribute('data-camera-state', 'idle');
    await expectStopped(page, 1);
  });
});

for (const [capability, explanation] of [
  ['missing', '这台浏览器暂不支持相机'],
  ['insecure', '当前打开方式无法使用相机'],
] as const) {
  test.describe(`模拟能力 ${capability}`, () => {
    test.use({ capability });
    test('能力检测明确降级，不调用媒体权限且可继续普通玩法', async ({ page }) => {
      await openCamera(page).click();
      await expect(camera(page)).toHaveAttribute('data-camera-state', 'fallback');
      await expect(camera(page)).toContainText(explanation);
      expect((await probe(page)).requests).toBe(0);
      await collectOrdinarily(page);
      await expectStopped(page, 0);
    });
  });
}

test('hidden和pagehide停轨，回到前台/继续游戏不自动重开', async ({ page }) => {
  await openCamera(page).click();
  await expectActive(page);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expectStopped(page, 1);
  await expect(page.getByRole('status', { name: '星光收集状态' })).toContainText('星光收集已暂停');
  await expect(openCamera(page)).toBeDisabled();
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.getByRole('button', { name: '继续收集', exact: true }).click();
  await expect(openCamera(page)).toBeEnabled();
  expect((await probe(page)).requests).toBe(1);
  await openCamera(page).click();
  await expectActive(page);
  await page.evaluate(() => {
    globalThis.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
  });
  await expectStopped(page, 2);
  await expect(page.getByRole('status', { name: '星光收集状态' })).toContainText('星光收集已暂停');
  await page.evaluate(() => {
    globalThis.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  });
  await expect(camera(page)).toHaveAttribute('data-camera-state', 'idle');
  expect((await probe(page)).requests).toBe(2);
});
