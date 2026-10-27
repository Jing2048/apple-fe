import { mkdir } from 'node:fs/promises';
import type { Locator, Page } from '@playwright/test';
import { test, expect, grantMedia, mediaCounts, reloadLantern } from './fixture.js';

const phases = {
  wish: '写下心愿',
  unfold: '拉开纸灯',
  decorate: '装饰纸灯',
  launch: '准备放飞',
  flying: '心愿正在升起',
  keepsake: '心愿已放上天',
} as const;
const card = (page: Page) => page.getByRole('article', { name: '新年心愿纪念卡' });
const camera = (page: Page) => page.getByRole('status', { name: '相机状态' });
const cameraVideo = (page: Page) => page.getByLabel('纸灯实景画面', { exact: true });
const wish = '愿每一份心意，都被温柔接住。';

async function openCameraPanel(page: Page): Promise<void> {
  const summary = page.locator('summary').filter({ hasText: '相机实景（可选）' });
  if (!(await summary.evaluate((element) => element.parentElement!.hasAttribute('open'))))
    await summary.click();
  await expect(page.getByRole('button', { name: '开启相机实景', exact: true })).toBeEnabled();
}

async function phase(page: Page, value: keyof typeof phases): Promise<void> {
  await expect(page.locator('[data-lantern-phase]')).toHaveAttribute('data-lantern-phase', value);
  await expect(page.getByRole('status', { name: '纸灯制作状态' })).toContainText(phases[value]);
}

async function activate(locator: Locator, mobile: boolean): Promise<void> {
  if (mobile) await locator.tap();
  else await locator.click();
}

async function setWish(page: Page, mobile: boolean, text = wish): Promise<void> {
  await phase(page, 'wish');
  await page.getByRole('textbox', { name: '新年心愿' }).fill(text);
  await activate(page.getByRole('button', { name: '写下这个心愿', exact: true }), mobile);
  await phase(page, 'unfold');
}

async function readyToFly(page: Page, mobile: boolean, text = wish): Promise<void> {
  await setWish(page, mobile, text);
  await activate(page.getByRole('button', { name: '展开纸灯', exact: true }), mobile);
  await activate(page.getByRole('button', { name: '开始装饰', exact: true }), mobile);
  await phase(page, 'decorate');
  await activate(page.getByRole('button', { name: '准备放飞', exact: true }), mobile);
  await phase(page, 'launch');
}

async function openProgress(page: Page): Promise<number> {
  return Number(await page.locator('[data-open-progress]').getAttribute('data-open-progress'));
}

/** Real browser input: desktop capture loss or native CDP touchCancel on cancel. */
async function pull(
  page: Page,
  mobile: boolean,
  name: '向上拉开纸灯' | '向上轻推放飞纸灯',
  distance: number,
  cancel = false,
): Promise<void> {
  const handle = page.getByRole('button', { name, exact: true });
  await handle.evaluate((element) =>
    element.scrollIntoView({ block: 'center', behavior: 'instant' }),
  );
  const box = await handle.boundingBox();
  if (!box) throw new Error('The real HTML gesture handle is not rendered.');
  const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const finish = { x: start.x, y: start.y - distance };
  expect(finish.y).toBeGreaterThan(0);
  await handle.evaluate((element) => {
    element.addEventListener(
      'pointerdown',
      (event) => {
        (globalThis as typeof globalThis & { __lanternPointerId?: number }).__lanternPointerId = (
          event as PointerEvent
        ).pointerId;
      },
      { capture: true, once: true },
    );
  });
  const touch = mobile ? await page.context().newCDPSession(page) : undefined;
  try {
    if (touch) {
      await touch.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ ...start, id: 1 }],
      });
    } else {
      await page.mouse.move(start.x, start.y);
      await page.mouse.down();
    }
    for (let step = 1; step <= 8; step++) {
      const point = { x: start.x, y: start.y - (distance * step) / 8 };
      if (touch)
        await touch.send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: [{ ...point, id: 1 }],
        });
      else await page.mouse.move(point.x, point.y);
    }
    if (touch) {
      await touch.send('Input.dispatchTouchEvent', {
        type: cancel ? 'touchCancel' : 'touchEnd',
        touchPoints: [],
      });
    } else {
      if (cancel) {
        await handle.evaluate((element) => {
          const id = (globalThis as typeof globalThis & { __lanternPointerId?: number })
            .__lanternPointerId;
          if (id === undefined || !element.hasPointerCapture(id))
            throw new Error('The actual mouse did not acquire pointer capture.');
          element.releasePointerCapture(id);
        });
        await page.mouse.move(finish.x + 1, finish.y);
      }
      await page.mouse.up();
    }
  } finally {
    if (touch) await touch.detach();
  }
}

