import { test as base, expect, type Locator, type Page } from '@playwright/test';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const artifactPath = resolve('.artifacts/offline/cloud-post-offline.html');
const auxiliaryBase = process.env.OFFLINE_TEST_BASE_URL;
if (auxiliaryBase) {
  const url = new URL(auxiliaryBase);
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('HTTP auxiliary acceptance requires an explicit loopback HTTP origin.');
}
const screenshotDirectory = auxiliaryBase ? '.artifacts/offline-http' : '.artifacts/offline';
const recordKey = 'cloud-post.offline.v1.records';
const draftKey = 'cloud-post.offline.v1.draft';
const blessingButtons = ['寄给慢慢来的你', '寄给值得好运的你', '寄给认真生活的你'];
const state = (page: Page) => page.getByRole('status', { name: '星光收集状态', exact: true });
const saved = (page: Page) => page.getByRole('status', { name: '祝福保存状态', exact: true });
const count = (page: Page) => page.getByRole('status', { name: '本机记录数量', exact: true });

const test = base.extend<{ storageDenied: boolean; relocatedArtifact: boolean }>({
  storageDenied: [false, { option: true }],
  relocatedArtifact: [false, { option: true }],
  page: async ({ page, context, storageDenied, relocatedArtifact }, use) => {
    let temporaryDirectory: string | undefined;
    let target = artifactPath;
    if (relocatedArtifact) {
      temporaryDirectory = await mkdtemp(join(tmpdir(), 'cloud-post-offline-'));
      target = join(temporaryDirectory, '云朵邮局 单文件演示.html');
      await copyFile(artifactPath, target);
    }
    const artifactUrl = auxiliaryBase
      ? new URL('cloud-post-offline.html', `${auxiliaryBase.replace(/\/$/, '')}/`).href
      : pathToFileURL(target).href;
    const transportAttempts: string[] = [];
    const unexpectedRequests: { protocol: string; type: string }[] = [];
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    context.on('request', (request) => {
      const url = new URL(request.url());
      url.hash = '';
      const permitted =
        url.href === artifactUrl &&
        request.isNavigationRequest() &&
        request.frame() === page.mainFrame();
      if (!permitted)
        unexpectedRequests.push({ protocol: url.protocol, type: request.resourceType() });
    });
    await context.exposeBinding('__offlineTransportAttempt', (_source, transport: string) => {
      transportAttempts.push(transport);
    });
    await context.addInitScript(() => {
      const scope = globalThis as typeof globalThis & {
        __offlineTransportAttempt: (transport: string) => Promise<void>;
      };
      const report = (transport: string) => {
        void scope.__offlineTransportAttempt(transport).catch(() => {});
      };
      Object.defineProperty(globalThis, 'fetch', {
        configurable: true,
        value: () => {
          report('fetch');
          return Promise.reject(new Error('The single-file artifact attempted fetch.'));
        },
      });
      for (const name of ['XMLHttpRequest', 'WebSocket']) {
        Object.defineProperty(globalThis, name, {
          configurable: true,
          value: function blockedTransport() {
            report(name);
            throw new Error(`The single-file artifact attempted ${name}.`);
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
    if (storageDenied) {
      await context.addInitScript(() => {
        for (const name of ['localStorage', 'sessionStorage', 'indexedDB', 'caches']) {
          Object.defineProperty(globalThis, name, {
            configurable: true,
            get() {
              throw new DOMException('Storage is denied by the offline test.', 'SecurityError');
            },
          });
        }
        Object.defineProperty(navigator, 'storage', {
          configurable: true,
          get() {
            throw new DOMException('Storage is denied by the offline test.', 'SecurityError');
          },
        });
      });
    }
    try {
      // First prove startup never tries the network even when it is available.
      await context.setOffline(false);
      await page.goto(artifactUrl);
      await expect(state(page)).toContainText('准备收集星光');
      await context.setOffline(true);
      await reloadArtifact(page);
      await expect(state(page)).toContainText('准备收集星光');
      await expect(page.getByText('离线演示', { exact: true })).toBeVisible();
      expect(await page.evaluate(() => navigator.onLine)).toBe(false);
      await use(page);
    } finally {
      try {
        expect(transportAttempts, 'No fetch/XHR/beacon/WebSocket attempt is allowed.').toEqual([]);
        expect(unexpectedRequests, 'Only the main HTML file navigation is allowed.').toEqual([]);
        expect(pageErrors, 'The actual offline browser must have no page errors.').toEqual([]);
      } finally {
        if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
      }
    }
  },
});

async function reloadArtifact(page: Page): Promise<void> {
  // HTTP is an explicitly labelled auxiliary mode. Only document navigation
  // is temporarily online; all runtime transports remain blocked and checked.
  if (auxiliaryBase) await page.context().setOffline(false);
  try {
    await page.reload();
  } finally {
    await page.context().setOffline(true);
  }
  expect(await page.evaluate(() => navigator.onLine)).toBe(false);
}

async function activate(locator: Locator, mobile: boolean): Promise<void> {
  if (mobile) await locator.tap();
  else await locator.click();
}

async function start(page: Page, mobile: boolean): Promise<void> {
  await activate(page.getByRole('button', { name: '开始收集星光', exact: true }), mobile);
  await expect(state(page)).toContainText('正在收集星光');
}

async function collect(page: Page, mobile: boolean, first = 1, last = 6): Promise<void> {
  for (let index = first; index <= last; index++) {
    await activate(page.getByRole('button', { name: `收集第${index}颗星光`, exact: true }), mobile);
  }
}

async function expectRecords(page: Page, total: number): Promise<void> {
  await openRecords(page);
  await expect(count(page)).toHaveText(new RegExp(`^\\s*${total}\\s*封星光\\s*$`));
}

async function openRecords(page: Page): Promise<Locator> {
  const region = page.getByRole('region', { name: '本机记录', exact: true });
  if (!(await region.isVisible())) {
    await page.getByRole('button', { name: '查看本机记录', exact: true }).click();
  }
  await expect(region).toBeVisible();
  return region;
}

async function expectLocalSave(page: Page): Promise<void> {
  await expect(state(page)).toContainText('星光已收集完成');
  await expect(saved(page)).toContainText('星光已留在本机');
  await expect(saved(page)).not.toContainText(/这封星光已保存|已从数据库读回|服务器已保存/);
  await expect(page.getByRole('button', { name: '核验数据库记录', exact: true })).toHaveCount(0);
}

test('单文件三站六星、三张祝福、重复游玩两条本机记录与三态截图', async ({ page, isMobile }) => {
  const variant = isMobile ? 'mobile' : 'desktop';
  await mkdir(screenshotDirectory, { recursive: true });
  await page.screenshot({ path: `${screenshotDirectory}/${variant}-first.png` });
  await expectRecords(page, 0);
  await start(page, isMobile);
  await collect(page, isMobile, 1, 2);
  await expect(page.getByRole('status', { name: '星光数量' })).toHaveText('2 / 6 颗星光');
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await page.screenshot({ path: `${screenshotDirectory}/${variant}-playing.png` });
  await collect(page, isMobile, 3, 6);
  await expectLocalSave(page);
  await expectRecords(page, 1);
  const titles: string[] = [];
  for (const name of blessingButtons) {
    const choice = page.getByRole('button', { name, exact: true });
    await activate(choice, isMobile);
    await expect(choice).toHaveAttribute('aria-pressed', 'true');
    titles.push(
      (await page
        .getByRole('article', { name: '星光祝福卡' })
        .getByRole('heading')
        .textContent()) ?? '',
    );
    await expectRecords(page, 1);
  }
  expect(new Set(titles).size).toBe(3);
  expect(titles.every((title) => title.length > 0)).toBe(true);
  await page.screenshot({ path: `${screenshotDirectory}/${variant}-complete.png` });
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await activate(page.getByRole('button', { name: '重新寄一封', exact: true }), isMobile);
  await expect(state(page)).toContainText('准备收集星光');
  await start(page, isMobile);
  await collect(page, isMobile);
  await expectLocalSave(page);
  await expectRecords(page, 2);
  const records = await openRecords(page);
  await expect(records.getByRole('listitem')).toHaveCount(2);
});

test('三颗后刷新恢复为暂停，完成和所选祝福刷新后保留且不重复记录', async ({ page, isMobile }) => {
  await start(page, isMobile);
  await collect(page, isMobile, 1, 3);
  await reloadArtifact(page);
  await expect(state(page)).toContainText('星光收集已暂停');
  await expect(page.getByRole('status', { name: '星光数量' })).toHaveText('3 / 6 颗星光');
  await expect(page.getByRole('button', { name: '收集第4颗星光', exact: true })).toBeDisabled();
  await activate(page.getByRole('button', { name: '继续收集', exact: true }), isMobile);
  await collect(page, isMobile, 4, 6);
  await expectLocalSave(page);
  await activate(page.getByRole('button', { name: blessingButtons[1]!, exact: true }), isMobile);
  await reloadArtifact(page);
  await expectLocalSave(page);
  await expect(
    page.getByRole('button', { name: blessingButtons[1]!, exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await expectRecords(page, 1);
  await expect((await openRecords(page)).getByRole('listitem')).toHaveCount(1);
});

test('清除仅本机离线记录及旧草稿，不清空其它存储且刷新不恢复旧回合', async ({ page, isMobile }) => {
  await start(page, isMobile);
  await collect(page, isMobile);
  await expectLocalSave(page);
  const oldRound = await page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key) ?? '{}').roundId as string,
    draftKey,
  );
  expect(oldRound).toMatch(/^[a-f0-9-]{36}$/);
  await page.evaluate(() => {
    localStorage.setItem('campaign-cloud-post.round.v1', 'offline-test-online-draft-sentinel');
    localStorage.setItem('offline-test.external-preference', 'keep-this-test-value');
  });
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: '清除本机记录', exact: true }).click();
  await expect(state(page)).toContainText('准备收集星光');
  await expectRecords(page, 0);
  await reloadArtifact(page);
  await expect(state(page)).toContainText('准备收集星光');
  await expectRecords(page, 0);
  const values = await page.evaluate(
    ({ recordKey, draftKey }) => {
      const draft = JSON.parse(localStorage.getItem(draftKey) ?? 'null') as {
        roundId?: string;
        collected?: number[];
      } | null;
      return {
        recordNamespaceExists: localStorage.getItem(recordKey) !== null,
        roundId: draft?.roundId ?? null,
        collected: draft?.collected ?? [],
        onlineSentinel: localStorage.getItem('campaign-cloud-post.round.v1'),
        unrelatedSentinel: localStorage.getItem('offline-test.external-preference'),
      };
    },
    { recordKey, draftKey },
  );
  expect(values.roundId).not.toBe(oldRound);
  expect(values.collected).toEqual([]);
  expect(values.onlineSentinel).toBe('offline-test-online-draft-sentinel');
  expect(values.unrelatedSentinel).toBe('keep-this-test-value');
  await expect((await openRecords(page)).getByRole('listitem')).toHaveCount(0);
});

test('键盘与减少动态效果可完成，暂停恢复遵守当前六星状态', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.getByRole('button', { name: '开始收集星光', exact: true }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: '收集第1颗星光', exact: true }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: '暂停收集', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(state(page)).toContainText('星光收集已暂停');
  await page.getByRole('button', { name: '继续收集', exact: true }).focus();
  await page.keyboard.press('Enter');
  for (let index = 2; index <= 6; index++) {
    await page.getByRole('button', { name: `收集第${index}颗星光`, exact: true }).focus();
    await page.keyboard.press('Enter');
  }
  await expectLocalSave(page);
  await expectRecords(page, 1);
});

test('已写入后删除被拒绝：清空当前列表且不从旧完成草稿立即重建', async ({
  page,
  context,
  isMobile,
}) => {
  await context.addInitScript(() => {
    const scope = globalThis as typeof globalThis & { __offlineRejectRemoval?: boolean };
    const original = Storage.prototype.removeItem;
    Storage.prototype.removeItem = function (this: Storage, key: string) {
      if (
        scope.__offlineRejectRemoval &&
        ['cloud-post.offline.v1.records', 'cloud-post.offline.v1.draft'].includes(key)
      )
        throw new DOMException('Test storage deletion was denied.', 'SecurityError');
      return original.call(this, key);
    };
  });
  await reloadArtifact(page);
  await expect(state(page)).toContainText('准备收集星光');
  await start(page, isMobile);
  await collect(page, isMobile);
  await expectLocalSave(page);
  await expectRecords(page, 1);
  await page.evaluate(() => {
    (
      globalThis as typeof globalThis & { __offlineRejectRemoval?: boolean }
    ).__offlineRejectRemoval = true;
  });
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: '清除本机记录', exact: true }).click();
  await expect(state(page)).toContainText('准备收集星光');
  await expectRecords(page, 0);
  await expect((await openRecords(page)).getByRole('listitem')).toHaveCount(0);
  await expect(page.getByRole('status', { name: '记录清除状态' })).toContainText(
    '无法确认旧的持久记录已清除',
  );
  await expect(saved(page)).toHaveCount(0);
});

test('实际鼠标或触控滑动可收集当前组，随后轻点完成且无横向溢出', async ({
  page,
  context,
  isMobile,
}) => {
  await start(page, isMobile);
  const cloud = await page.locator('.post-player-cloud').boundingBox();
  const first = await page
    .getByRole('button', { name: '收集第1颗星光', exact: true })
    .boundingBox();
  const second = await page
    .getByRole('button', { name: '收集第2颗星光', exact: true })
    .boundingBox();
  if (!cloud || !first || !second)
    throw new Error('The actual offline star field is not rendered.');
  const points = [cloud, first, first, second].map((box) => ({
    x: box.x + box.width / 2,
    y: box.y + box.height / 2,
  }));
  if (isMobile) {
    const touch = await context.newCDPSession(page);
    try {
      for (const [index, point] of points.entries()) {
        await touch.send('Input.dispatchTouchEvent', {
          type: index === 0 ? 'touchStart' : 'touchMove',
          touchPoints: [{ ...point, id: 1 }],
        });
      }
      await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } finally {
      await touch.detach();
    }
  } else {
    await page.mouse.move(points[0]!.x, points[0]!.y);
    await page.mouse.down();
    for (const point of points.slice(1)) await page.mouse.move(point.x, point.y);
    await page.mouse.up();
  }
  await expect(page.getByRole('status', { name: '星光数量' })).toHaveText('2 / 6 颗星光');
  await collect(page, isMobile, 3, 6);
  await expectLocalSave(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
});

test.describe('全部浏览器存储拒绝', () => {
  test.use({ storageDenied: true });
  test('仍可玩和重复游玩，明确仅本次内存，重新打开不声称持久保存', async ({ page, isMobile }) => {
    await start(page, isMobile);
    await collect(page, isMobile);
    await expect(saved(page)).toContainText('星光暂存在这次打开中');
    await expect(saved(page)).not.toContainText('星光已留在本机');
    await expectRecords(page, 1);
    await activate(page.getByRole('button', { name: '重新寄一封', exact: true }), isMobile);
    await start(page, isMobile);
    await collect(page, isMobile);
    await expect(saved(page)).toContainText('星光暂存在这次打开中');
    await expectRecords(page, 2);
    await expect((await openRecords(page)).getByRole('listitem')).toHaveCount(2);
    await reloadArtifact(page);
    await expect(state(page)).toContainText('准备收集星光');
    await expectRecords(page, 0);
  });
});

test.describe('复制唯一 HTML 后双击', () => {
  test.skip(
    Boolean(auxiliaryBase),
    'Managed Chromium blocks file://; HTTP cannot validate relocation.',
  );
  test.use({ relocatedArtifact: true });
  test('中文空格文件名且无任何相邻资源仍可完整游玩', async ({ page, isMobile }) => {
    expect(decodeURI(page.url())).toContain('云朵邮局 单文件演示.html');
    await start(page, isMobile);
    await collect(page, isMobile);
    await expectLocalSave(page);
    await expectRecords(page, 1);
  });
});
