import { expect, test, type Page } from '@playwright/test';
import type { ParticipationResponse, VerificationResponse } from '@apple/contracts';

const saved = (page: Page) => page.getByRole('status', { name: '祝福保存状态' });

async function openPost(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByRole('status', { name: '星光收集状态' })).toContainText('准备收集星光');
  await expect(page.getByRole('button', { name: '开始收集星光', exact: true })).toBeEnabled();
}
async function startPost(page: Page): Promise<void> {
  await page.getByRole('button', { name: '开始收集星光', exact: true }).click();
}
async function collect(page: Page, from = 1, to = 6): Promise<void> {
  for (let index = from; index <= to; index++) {
    await page.getByRole('button', { name: `收集第${index}颗星光`, exact: true }).click();
  }
}

test('可玩星光旅程：真实保存、祝福仅本机、折叠区独立核验', async ({ page }) => {
  const requests: string[] = [];
  const participations: unknown[] = [];
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (request.method() === 'POST') requests.push(request.postData() ?? '');
    if (request.url().endsWith('/api/participations')) participations.push(request.postDataJSON());
  });
  await openPost(page);
  await page.getByRole('button', { name: '同意体验统计', exact: true }).click();
  await startPost(page);
  const response = page.waitForResponse((r) => r.url().endsWith('/api/participations') && r.ok());
  await collect(page);
  const receipt = (await (await response).json()) as ParticipationResponse;
  expect(receipt).toMatchObject({
    campaignId: 'cloud-post',
    interaction: 'swipe',
    status: 'recorded',
  });
  await expect(saved(page)).toContainText('这封星光已保存');
  await expect(page.getByRole('article', { name: '星光祝福卡' })).toBeVisible();
  for (const name of ['寄给慢慢来的你', '寄给值得好运的你', '寄给认真生活的你']) {
    await page.getByRole('button', { name, exact: true }).click();
  }
  expect(participations).toHaveLength(1);
  await page.getByText('验收记录', { exact: true }).click();
  const verification = page.waitForResponse(
    (r) => r.url().endsWith(`/api/lab/verification/${receipt.participationId}`) && r.ok(),
  );
  await page.getByRole('button', { name: '核验数据库记录', exact: true }).click();
  const facts = (await (await verification).json()) as VerificationResponse;
  expect(facts.receipt).toEqual(receipt);
  expect(facts.eventSummary.roundTotal).toBe(2);
  await expect(page.getByRole('status', { name: '邮局数据库核验状态' })).toContainText(
    '已从数据库读回',
  );
  for (const payload of requests) {
    expect(payload).not.toContain('愿你');
    expect(payload).not.toContain('你的步调');
    expect(payload).not.toContain('寄给');
  }
  expect(errors).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
});

