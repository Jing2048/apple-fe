import { test as base, expect, type CDPSession, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const artifact = resolve('.artifacts/offline/cloud-post-offline.html');
const auxiliary = process.env.OFFLINE_TEST_BASE_URL;
const target = auxiliary
  ? new URL('cloud-post-offline.html', `${auxiliary.replace(/\/$/, '')}/`).href
  : pathToFileURL(artifact).href;

const test = base.extend({
  page: async ({ page, context }, use, testInfo) => {
    const errors: string[] = [];
    const transports: string[] = [];
    const subresources: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    context.on('request', (request) => {
      if (
        request.url() !== target ||
        !request.isNavigationRequest() ||
        request.frame() !== page.mainFrame()
      )
        subresources.push(`${request.resourceType()}:${new URL(request.url()).protocol}`);
    });
    await context.exposeBinding('__dragNetworkAttempt', (_source, type: string) => {
      transports.push(type);
    });
    await context.addInitScript(() => {
      const scope = globalThis as typeof globalThis & {
        __dragNetworkAttempt: (type: string) => Promise<void>;
      };
      const report = (type: string) => void scope.__dragNetworkAttempt(type).catch(() => {});
      Object.defineProperty(globalThis, 'fetch', {
        configurable: true,
        value: () => {
          report('fetch');
          return Promise.reject(new Error('Drag acceptance must not use the network.'));
        },
      });
      for (const name of ['XMLHttpRequest', 'WebSocket']) {
        Object.defineProperty(globalThis, name, {
          configurable: true,
          value: function blockedTransport() {
            report(name);
            throw new Error('Drag acceptance must not use the network.');
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
    });
    await testInfo.attach('artifact-identity', {
      body: JSON.stringify({
        acceptanceMode: auxiliary ? 'HTTP auxiliary, not file:// verification' : 'file://',
        sha256: createHash('sha256')
          .update(await readFile(artifact))
          .digest('hex'),
      }),
      contentType: 'application/json',
    });
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
      expect(await page.evaluate(() => navigator.onLine)).toBe(false);
      await use(page);
    } finally {
      expect(errors).toEqual([]);
      expect(transports).toEqual([]);
      expect(subresources).toEqual([]);
    }
  },
});

type Point = { x: number; y: number };

async function cloudCenter(page: Page): Promise<Point> {
  const box = await page.locator('.post-player-cloud').boundingBox();
  if (!box) throw new Error('The actual cloud is not rendered.');
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function begin(page: Page, touch: CDPSession | undefined, point: Point): Promise<void> {
  if (touch) {
    await touch.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ ...point, id: 1 }],
    });
  } else {
    await page.mouse.move(point.x, point.y);
    await page.mouse.down();
  }
}

async function move(page: Page, touch: CDPSession | undefined, point: Point): Promise<void> {
  if (touch) {
    await touch.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ ...point, id: 1 }],
    });
  } else await page.mouse.move(point.x, point.y);
}

async function end(page: Page, touch: CDPSession | undefined): Promise<void> {
  if (touch) await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  else await page.mouse.up();
}

async function dragStar(page: Page, touch: CDPSession | undefined, index: number): Promise<void> {
  const start = await cloudCenter(page);
  const box = await page
    .getByRole('button', { name: `收集第${index}颗星光`, exact: true })
    .boundingBox();
  if (!box) throw new Error(`Star ${index} is not rendered.`);
  const destination = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await begin(page, touch, start);
  for (let step = 1; step <= 8; step++) {
    await move(page, touch, {
      x: start.x + ((destination.x - start.x) * step) / 8,
      y: start.y + ((destination.y - start.y) * step) / 8,
    });
  }
  await end(page, touch);
  if (index === 6) {
    await expect(page.getByRole('status', { name: '星光收集状态' })).toContainText(
      '星光已收集完成',
    );
  } else {
    await expect(page.getByRole('status', { name: '星光数量' })).toHaveText(`${index} / 6 颗星光`, {
      timeout: 3_000,
    });
  }
}

test('连续独立拖拽：每次松开后重新抓云，六次手势完成三站', async ({ page, isMobile }, testInfo) => {
  await page.getByRole('button', { name: '开始收集星光', exact: true }).click();
  const touch = isMobile ? await page.context().newCDPSession(page) : undefined;
  try {
    await dragStar(page, touch, 1);
    const point = await cloudCenter(page);
    const hit = await page.evaluate(({ x, y }) => {
      const element = document.elementFromPoint(x, y);
      const star = element?.closest<HTMLButtonElement>('[data-post-star]');
      return {
        tag: element?.tagName,
        cloud: Boolean(element?.closest('.post-player-cloud')),
        star: star?.dataset.postStar ?? null,
        disabled: star?.disabled ?? false,
      };
    }, point);
    await testInfo.attach('hit-target-after-first-release', {
      body: JSON.stringify(hit),
      contentType: 'application/json',
    });
    await page.screenshot({ path: testInfo.outputPath('after-first-release.png') });
    for (let index = 2; index <= 6; index++) await dragStar(page, touch, index);
  } finally {
    if (touch) await touch.detach();
  }
});