async function records(page: Page, total: number): Promise<void> {
  const summary = page.locator('summary').filter({ hasText: '留在本机的灯' });
  if (!(await summary.evaluate((element) => element.parentElement!.hasAttribute('open'))))
    await summary.click();
  await expect(page.getByRole('status', { name: '本机纸灯数量' })).toHaveText(`${total} 盏纸灯`);
  if (total)
    await expect(
      page.getByRole('list', { name: '本机纸灯记录' }).getByRole('listitem'),
    ).toHaveCount(total);
}

async function saved(page: Page): Promise<void> {
  await phase(page, 'keepsake');
  await expect(card(page)).toBeVisible();
  await expect(page.getByRole('status', { name: '纸灯保存状态' })).toContainText(
    '纪念卡已留在本机',
  );
}

async function flyByButton(page: Page, mobile: boolean): Promise<void> {
  await activate(page.getByRole('button', { name: '放飞心愿', exact: true }), mobile);
  await phase(page, 'flying');
  await expect(card(page)).toHaveCount(0);
  await saved(page);
}

test('真实三段拉开含取消续拉、全部纸色纹样、轻推放飞和关键状态截图', async ({ page, isMobile }) => {
  const prefix = `.artifacts/lantern/${isMobile ? 'mobile' : 'desktop'}`;
  await mkdir('.artifacts/lantern', { recursive: true });
  await phase(page, 'wish');
  expect((await mediaCounts(page)).requests).toBe(0);
  await page.screenshot({ path: `${prefix}-wish.png`, fullPage: true });
  await setWish(page, isMobile);
  await expect(page.getByRole('button', { name: '开始装饰', exact: true })).toBeDisabled();
  await pull(page, isMobile, '向上拉开纸灯', 60);
  expect(await openProgress(page)).toBeCloseTo(1 / 3, 2);
  await pull(page, isMobile, '向上拉开纸灯', 60, true);
  expect(await openProgress(page)).toBeCloseTo(2 / 3, 2);
  await phase(page, 'unfold');
  await page.screenshot({ path: `${prefix}-partial.png`, fullPage: true });
  await pull(page, isMobile, '向上拉开纸灯', 60);
  expect(await openProgress(page)).toBe(1);
  await phase(page, 'unfold');
  await activate(page.getByRole('button', { name: '开始装饰', exact: true }), isMobile);
  for (const name of ['朱砂红', '暖杏', '米白', '花开', '窗花', '涟漪']) {
    const button = page.getByRole('button', { name, exact: true });
    await activate(button, isMobile);
    await expect(button).toHaveAttribute('aria-pressed', 'true');
  }
  await page.screenshot({ path: `${prefix}-decorate.png`, fullPage: true });
  await activate(page.getByRole('button', { name: '准备放飞', exact: true }), isMobile);
  await pull(page, isMobile, '向上轻推放飞纸灯', 90);
  await phase(page, 'flying');
  await expect(card(page)).toHaveCount(0);
  await page.screenshot({ path: `${prefix}-flying.png`, fullPage: true });
  await saved(page);
  await expect(card(page).locator('blockquote')).toHaveText(wish);
  await expect(card(page)).toContainText('米白 · 涟漪');
  await page.screenshot({ path: `${prefix}-keepsake.png`, fullPage: true });
  await records(page, 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
});

test('全键盘四次拉环与放飞可完成，重制后新一盏不会覆盖前卡', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.getByRole('button', { name: '平安常在', exact: true }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: '写下这个心愿', exact: true }).focus();
  await page.keyboard.press('Enter');
  for (let step = 1; step <= 4; step++) {
    await page.getByRole('button', { name: '向上拉开纸灯', exact: true }).focus();
    await page.keyboard.press('Enter');
    expect(await openProgress(page)).toBe(step / 4);
  }
  for (const name of ['开始装饰', '暖杏', '窗花', '准备放飞', '放飞心愿']) {
    await page.getByRole('button', { name, exact: true }).focus();
    await page.keyboard.press('Enter');
  }
  await saved(page);
  await records(page, 1);
  await page.getByRole('button', { name: '再做一盏', exact: true }).focus();
  await page.keyboard.press('Enter');
  await phase(page, 'wish');
  await readyToFly(page, false, '愿热爱，照亮新的日常。');
  await flyByButton(page, false);
  await records(page, 2);
});

