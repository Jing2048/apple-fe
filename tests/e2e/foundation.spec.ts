import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';

const origin = process.env.E2E_BASE_URL ?? 'http://localhost:5173';
async function loadLab(page: Page): Promise<void> {
  await page.goto('/lab');
  await expect(page.getByRole('status', { name: '交互状态' })).toContainText('可以开始');
}
async function completeTiming(page: Page): Promise<void> {
  await page.getByRole('button', { name: '开始验证', exact: true }).click();
  const hit = page.getByRole('button', { name: '记录节奏', exact: true });
  for (let step = 0; step < 3; step++) await hit.click();
  await expect(page.getByRole('status', { name: '交互状态' })).toContainText('本轮完成');
}

test('完整链路：真实数据库就绪、互动完成并取得模拟参与回执', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await loadLab(page);
  const response = page.waitForResponse(
    (r) => r.url().endsWith('/api/participations') && r.status() === 200,
  );
  await completeTiming(page);
  const body = await (await response).json();
  expect(body).toMatchObject({ status: 'recorded', providerMode: 'mock', interaction: 'timing' });
  await expect(page.getByText(body.participationId, { exact: false })).toBeVisible();
  expect(errors).toEqual([]);
});

test('暂停、后台切换与重开保持状态约束', async ({ page }) => {
  await loadLab(page);
  await page.getByRole('button', { name: '开始验证', exact: true }).click();
  await page.getByRole('button', { name: '记录节奏', exact: true }).click();
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  await expect(page.getByRole('status', { name: '交互状态' })).toContainText('已暂停');
  await expect(page.getByRole('button', { name: '记录节奏', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '继续验证', exact: true }).click();
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(page.getByRole('status', { name: '交互状态' })).toContainText('已暂停');
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(page.getByRole('status', { name: '交互状态' })).toContainText('已暂停');
  await page.getByRole('button', { name: '重新开始', exact: true }).click();
  await expect(page.getByRole('status', { name: '交互状态' })).toContainText('可以开始');
});

test('拒绝前不采集；同意后发出契约化事件；撤销后停止采集', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', (request) => {
    if (request.url().endsWith('/api/events')) requests.push(request.postData() ?? '');
  });
  await loadLab(page);
  await page.getByRole('button', { name: '开始验证', exact: true }).click();
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  expect(requests).toEqual([]);
  const ack = page.waitForResponse((r) => r.url().endsWith('/api/events') && r.ok());
  await page.getByRole('button', { name: '同意体验埋点', exact: true }).click();
  await ack;
  expect(requests.length).toBeGreaterThan(0);
  const event = JSON.parse(requests[0] ?? '{}').events[0];
  expect(event).toHaveProperty('eventId');
  expect(event).toHaveProperty('schemaVersion', 1);
  expect(event).not.toHaveProperty('userId');
  await page.getByRole('button', { name: '拒绝体验埋点', exact: true }).click();
  const before = requests.length;
  await page.getByRole('button', { name: '继续验证', exact: true }).click();
  await page.getByRole('button', { name: '重新开始', exact: true }).click();
  expect(requests).toHaveLength(before);
});

test('同源契约：并发幂等、事件重复和隐私字段拒绝', async ({ page }) => {
  await loadLab(page);
  const headers = { Origin: origin };
  const payload = { campaignId: 'lab', interaction: 'swipe', idempotencyKey: randomUUID() };
  const responses = await Promise.all(
    Array.from({ length: 5 }, () =>
      page.request.post('/api/participations', { headers, data: payload }),
    ),
  );
  for (const response of responses) expect(response.ok()).toBe(true);
  const bodies = await Promise.all(responses.map((response) => response.json()));
  expect(new Set(bodies.map((body) => body.participationId)).size).toBe(1);
  const event = {
    eventId: randomUUID(),
    eventName: 'page_view',
    schemaVersion: 1,
    campaignId: 'lab',
    releaseId: 'e2e',
    sessionId: randomUUID(),
    clientTime: new Date().toISOString(),
    properties: {},
  };
  const post = (data: unknown) => page.request.post('/api/events', { headers, data });
  expect(await (await post({ events: [event] })).json()).toEqual({ accepted: 1, duplicates: 0 });
  expect(await (await post({ events: [event] })).json()).toEqual({ accepted: 0, duplicates: 1 });
  expect(
    (
      await post({
        events: [{ ...event, eventId: randomUUID(), properties: { email: 'must-not-be-stored' } }],
      })
    ).status(),
  ).toBe(400);
  expect(
    (
      await page.request.post('/api/events', {
        headers: { Origin: 'https://other.invalid' },
        data: { events: [event] },
      })
    ).status(),
  ).toBe(403);
});

test('网络失败后能重试相同操作', async ({ page }) => {
  await loadLab(page);
  const keys: string[] = [];
  let failing = true;
  await page.route('**/api/participations', async (route) => {
    keys.push(route.request().postDataJSON().idempotencyKey);
    if (failing) await route.abort('failed');
    else await route.continue();
  });
  await completeTiming(page);
  const retry = page.getByRole('button', { name: '重试提交', exact: true });
  await expect(retry).toBeVisible();
  failing = false;
  const response = page.waitForResponse((r) => r.url().endsWith('/api/participations') && r.ok());
  await retry.click();
  expect((await (await response).json()).status).toBe('recorded');
  expect(keys.length).toBeGreaterThanOrEqual(2);
  expect(new Set(keys).size).toBe(1);
});