test('取消或失去捕获后重试：新手势仍可独立收集三颗', async ({ page, isMobile }) => {
  await page.getByRole('button', { name: '开始收集星光', exact: true }).click();
  const touch = isMobile ? await page.context().newCDPSession(page) : undefined;
  const field = page.getByRole('group', { name: '拖动云朵收集星光', exact: true });
  try {
    const box = await field.boundingBox();
    if (!box) throw new Error('The star field is not rendered.');
    const start = await cloudCenter(page);
    const safe = { x: box.x + box.width * 0.5, y: box.y + box.height * 0.84 };
    await page.evaluate(() => {
      document.addEventListener(
        'pointerdown',
        (event) => {
          (globalThis as typeof globalThis & { __dragPointer?: number }).__dragPointer =
            event.pointerId;
        },
        { capture: true, once: true },
      );
    });
    await begin(page, touch, start);
    await move(page, touch, safe);
    if (touch) {
      await touch.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
    } else {
      await field.evaluate((element) => {
        const id = (globalThis as typeof globalThis & { __dragPointer?: number }).__dragPointer;
        if (id === undefined || !element.hasPointerCapture(id))
          throw new Error('The actual mouse never acquired pointer capture.');
        element.releasePointerCapture(id);
      });
      await move(page, undefined, { x: safe.x + 2, y: safe.y });
      await end(page, undefined);
    }
    await expect(page.getByRole('status', { name: '星光数量' })).toHaveText('0 / 6 颗星光');
    for (let index = 1; index <= 3; index++) await dragStar(page, touch, index);
  } finally {
    if (touch) await touch.detach();
  }
});

test('全部独立拖拽完成后重新游玩，第二轮仍可再次抓取云朵', async ({ page, isMobile }) => {
  const touch = isMobile ? await page.context().newCDPSession(page) : undefined;
  try {
    for (let round = 0; round < 2; round++) {
      await page.getByRole('button', { name: '开始收集星光', exact: true }).click();
      for (let index = 1; index <= 6; index++) await dragStar(page, touch, index);
      await expect(page.getByRole('status', { name: '祝福保存状态' })).toContainText(
        '星光已留在本机',
      );
      if (round === 0) {
        await page.getByRole('button', { name: '重新寄一封', exact: true }).click();
        await expect(page.getByRole('status', { name: '星光收集状态' })).toContainText(
          '准备收集星光',
        );
      }
    }
  } finally {
    if (touch) await touch.detach();
  }
});

test('同一次按住跨三站：吃星重渲染后仍保持捕获并继续移动，最后才松开', async ({
  page,
  isMobile,
}) => {
  await page.getByRole('button', { name: '开始收集星光', exact: true }).click();
  const touch = isMobile ? await page.context().newCDPSession(page) : undefined;
  const field = page.getByRole('group', { name: '拖动云朵收集星光', exact: true });
  await page.evaluate(() => {
    document.addEventListener(
      'pointerdown',
      (event) => {
        (globalThis as typeof globalThis & { __heldDragPointer?: number }).__heldDragPointer =
          event.pointerId;
      },
      { capture: true, once: true },
    );
  });
  let from = await cloudCenter(page);
  let released = false;
  try {
    await begin(page, touch, from);
    for (let journey = 0; journey < 6; journey++) {
      const remaining = page.locator('[data-post-star]:not(:disabled)').first();
      const box = await remaining.boundingBox();
      if (!box) throw new Error('A held drag lost the next available star.');
      const to = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      const progress = page.getByRole('status', { name: '星光数量' });
      const before = await progress.textContent();
      for (let step = 1; step <= 8; step++) {
        await move(page, touch, {
          x: from.x + ((to.x - from.x) * step) / 8,
          y: from.y + ((to.y - from.y) * step) / 8,
        });
      }
      from = to;
      const completed = page.getByRole('status', { name: '星光收集状态' });
      if ((await completed.textContent())?.includes('星光已收集完成')) break;
      await expect(progress).not.toHaveText(before ?? '', { timeout: 3_000 });
      expect(
        await field.evaluate((element) => {
          const id = (globalThis as typeof globalThis & { __heldDragPointer?: number })
            .__heldDragPointer;
          return id !== undefined && element.hasPointerCapture(id);
        }),
        'Collecting a star must not cancel the actual held pointer capture.',
      ).toBe(true);
    }
    await expect(page.getByRole('status', { name: '星光收集状态' })).toContainText(
      '星光已收集完成',
    );
    await end(page, touch);
    released = true;
    await expect(page.getByRole('status', { name: '祝福保存状态' })).toContainText(
      '星光已留在本机',
    );
  } finally {
    if (!released) await end(page, touch).catch(() => {});
    if (touch) await touch.detach();
  }
});
