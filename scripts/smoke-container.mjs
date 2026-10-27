import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import process from 'node:process';
import { URL } from 'node:url';
import { log } from 'node:console';
import { randomUUID } from 'node:crypto';

const origin = process.env.SMOKE_ORIGIN ?? 'http://localhost:8080';
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
const browser = await chromium.launch(executablePath ? { executablePath } : {});
await mkdir('.artifacts', { recursive: true });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const response = await page.goto(origin + '/lab');
  expect(response?.status()).toBe(200);
  expect(response?.headers()['cache-control']).toContain('no-store');
  await expect(page.getByRole('status', { name: '交互状态' })).toContainText('可以开始');
  const ready = await (await page.request.get(`${origin}/api/ready`)).json();
  expect(ready).toMatchObject({ status: 'ready', providerMode: 'mock' });
  await expect(page.getByText(`web · ${ready.releaseId}`, { exact: true })).toBeVisible();
  const image = page.locator('img');
  expect(await image.evaluate((element) => element.naturalWidth)).toBeGreaterThan(0);

  const eventRequest = page.waitForRequest((r) => r.url().endsWith('/api/events'));
  const eventAck = page.waitForResponse((r) => r.url().endsWith('/api/events') && r.ok());
  await page.getByRole('button', { name: '同意体验埋点', exact: true }).click();
  const events = (await eventRequest).postDataJSON().events;
  expect(events.every((event) => event.releaseId === ready.releaseId)).toBe(true);
  expect((await (await eventAck).json()).accepted).toBeGreaterThan(0);
  const receiptResponse = page.waitForResponse(
    (r) => r.url().endsWith('/api/participations') && r.ok(),
  );
  await page.getByRole('button', { name: '开始验证', exact: true }).click();
  for (let step = 0; step < 3; step++)
    await page.getByRole('button', { name: '记录节奏', exact: true }).click();
  const receipt = await (await receiptResponse).json();
  expect(receipt).toMatchObject({ status: 'recorded', providerMode: 'mock' });
  await expect(page.getByText(receipt.participationId, { exact: false })).toBeVisible();
  const verificationPath = `/api/lab/verification/${receipt.participationId}`;
  const readBack = page.waitForResponse((r) => r.url().endsWith(verificationPath) && r.ok());
  await page.getByRole('button', { name: '核验数据库记录', exact: true }).click();
  const database = await (await readBack).json();
  expect(database.receipt).toEqual(receipt);
  expect(database.eventSummary.roundTotal).toBe(2);
  expect(database.eventSummary.byName).toEqual([
    { eventName: 'interaction_completed', count: 1 },
    { eventName: 'interaction_started', count: 1 },
  ]);
  expect(database.eventSummary.sessionTotal).toBe(3);
  await expect(page.getByRole('status', { name: '数据库核验状态' })).toContainText(
    '已从数据库读回',
  );
  const repeated = page.waitForResponse((r) => r.url().endsWith('/api/participations') && r.ok());
  await page.getByRole('button', { name: '重发本轮请求', exact: true }).click();
  expect(await (await repeated).json()).toEqual(receipt);
  expect((await page.request.get(`${origin}/api/campaigns/not-configured`)).status()).toBe(404);
  expect(
    (
      await page.request.post(`${origin}/api/participations`, {
        headers: { Origin: origin },
        data: { campaignId: 'not-configured', interaction: 'timing', idempotencyKey: randomUUID() },
      })
    ).status(),
  ).toBe(404);
  expect(
    (
      await page.request.post(`${origin}/api/events`, {
        headers: { Origin: origin },
        data: { events: [{ ...events[0], eventId: randomUUID(), campaignId: 'not-configured' }] },
      })
    ).status(),
  ).toBe(404);
  await page.screenshot({ path: '.artifacts/container-desktop.png', fullPage: true });

  const script = await page.locator('script[src]').first().getAttribute('src');
  expect(script).toMatch(/^\/assets\/.+\.js$/);
  const asset = await page.request.get(new URL(script, origin).href);
  expect(asset.status()).toBe(200);
  expect(asset.headers()['cache-control']).toContain('immutable');
  const map = await page.request.get(new URL(`${script}.map`, origin).href);
  expect(map.status()).toBe(404);
  expect(map.headers()['cache-control']).not.toContain('immutable');
  const missing = await page.request.get(`${origin}/assets/does-not-exist.js`);
  expect(missing.status()).toBe(404);
  expect(missing.headers()['cache-control']).not.toContain('immutable');
  expect(errors).toEqual([]);

  const mobile = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const mobilePage = await mobile.newPage();
  expect((await mobile.request.get(origin + verificationPath)).status()).toBe(401);
  await mobilePage.goto(origin + '/lab');
  await expect(mobilePage.getByRole('status', { name: '交互状态' })).toContainText('可以开始');
  expect((await mobile.request.get(origin + verificationPath)).status()).toBe(404);
  expect(
    await mobilePage.evaluate(
      () => globalThis.document.documentElement.scrollWidth > globalThis.innerWidth,
    ),
  ).toBe(false);
  await mobilePage.screenshot({ path: '.artifacts/container-mobile.png', fullPage: true });
  const evidence = {
    checkedAt: new Date().toISOString(),
    origin,
    browser: browser.version(),
    releaseId: ready.releaseId,
    receipt,
    database,
    checks: [
      'CSP image decode',
      'release and event correlation',
      'event persistence ACK',
      'participation receipt',
      'HTML no-store',
      'hashed JS immutable',
      'source map blocked',
      'missing asset 404',
      'mobile layout',
      'no page errors',
      'independent PostgreSQL receipt read-back',
      'round-scoped persisted event counts',
      'same-key replay receipt equality',
      'signed-session read-back isolation',
      'unregistered campaign reads and writes rejected',
    ],
    limitations: [
      'Chromium mobile emulation is not real Safari or WeChat.',
      'External integration remains mock.',
    ],
  };
  await writeFile('.artifacts/container-smoke.json', JSON.stringify(evidence, null, 2) + '\n');
  log(
    `Container functional smoke passed: ${evidence.checks.length} checks, release ${ready.releaseId}.`,
  );
  await mobile.close();
  await context.close();
} finally {
  await browser.close();
}
