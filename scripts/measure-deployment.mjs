import { chromium, expect } from '@playwright/test';
import { request } from 'node:http';
import { Buffer } from 'node:buffer';
import { gunzipSync } from 'node:zlib';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { platform, arch } from 'node:os';
import process from 'node:process';
import { URL } from 'node:url';
import { log } from 'node:console';

const origin = process.env.SMOKE_ORIGIN ?? 'http://localhost:8080';
const label = process.env.PERF_LABEL ?? 'baseline';
const pagePath = process.env.PERF_PAGE_PATH ?? '/lab';
if (!['/', '/lab'].includes(pagePath)) throw new Error('Unknown local measurement page');
const isPost = pagePath === '/';
const measuredCampaign = isPost ? 'cloud-post' : 'lab';
if (!/^[a-z0-9-]{1,40}$/.test(label)) throw new Error('Invalid measurement label');
if (!['localhost', '127.0.0.1'].includes(new URL(origin).hostname))
  throw new Error('This measurement is limited to the local lab deployment.');
await mkdir('.artifacts', { recursive: true });

function summary(values) {
  const ordered = [...values].sort((a, b) => a - b);
  const percentile = (p) => ordered[Math.max(0, Math.ceil(ordered.length * p) - 1)];
  return {
    samples: ordered.length,
    min: ordered[0],
    p50: percentile(0.5),
    p75: percentile(0.75),
    p95: percentile(0.95),
    max: ordered.at(-1),
  };
}
function wireAsset(url, encoding) {
  return new Promise((resolve, reject) => {
    const req = request(url, { headers: { 'Accept-Encoding': encoding } }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => {
        const wire = Buffer.concat(chunks);
        try {
          if (res.statusCode !== 200) throw new Error('Asset request failed');
          const decoded = res.headers['content-encoding'] === 'gzip' ? gunzipSync(wire) : wire;
          resolve({
            encoding: res.headers['content-encoding'] ?? 'identity',
            wireBytes: wire.length,
            decodedBytes: decoded.length,
            sha256: createHash('sha256').update(decoded).digest('hex'),
            cacheControl: res.headers['cache-control'],
            vary: res.headers.vary ?? null,
          });
        } catch (error) {
          reject(error);
        }
      });
    });
    req.setTimeout(10_000, () => req.destroy(new Error('Asset request timed out')));
    req.on('error', reject);
    req.end();
  });
}