test('浏览器离线时明确等待，联网后使用同一轮次自动提交', async ({ page, context }) => {
  await loadLab(page);
  await expect(page.getByRole('button', { name: '开始验证', exact: true })).toBeEnabled();
  await context.setOffline(true);
  await completeTiming(page);
  await expect(page.getByRole('status', { name: '提交状态' })).toContainText('当前离线');
  const roundId = await page.evaluate(
    () => JSON.parse(sessionStorage.getItem('campaign-lab.completed-round.v1') ?? '{}').roundId,
  );
  expect(roundId).toBeTruthy();
  const request = page.waitForRequest((r) => r.url().endsWith('/api/participations'));
  const response = page.waitForResponse((r) => r.url().endsWith('/api/participations') && r.ok());
  await context.setOffline(false);
  expect((await request).postDataJSON().idempotencyKey).toBe(roundId);
  const receipt = await (await response).json();
  await expect(page.getByText(receipt.participationId, { exact: false })).toBeVisible();
});

test('服务端已提交但响应丢失，刷新后恢复相同回执', async ({ page }) => {
  await loadLab(page);
  let receipt: { participationId: string } | undefined;
  await page.route('**/api/participations', async (route) => {
    const committed = await route.fetch();
    receipt = await committed.json();
    await route.abort('failed');
  });
  await completeTiming(page);
  await expect(page.getByRole('button', { name: '重试提交', exact: true })).toBeVisible();
  expect(receipt?.participationId).toBeTruthy();
  await page.unroute('**/api/participations');
  const recovered = page.waitForResponse((r) => r.url().endsWith('/api/participations') && r.ok());
  await page.reload();
  expect((await (await recovered).json()).participationId).toBe(receipt?.participationId);
  await expect(page.getByRole('status', { name: '交互状态' })).toContainText('本轮完成');
});

test('键盘替代与减少动态效果可以完成滑动探针', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await loadLab(page);
  await page.getByRole('button', { name: /^滑动收集/ }).click();
  await page.getByRole('button', { name: '开始验证', exact: true }).click();
  const collect = page.getByRole('button', { name: /^完成一次滑动/ });
  for (let step = 0; step < 3; step++) {
    await collect.focus();
    await page.keyboard.press('Enter');
  }
  await expect(page.getByRole('status', { name: '交互状态' })).toContainText('本轮完成');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  expect(overflow).toBe(false);
});

test('快速指针划过能够收集采样点之间的目标', async ({ page }) => {
  await loadLab(page);
  await page.getByRole('button', { name: /^滑动收集/ }).click();
  await page.getByRole('button', { name: '开始验证', exact: true }).click();
  const cells = page.locator('[data-cell]');
  const first = await cells.nth(0).boundingBox();
  const last = await cells.nth(2).boundingBox();
  expect(first).not.toBeNull();
  expect(last).not.toBeNull();
  if (!first || !last) throw new Error('Pointer targets are not rendered.');
  await page.mouse.move(first.x + first.width / 2, first.y + first.height / 2);
  await page.mouse.down();
  // A single move crosses the middle target without an event at its center.
  await page.mouse.move(last.x + last.width / 2, last.y + last.height / 2, { steps: 1 });
  await page.mouse.up();
  await expect(page.getByRole('status', { name: '交互状态' })).toContainText('本轮完成');
});

test('后续就绪检查失败时，不将缓存成功当作当前就绪', async ({ page }) => {
  test.setTimeout(35_000);
  await loadLab(page);
  const start = page.getByRole('button', { name: '开始验证', exact: true });
  await expect(start).toBeEnabled();
  await page.route('**/api/ready', async (route) => {
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({
        error: { code: 'NOT_READY', message: 'test outage', requestId: 'test' },
      }),
    });
  });
  await expect(start).toBeDisabled({ timeout: 23_000 });
  await expect(
    page.getByRole('region', { name: '基础服务状态' }).getByText('未就绪'),
  ).toBeVisible();
});

test('关键资源真实加载失败会阻止开始，并能重试恢复', async ({ page }) => {
  let failing = true;
  await page.route(/\/assets\/lab-marker\.[a-f0-9]{12}\.svg$/, async (route) => {
    if (failing) await route.fulfill({ status: 404, body: 'missing' });
    else await route.continue();
  });
  await page.goto('/lab');
  await expect(page.getByRole('status', { name: '交互状态' })).toContainText('配置加载失败');
  await expect(page.getByRole('button', { name: '开始验证', exact: true })).toHaveCount(0);
  failing = false;
  await page.getByRole('button', { name: '重试加载', exact: true }).click();
  await expect(page.getByRole('status', { name: '交互状态' })).toContainText('可以开始');
  const decoded = await page
    .locator('img')
    .evaluateAll((images) => images.every((image) => (image as HTMLImageElement).naturalWidth > 0));
  expect(decoded).toBe(true);
});