test('三颗星后刷新保留进度并暂停，继续后恰好六颗完成', async ({ page }) => {
  await openPost(page);
  await startPost(page);
  await collect(page, 1, 3);
  await page.reload();
  await expect(page.getByRole('status', { name: '星光收集状态' })).toContainText('星光收集已暂停');
  await expect(page.getByRole('button', { name: '收集第4颗星光', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '继续收集', exact: true }).click();
  const response = page.waitForResponse((r) => r.url().endsWith('/api/participations') && r.ok());
  await collect(page, 4, 6);
  expect((await (await response).json()).campaignId).toBe('cloud-post');
  await expect(saved(page)).toContainText('这封星光已保存');
});

test('响应丢失后刷新用同一封信恢复，不重复创建参与记录', async ({ page }) => {
  await openPost(page);
  await startPost(page);
  let committed: ParticipationResponse | undefined;
  const keys: string[] = [];
  await page.route('**/api/participations', async (route) => {
    keys.push(route.request().postDataJSON().idempotencyKey);
    committed = (await (await route.fetch()).json()) as ParticipationResponse;
    await route.abort('failed');
  });
  await collect(page);
  await expect(page.getByRole('button', { name: '重试保存祝福', exact: true })).toBeVisible();
  await expect(saved(page)).not.toContainText('这封星光已保存');
  expect(committed?.participationId).toBeTruthy();
  await page.unroute('**/api/participations');
  const restored = page.waitForResponse((r) => r.url().endsWith('/api/participations') && r.ok());
  page.on('request', (request) => {
    if (request.url().endsWith('/api/participations'))
      keys.push(request.postDataJSON().idempotencyKey);
  });
  await page.reload();
  expect((await (await restored).json()).participationId).toBe(committed?.participationId);
  expect(new Set(keys).size).toBe(1);
  await expect(saved(page)).toContainText('这封星光已保存');
});

test('离线完成保留本机祝福，联网后才显示保存成功', async ({ page, context }) => {
  await openPost(page);
  await startPost(page);
  await collect(page, 1, 3);
  await context.setOffline(true);
  await collect(page, 4, 6);
  await expect(saved(page)).toContainText('当前离线');
  await expect(saved(page)).not.toContainText('这封星光已保存');
  const response = page.waitForResponse((r) => r.url().endsWith('/api/participations') && r.ok());
  await context.setOffline(false);
  expect((await (await response).json()).campaignId).toBe('cloud-post');
  await expect(saved(page)).toContainText('这封星光已保存');
});

test('键盘与减少动态效果、后台暂停和重新寄信均可用', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openPost(page);
  await startPost(page);
  await page.getByRole('button', { name: '收集第1颗星光', exact: true }).focus();
  await page.keyboard.press('Enter');
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(page.getByRole('status', { name: '星光收集状态' })).toContainText('星光收集已暂停');
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(page.getByRole('status', { name: '星光收集状态' })).toContainText('星光收集已暂停');
  await page.getByRole('button', { name: '继续收集', exact: true }).click();
  for (let index = 2; index <= 6; index++) {
    await page.getByRole('button', { name: `收集第${index}颗星光`, exact: true }).focus();
    await page.keyboard.press('Enter');
  }
  await expect(saved(page)).toContainText('这封星光已保存');
  await page.getByRole('button', { name: '重新寄一封', exact: true }).click();
  await expect(page.getByRole('status', { name: '星光收集状态' })).toContainText('准备收集星光');
  await startPost(page);
  await expect(page.getByRole('status', { name: '星光数量' })).toHaveText('0 / 6 颗星光');
});

test('加载失败给出友好重试，默认不发送体验统计', async ({ page }) => {
  let fail = true;
  const events: string[] = [];
  page.on('request', (request) => {
    if (request.url().endsWith('/api/events')) events.push(request.url());
  });
  await page.route('**/api/campaigns/cloud-post', (route) =>
    fail
      ? route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: '{"error":{"code":"NOT_READY","message":"test","requestId":"test"}}',
        })
      : route.continue(),
  );
  await page.goto('/');
  await expect(page.getByRole('button', { name: '重新打开邮局', exact: true })).toBeVisible();
  fail = false;
  await page.getByRole('button', { name: '重新打开邮局', exact: true }).click();
  await expect(page.getByRole('button', { name: '开始收集星光', exact: true })).toBeEnabled();
  await startPost(page);
  await collect(page);
  await expect(saved(page)).toContainText('这封星光已保存');
  expect(events).toEqual([]);
});

test('快速滑动收集当前组，重复经过不会重复计数', async ({ page, isMobile }) => {
  await openPost(page);
  await startPost(page);
  const field = page.getByRole('group', { name: '拖动云朵收集星光', exact: true });
  const bounds = await field.boundingBox();
  const first = await page
    .getByRole('button', { name: '收集第1颗星光', exact: true })
    .boundingBox();
  const second = await page
    .getByRole('button', { name: '收集第2颗星光', exact: true })
    .boundingBox();
  if (!bounds || !first || !second) throw new Error('The star field is not rendered');
  const points = [
    { x: bounds.x + bounds.width * 0.5, y: bounds.y + bounds.height * 0.75 },
    { x: first.x + first.width / 2, y: first.y + first.height / 2 },
    { x: first.x + first.width / 2, y: first.y + first.height / 2 },
    { x: second.x + second.width / 2, y: second.y + second.height / 2 },
  ];
  if (isMobile) {
    const touch = await page.context().newCDPSession(page);
    for (const [index, point] of points.entries()) {
      await touch.send('Input.dispatchTouchEvent', {
        type: index === 0 ? 'touchStart' : 'touchMove',
        touchPoints: [{ ...point, id: 1 }],
      });
    }
    await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await touch.detach();
  } else {
    const start = points[0]!;
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    for (const point of points.slice(1)) await page.mouse.move(point.x, point.y, { steps: 1 });
    await page.mouse.up();
  }
  await expect(page.getByRole('status', { name: '星光数量' })).toHaveText('2 / 6 颗星光');
});