const ready = await (await globalThis.fetch(origin + '/api/ready')).json();
expect(ready).toMatchObject({ status: 'ready', providerMode: 'mock' });
const browser = await chromium.launch(
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
    ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
    : {},
);
const browserSamples = [];
const apiSamples = [];
let entryScript;
try {
  for (const [device, viewport] of [
    ['desktop', { width: 1440, height: 1000 }],
    ['mobile-emulation', { width: 390, height: 844 }],
  ]) {
    for (let sample = 0; sample < 3; sample++) {
      const context = await browser.newContext({
        viewport,
        isMobile: device !== 'desktop',
        hasTouch: device !== 'desktop',
      });
      const page = await context.newPage();
      await page.goto(origin + pagePath, { waitUntil: 'load' });
      await expect(
        page.getByRole('status', { name: isPost ? '星光收集状态' : '交互状态' }),
      ).toContainText(isPost ? '准备收集星光' : '可以开始');
      await expect(
        page.getByRole('button', { name: isPost ? '开始收集星光' : '开始验证', exact: true }),
      ).toBeEnabled();
      const readyAtMs = await page.evaluate(() => globalThis.performance.now());
      entryScript ??= await page.locator('script[src]').first().getAttribute('src');
      const measureClick = async (button) => {
        await page.evaluate(() => {
          globalThis.__labPaint = new Promise((resolve) =>
            globalThis.document.addEventListener(
              'click',
              () => {
                const before = globalThis.performance.now();
                globalThis.requestAnimationFrame(() =>
                  globalThis.requestAnimationFrame(() =>
                    resolve(globalThis.performance.now() - before),
                  ),
                );
              },
              { once: true, capture: true },
            ),
          );
        });
        await button.click();
        return page.evaluate(() => globalThis.__labPaint);
      };
      const startClickToSecondFrameMs = await measureClick(
        page.getByRole('button', { name: isPost ? '开始收集星光' : '开始验证', exact: true }),
      );
      const inputClickToSecondFrameMs = await measureClick(
        page.getByRole('button', { name: isPost ? '收集第1颗星光' : '记录节奏', exact: true }),
      );
      const resourceSizes = await page.evaluate(() =>
        globalThis.performance.getEntriesByType('resource').map((entry) => ({
          encodedBodySize: entry.encodedBodySize,
          decodedBodySize: entry.decodedBodySize,
        })),
      );
      browserSamples.push({
        device,
        viewport,
        sample,
        readyAtMs,
        startClickToSecondFrameMs,
        inputClickToSecondFrameMs,
        encodedResourceBytes: resourceSizes.reduce((sum, r) => sum + r.encodedBodySize, 0),
        decodedResourceBytes: resourceSizes.reduce((sum, r) => sum + r.decodedBodySize, 0),
      });
      await context.close();
    }
  }
  for (const path of ['/api/health', '/api/ready']) {
    for (const concurrency of [1, 5]) {
      const timings = [];
      for (let offset = 0; offset < 10; offset += concurrency) {
        const batch = await Promise.all(
          Array.from({ length: concurrency }, async () => {
            const before = performance.now();
            const response = await globalThis.fetch(origin + path);
            expect(response.status).toBe(200);
            await response.arrayBuffer();
            return performance.now() - before;
          }),
        );
        timings.push(...batch);
      }
      apiSamples.push({ path, concurrency, elapsedMs: summary(timings), rawMs: timings });
    }
  }
  const handshake = await globalThis.fetch(origin + '/api/campaigns/' + measuredCampaign);
  expect(handshake.status).toBe(200);
  const cookie = handshake.headers.getSetCookie()[0]?.split(';')[0];
  if (!cookie) throw new Error('The local measurement session could not be established');
  for (const concurrency of [1, 5]) {
    const writeTimings = [];
    const readTimings = [];
    for (let offset = 0; offset < 5; offset += concurrency) {
      const batch = await Promise.all(
        Array.from({ length: concurrency }, async () => {
          const beforeWrite = performance.now();
          const response = await globalThis.fetch(origin + '/api/participations', {
            method: 'POST',
            headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              campaignId: measuredCampaign,
              interaction: isPost ? 'swipe' : 'timing',
              idempotencyKey: randomUUID(),
            }),
          });
          expect(response.status).toBe(200);
          const receipt = await response.json();
          const writeMs = performance.now() - beforeWrite;
          const beforeRead = performance.now();
          const read = await globalThis.fetch(
            origin + `/api/lab/verification/${receipt.participationId}`,
            { headers: { Cookie: cookie } },
          );
          expect(read.status).toBe(200);
          expect((await read.json()).receipt.participationId).toBe(receipt.participationId);
          return { writeMs, readMs: performance.now() - beforeRead };
        }),
      );
      writeTimings.push(...batch.map((item) => item.writeMs));
      readTimings.push(...batch.map((item) => item.readMs));
    }
    apiSamples.push({
      path: 'POST /api/participations (new row)',
      concurrency,
      elapsedMs: summary(writeTimings),
      rawMs: writeTimings,
    });
    apiSamples.push({
      path: 'GET /api/lab/verification/:receipt',
      concurrency,
      elapsedMs: summary(readTimings),
      rawMs: readTimings,
    });
  }
  if (!entryScript) throw new Error('Built entry script was not found');
  const assetUrl = new URL(entryScript, origin).href;
  const identity = await wireAsset(assetUrl, 'identity');
  const compressed = await wireAsset(assetUrl, 'gzip');
  expect(identity.sha256).toBe(compressed.sha256);
  const safeRead = (path) =>
    readFile(path, 'utf8')
      .then((s) => s.trim())
      .catch(() => 'unavailable');
  const report = {
    measuredAt: new Date().toISOString(),
    label,
    pagePath,
    measuredCampaign,
    origin,
    releaseId: ready.releaseId,
    conditions: {
      platform: platform(),
      architecture: arch(),
      browser: browser.version(),
      network: 'same-host loopback through Nginx',
      cpuQuota: await safeRead('/sys/fs/cgroup/cpu.max'),
      memoryLimitBytes: await safeRead('/sys/fs/cgroup/memory.max'),
      browserCache: 'new isolated context for every navigation',
      networkOrCpuThrottling: false,
    },
    browserSamples,
    browserSummary: Object.fromEntries(
      ['desktop', 'mobile-emulation'].map((device) => {
        const items = browserSamples.filter((s) => s.device === device);
        return [
          device,
          {
            observedReadyMs: summary(items.map((s) => s.readyAtMs)),
            startClickToSecondFrameMs: summary(items.map((s) => s.startClickToSecondFrameMs)),
            inputClickToSecondFrameMs: summary(items.map((s) => s.inputClickToSecondFrameMs)),
          },
        ];
      }),
    ),
    apiSamples,
    entryAsset: { path: entryScript, identity, gzipRequested: compressed },
    limitations: [
      'Small descriptive lab sample, not production capacity or an SLA.',
      'Click-to-second-frame is not INP.',
      'Observed ready timing includes automation observation overhead.',
      'Mobile emulation is not a phone, Safari or WeChat.',
      'No WAN latency, CPU throttling, or real-user p75 measured.',
    ],
  };
  await writeFile(
    `.artifacts/deployment-performance-${label}.json`,
    JSON.stringify(report, null, 2) + '\n',
  );
  log(
    JSON.stringify(
      {
        label,
        browserSummary: report.browserSummary,
        apiSamples: apiSamples.map(({ path, concurrency, elapsedMs }) => ({
          path,
          concurrency,
          elapsedMs,
        })),
        entryAsset: report.entryAsset,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
