import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import type { ParticipationResponse, VerificationResponse } from '@apple/contracts';

const origin = process.env.E2E_BASE_URL ?? 'http://localhost:5173';
const verificationPath = (id: string) => `/api/lab/verification/${id}`;

async function openLab(page: Page): Promise<void> {
  await page.goto('/lab');
  await expect(page.getByRole('status', { name: '交互状态' })).toContainText('可以开始');
  await expect(page.getByRole('button', { name: '开始验证', exact: true })).toBeEnabled();
}
async function complete(
  page: Page,
  interaction: 'timing' | 'swipe' = 'timing',
): Promise<ParticipationResponse> {
  if (interaction === 'swipe') await page.getByRole('button', { name: /^滑动收集/ }).click();
  const recorded = page.waitForResponse((r) => r.url().endsWith('/api/participations') && r.ok());
  await page.getByRole('button', { name: '开始验证', exact: true }).click();
  for (let index = 0; index < 3; index++)
    await page
      .getByRole('button', { name: interaction === 'timing' ? /^记录节奏$/ : /^完成一次滑动/ })
      .click();
  return (await recorded).json() as Promise<ParticipationResponse>;
}
async function verify(page: Page, id: string): Promise<VerificationResponse> {
  const read = page.waitForResponse((r) => r.url().endsWith(verificationPath(id)) && r.ok());
  await page.getByRole('button', { name: '核验数据库记录', exact: true }).click();
  const facts = (await (await read).json()) as VerificationResponse;
  await expect(page.getByRole('status', { name: '数据库核验状态' })).toContainText(
    '已从数据库读回',
  );
  return facts;
}

for (const interaction of ['timing', 'swipe'] as const) {
  test(`手动链路 ${interaction}：同意、互动、真实读回本轮事件、重复提交回执不变`, async ({
    page,
  }) => {
    await openLab(page);
    await page.getByRole('button', { name: '同意体验埋点', exact: true }).click();
    const receipt = await complete(page, interaction);
    const facts = await verify(page, receipt.participationId);
    expect(facts.receipt).toEqual(receipt);
    expect(Date.parse(facts.checkedAt)).toBeGreaterThan(0);
    expect(facts.eventSummary.roundTotal).toBe(2);
    expect(facts.eventSummary.byName).toEqual([
      { eventName: 'interaction_completed', count: 1 },
      { eventName: 'interaction_started', count: 1 },
    ]);
    expect(facts.eventSummary.sessionTotal).toBeGreaterThanOrEqual(3);
    expect(Object.keys(facts).sort()).toEqual(['checkedAt', 'eventSummary', 'receipt', 'roundId']);
    const replay = page.waitForResponse((r) => r.url().endsWith('/api/participations') && r.ok());
    await page.getByRole('button', { name: '重发本轮请求', exact: true }).click();
    expect(await (await replay).json()).toEqual(receipt);
    const repeated = await verify(page, receipt.participationId);
    expect(repeated.receipt).toEqual(receipt);
    expect(repeated.eventSummary.roundTotal).toBe(2);
  });
}

test('数据库核验离线时明确等待，联网后读回真实结果', async ({ page, context }) => {
  await openLab(page);
  const receipt = await complete(page);
  await context.setOffline(true);
  const button = page.getByRole('button', { name: '核验数据库记录', exact: true });
  await button.click();
  await expect(page.getByRole('status', { name: '数据库核验状态' })).toContainText('当前离线');
  await expect(button).toBeDisabled();
  const read = page.waitForResponse(
    (r) => r.url().endsWith(verificationPath(receipt.participationId)) && r.ok(),
  );
  await context.setOffline(false);
  expect((await (await read).json()).receipt).toEqual(receipt);
  await expect(page.getByRole('status', { name: '数据库核验状态' })).toContainText(
    '已从数据库读回',
  );
});

test('拒绝埋点仍可完成与读回，不将零事件伪报为失败或已送达', async ({ page }) => {
  await openLab(page);
  await page.getByRole('button', { name: '拒绝体验埋点', exact: true }).click();
  const receipt = await complete(page);
  const facts = await verify(page, receipt.participationId);
  expect(facts.receipt.participationId).toBe(receipt.participationId);
  expect(facts.eventSummary).toEqual({ sessionTotal: 0, roundTotal: 0, byName: [] });
});

test('事件接口失败时，数据库核验仍展示实际零记录并提示待确认', async ({ page }) => {
  await openLab(page);
  await page.route('**/api/events', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({
        error: { code: 'NOT_READY', message: 'test outage', requestId: 'test' },
      }),
    }),
  );
  await page.getByRole('button', { name: '同意体验埋点', exact: true }).click();
  const receipt = await complete(page);
  const facts = await verify(page, receipt.participationId);
  expect(facts.eventSummary.roundTotal).toBe(0);
  await expect(page.getByRole('status', { name: '数据库核验状态' })).toContainText(/待确认|未确认/);
});

test('签名会话隔离：另一浏览器知道回执与客户端标识仍不能读取或污染本轮', async ({
  page,
  browser,
}) => {
  await openLab(page);
  const observedEvents: { sessionId: string }[] = [];
  page.on('request', (request) => {
    if (request.url().endsWith('/api/events'))
      observedEvents.push(...request.postDataJSON().events);
  });
  await page.getByRole('button', { name: '同意体验埋点', exact: true }).click();
  const receipt = await complete(page);
  const facts = await verify(page, receipt.participationId);
  const other = await browser.newContext();
  try {
    expect(
      (await other.request.get(origin + verificationPath(receipt.participationId))).status(),
    ).toBe(401);
    await other.request.get(origin + '/api/campaigns/lab');
    const forbidden = await other.request.get(origin + verificationPath(receipt.participationId));
    expect(forbidden.status()).toBe(404);
    expect(await forbidden.text()).not.toContain(receipt.participationId);
    const clientSession = observedEvents[0]?.sessionId;
    expect(clientSession).toBeTruthy();
    const injected = await other.request.post(origin + '/api/events', {
      headers: { Origin: origin },
      data: {
        events: [
          {
            eventId: randomUUID(),
            eventName: 'interaction_completed',
            schemaVersion: 1,
            campaignId: 'lab',
            releaseId: 'e2e',
            sessionId: clientSession,
            clientTime: new Date().toISOString(),
            properties: { roundId: facts.roundId, interaction: 'timing' },
          },
        ],
      },
    });
    expect(injected.status()).toBe(200);
    const checked = (await (
      await page.request.get(verificationPath(receipt.participationId))
    ).json()) as VerificationResponse;
    expect(checked.eventSummary).toEqual(facts.eventSummary);
  } finally {
    await other.close();
  }
});

test('重开后迟到的数据库读回不得显示为新一轮结果', async ({ page }) => {
  await openLab(page);
  const receipt = await complete(page);
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started: (() => void) | undefined;
  const requested = new Promise<void>((resolve) => {
    started = resolve;
  });
  await page.route(`**${verificationPath(receipt.participationId)}`, async (route) => {
    const response = await route.fetch();
    started?.();
    await gate;
    await route.fulfill({ response }).catch(() => undefined);
  });
  await page.getByRole('button', { name: '核验数据库记录', exact: true }).click();
  await requested;
  await page.getByRole('button', { name: '重新开始', exact: true }).click();
  release?.();
  await expect(page.getByRole('status', { name: '交互状态' })).toContainText('可以开始');
  await expect(page.getByRole('status', { name: '数据库核验状态' })).toHaveCount(0);
  await expect(page.getByText(receipt.participationId, { exact: false })).toHaveCount(0);
});