test('超过放飞阈值但取消不会生成卡，随后真实重新轻推可放飞', async ({ page, isMobile }) => {
  await readyToFly(page, isMobile);
  await pull(page, isMobile, '向上轻推放飞纸灯', 100, true);
  await phase(page, 'launch');
  await expect(card(page)).toHaveCount(0);
  await records(page, 0);
  await page.waitForTimeout(2_400);
  await phase(page, 'launch');
  await records(page, 0);
  await pull(page, isMobile, '向上轻推放飞纸灯', 90);
  await saved(page);
  await records(page, 1);
});

test('半展开和flying可恢复，卡片刷新幂等；清除不碰其它主题记录', async ({ page, isMobile }) => {
  await setWish(page, isMobile);
  await pull(page, isMobile, '向上拉开纸灯', 60);
  await reloadLantern(page);
  await phase(page, 'unfold');
  expect(await openProgress(page)).toBeCloseTo(1 / 3, 2);
  await activate(page.getByRole('button', { name: '展开纸灯', exact: true }), isMobile);
  await activate(page.getByRole('button', { name: '开始装饰', exact: true }), isMobile);
  await activate(page.getByRole('button', { name: '准备放飞', exact: true }), isMobile);
  await activate(page.getByRole('button', { name: '放飞心愿', exact: true }), isMobile);
  await phase(page, 'flying');
  await reloadLantern(page);
  await saved(page);
  await records(page, 1);
  const ids = await page.evaluate(() => {
    const cards = JSON.parse(localStorage.getItem('paper-lantern.offline.v1.cards') ?? '{}')
      .cards as {
      id: string;
    }[];
    return cards.map((card) => card.id);
  });
  expect(ids).toHaveLength(1);
  await reloadLantern(page);
  await saved(page);
  await records(page, 1);
  expect(
    await page.evaluate(() => {
      const cards = JSON.parse(localStorage.getItem('paper-lantern.offline.v1.cards') ?? '{}')
        .cards as { id: string }[];
      return cards.map((card) => card.id);
    }),
  ).toEqual(ids);
  await page.evaluate(() => {
    for (const key of ['cloud-post.offline.v1.records', 'cloud-post.offline.new-year.v1.draft'])
      localStorage.setItem(key, 'lantern-test-unrelated-sentinel');
  });
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: '清除本机记录', exact: true }).click();
  await phase(page, 'wish');
  await records(page, 0);
  await reloadLantern(page);
  await phase(page, 'wish');
  await records(page, 0);
  expect(
    await page.evaluate(() =>
      ['cloud-post.offline.v1.records', 'cloud-post.offline.new-year.v1.draft'].map((key) =>
        localStorage.getItem(key),
      ),
    ),
  ).toEqual(['lantern-test-unrelated-sentinel', 'lantern-test-unrelated-sentinel']);
});

test('32按Unicode码点限制，HTML样式心愿作为文字安全显示', async ({ page, isMobile }) => {
  const field = page.getByRole('textbox', { name: '新年心愿' });
  await field.fill('🧧'.repeat(33));
  expect(Array.from(await field.inputValue())).toHaveLength(32);
  expect(await field.inputValue()).toBe('🧧'.repeat(32));
  const injection = '<svg onload=alert(1)>';
  const dialogs: string[] = [];
  page.on('dialog', (dialog) => {
    dialogs.push(dialog.type());
    void dialog.dismiss();
  });
  await readyToFly(page, isMobile, injection);
  await flyByButton(page, isMobile);
  await expect(card(page).locator('blockquote')).toHaveText(injection);
  await expect(card(page).locator('blockquote svg, blockquote script, blockquote img')).toHaveCount(
    0,
  );
  expect(dialogs).toEqual([]);
});

test('合成相机实际播放、关闭停轨，重新开启后完成纸灯自动关闭', async ({ page, isMobile }) => {
  await readyToFly(page, isMobile);
  expect((await mediaCounts(page)).requests).toBe(0);
  await openCameraPanel(page);
  await page.getByRole('button', { name: '开启相机实景', exact: true }).click();
  await expect(camera(page)).toHaveAttribute('data-camera-state', 'active');
  await expect
    .poll(() =>
      cameraVideo(page).evaluate((element: HTMLVideoElement) =>
        Boolean(element.srcObject && element.videoWidth > 0 && !element.paused),
      ),
    )
    .toBe(true);
  if (!isMobile) {
    await mkdir('.artifacts/lantern', { recursive: true });
    await page.screenshot({ path: '.artifacts/lantern/camera-synthetic.png', fullPage: true });
  }
  await page.getByRole('button', { name: '关闭相机', exact: true }).click();
  await expect.poll(async () => (await mediaCounts(page)).live).toBe(0);
  expect(
    await cameraVideo(page).evaluate((element: HTMLVideoElement) => element.srcObject),
  ).toBeNull();
  await page.getByRole('button', { name: '开启相机实景', exact: true }).click();
  await expect(camera(page)).toHaveAttribute('data-camera-state', 'active');
  await page.locator('summary').filter({ hasText: '相机实景（可选）' }).click();
  await expect.poll(async () => (await mediaCounts(page)).live).toBe(0);
  await openCameraPanel(page);
  await page.getByRole('button', { name: '开启相机实景', exact: true }).click();
  await expect(camera(page)).toHaveAttribute('data-camera-state', 'active');
  await pull(page, isMobile, '向上轻推放飞纸灯', 90);
  await phase(page, 'flying');
  await expect(card(page)).toHaveCount(0);
  await saved(page);
  await expect.poll(async () => (await mediaCounts(page)).live).toBe(0);
  expect((await mediaCounts(page)).tracks).toBe(3);
  expect((await mediaCounts(page)).ended).toBe(3);
});

test.describe('合成权限拒绝', () => {
  test.use({ mediaPermission: 'denied' });
  test('拒绝后仍可完整放飞，不自动请求真实设备', async ({ page, isMobile }) => {
    await readyToFly(page, isMobile);
    await openCameraPanel(page);
    await page.getByRole('button', { name: '开启相机实景', exact: true }).click();
    await expect(camera(page)).toHaveAttribute('data-camera-state', 'fallback');
    await expect(camera(page)).toContainText('没有获得相机权限');
    await flyByButton(page, isMobile);
    expect((await mediaCounts(page)).requests).toBe(1);
    expect((await mediaCounts(page)).tracks).toBe(0);
  });
});

test.describe('合成迟到授权', () => {
  test.use({ mediaPermission: 'deferred' });
  test('取消后迟到流被停止，普通轻推玩法仍可继续', async ({ page, isMobile }) => {
    await readyToFly(page, isMobile);
    await openCameraPanel(page);
    await page.getByRole('button', { name: '开启相机实景', exact: true }).click();
    await expect(camera(page)).toHaveAttribute('data-camera-state', 'requesting');
    await page.getByRole('button', { name: '取消相机开启', exact: true }).click();
    await grantMedia(page);
    await expect.poll(async () => (await mediaCounts(page)).ended).toBe(1);
    expect((await mediaCounts(page)).live).toBe(0);
    await expect(camera(page)).toHaveAttribute('data-camera-state', 'idle');
    await pull(page, isMobile, '向上轻推放飞纸灯', 90);
    await saved(page);
  });
});
