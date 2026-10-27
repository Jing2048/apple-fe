import { chromium, expect } from '@playwright/test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { Buffer } from 'node:buffer';
import { spawn, spawnSync } from 'node:child_process';
import { log } from 'node:console';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { clearInterval, setInterval } from 'node:timers';
import { setTimeout as delay } from 'node:timers/promises';
import { URL } from 'node:url';

const origin = new URL(process.env.DEMO_ORIGIN ?? 'http://localhost:8080');
ok(['http:', 'https:'].includes(origin.protocol), 'DEMO_ORIGIN must use HTTP(S).');
ok(!origin.username && !origin.password, 'Do not put credentials in DEMO_ORIGIN.');
strictEqual(origin.pathname, '/', 'DEMO_ORIGIN must be an origin without a path.');
ok(!origin.search && !origin.hash, 'DEMO_ORIGIN must not contain query parameters.');
const ffmpeg = process.env.FFMPEG_PATH ?? 'ffmpeg';
const ffprobe = process.env.FFPROBE_PATH ?? 'ffprobe';
const outputDirectory = '.artifacts';
const reportPath = `${outputDirectory}/cloud-post-capture.json`;

for (const binary of [ffmpeg, ffprobe]) {
  const check = spawnSync(binary, ['-version'], { encoding: 'utf8' });
  strictEqual(check.status, 0, `Required existing executable is unavailable: ${binary}`);
}

/** Sample real CDP JPEG frames at 10 Hz on the actual recording clock. */
async function startRecording(page, path, viewport) {
  const session = await page.context().newCDPSession(page);
  let stderr = '';
  let failure;
  let sourceFrames = 0;
  let encodedFrames = 0;
  let duplicateFrames = 0;
  let lastSourceDigest;
  const distinctSourceFrames = new Set();
  let clock;
  const history = [];
  let firstFrame;
  let resolveFirstFrame;
  const firstFrameReady = new Promise((resolve) => {
    resolveFirstFrame = resolve;
  });
  const encoder = spawn(
    ffmpeg,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'image2pipe',
      '-framerate',
      '10',
      '-vcodec',
      'mjpeg',
      '-i',
      'pipe:0',
      '-an',
      '-vf',
      'scale=trunc(iw/2)*2:trunc(ih/2)*2',
      '-c:v',
      'libvpx-vp9',
      '-deadline',
      'realtime',
      '-cpu-used',
      '6',
      '-crf',
      '32',
      '-b:v',
      '0',
      '-pix_fmt',
      'yuv420p',
      path,
    ],
    { stdio: ['pipe', 'ignore', 'pipe'] },
  );
  encoder.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk.toString()).slice(-8_192);
  });
  encoder.stdin.on('error', (error) => {
    failure ??= error;
  });
  const exited = new Promise((resolve) => {
    encoder.once('error', (error) => resolve({ error }));
    encoder.once('close', (code, signal) => resolve({ code, signal }));
  });

  const onFrame = ({ data, sessionId }) => {
    const jpeg = Buffer.from(data, 'base64');
    const digest = createHash('sha256').update(jpeg).digest('hex');
    sourceFrames += 1;
    distinctSourceFrames.add(digest);
    if (!firstFrame) {
      firstFrame = { jpeg, digest, at: 0 };
      resolveFirstFrame();
    }
    if (clock !== undefined) history.push({ jpeg, digest, at: performance.now() - clock });
    void session.send('Page.screencastFrameAck', { sessionId }).catch((error) => {
      failure ??= error;
    });
  };
  session.on('Page.screencastFrame', onFrame);
  let timer;
  let pumping;
  let stopped = false;

  const pumpTo = async (targetFrames) => {
    while (encodedFrames < targetFrames) {
      if (failure) throw failure;
      const frameTime = encodedFrames * 100;
      while (history.length > 1 && history[1].at <= frameTime) history.shift();
      const frame = history[0];
      if (frame.digest === lastSourceDigest) duplicateFrames += 1;
      lastSourceDigest = frame.digest;
      const acceptsMore = encoder.stdin.write(frame.jpeg);
      encodedFrames += 1;
      if (!acceptsMore) await once(encoder.stdin, 'drain');
    }
  };

  try {
    await session.send('Page.enable');
    await session.send('Page.startScreencast', {
      format: 'jpeg',
      quality: 78,
      maxWidth: viewport.width,
      maxHeight: viewport.height,
      everyNthFrame: 2,
    });
    await Promise.race([
      firstFrameReady,
      delay(5_000, undefined, { ref: false }).then(() => {
        throw new Error('Chromium did not produce an actual screencast frame.');
      }),
    ]);
    clock = performance.now();
    history.push(firstFrame);
    await pumpTo(1);
    timer = setInterval(() => {
      if (pumping || stopped) return;
      const due = Math.floor((performance.now() - clock) / 100) + 1;
      pumping = pumpTo(due)
        .catch((error) => {
          failure ??= error;
        })
        .finally(() => {
          pumping = undefined;
        });
    }, 25);
  } catch (error) {
    encoder.kill('SIGTERM');
    session.off('Page.screencastFrame', onFrame);
    await session.detach().catch(() => {});
    throw error;
  }

  return {
    elapsed: () => performance.now() - clock,
    async stop() {
      if (stopped) throw new Error('The recording was already stopped.');
      stopped = true;
      clearInterval(timer);
      await session.send('Page.stopScreencast');
      session.off('Page.screencastFrame', onFrame);
      try {
        if (pumping) await pumping;
        const elapsedMs = performance.now() - clock;
        await pumpTo(Math.max(encodedFrames, Math.ceil(elapsedMs / 100)));
        encoder.stdin.end();
        const result = await Promise.race([
          exited,
          delay(15_000, undefined, { ref: false }).then(() => {
            encoder.kill('SIGKILL');
            throw new Error('The existing FFmpeg encoder did not finish.');
          }),
        ]);
        if (result.error) throw result.error;
        strictEqual(result.code, 0, `FFmpeg encoding failed: ${stderr}`);
        if (failure) throw failure;
        ok(distinctSourceFrames.size >= 3, 'Insufficient distinct real browser frames.');
        return {
          elapsedMs: Math.round(elapsedMs),
          sourceFrames,
          distinctSourceFrames: distinctSourceFrames.size,
          encodedFrames,
          repeatedFrames: duplicateFrames,
          sampling: '10 fps using real elapsed time; latest actual frame repeats between updates',
        };
      } catch (error) {
        encoder.stdin.destroy();
        encoder.kill('SIGTERM');
        throw error;
      } finally {
        await session.detach().catch(() => {});
      }
    },
  };
}

function inspectVideo(path) {
  const probe = spawnSync(
    ffprobe,
    [
      '-v',
      'error',
      '-count_frames',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=codec_name,width,height,avg_frame_rate,nb_read_frames:format=duration,size',
      '-of',
      'json',
      path,
    ],
    { encoding: 'utf8' },
  );
  strictEqual(probe.status, 0, 'FFprobe could not verify the recorded WebM.');
  const metadata = JSON.parse(probe.stdout);
  const stream = metadata.streams[0];
  const durationSeconds = Number(metadata.format.duration);
  ok(durationSeconds >= 10, 'The actual encoded video must be at least ten seconds.');
  ok(Number(stream.nb_read_frames) >= 100, 'The recorded video has too few decoded frames.');
  ok(['vp8', 'vp9'].includes(stream.codec_name), 'The recording must be encoded as WebM video.');
  return {
    codec: stream.codec_name,
    width: stream.width,
    height: stream.height,
    averageFrameRate: stream.avg_frame_rate,
    decodedFrames: Number(stream.nb_read_frames),
    durationSeconds,
    bytes: Number(metadata.format.size),
    audio: false,
  };
}

async function slowDrag(page, from, to, duration = 900) {
  const steps = 24;
  for (let index = 1; index <= steps; index++) {
    await page.mouse.move(
      from.x + ((to.x - from.x) * index) / steps,
      from.y + ((to.y - from.y) * index) / steps,
    );
    await delay(duration / steps);
  }
}

function center(box) {
  ok(box, 'The actual draggable element is not rendered.');
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function captureExperience(browser, variant) {
  const mobile = variant === 'mobile';
  const viewport = mobile ? { width: 390, height: 844 } : { width: 1280, height: 960 };
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: 1,
    isMobile: mobile,
    hasTouch: mobile,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(12_000);
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  const prefix = `${outputDirectory}/cloud-post-${variant}`;
  const screenshots = {
    first: `${prefix}-first.png`,
    playing: `${prefix}-playing.png`,
    complete: `${prefix}-complete.png`,
  };
  let recorder;
  let recording;
  const actions = [];
  const act = (type, target) => {
    actions.push({ atMs: Math.round(recorder.elapsed()), type, target });
  };
  const activate = (locator) => (mobile ? locator.tap() : locator.click());
  const star = (index) => page.getByRole('button', { name: `收集第${index}颗星光`, exact: true });
  const status = page.getByRole('status', { name: '星光收集状态', exact: true });
  try {
    const response = await page.goto(origin.href);
    strictEqual(response?.status(), 200);
    await expect(status).toContainText('准备收集星光');
    const readyResponse = await page.request.get(new URL('/api/ready', origin).href);
    ok(readyResponse.ok(), 'The real deployed API is not ready.');
    const ready = await readyResponse.json();
    await page.screenshot({ path: screenshots.first });
    recorder = await startRecording(page, `${prefix}.webm`, viewport);
    await delay(1_700);
    await activate(page.getByRole('button', { name: '开始收集星光', exact: true }));
    await expect(status).toContainText('正在收集星光');
    act(mobile ? 'touch-tap' : 'mouse-click', 'start');
    const receiptResult = page
      .waitForResponse(
        (result) => {
          if (!result.url().endsWith('/api/participations') || result.status() !== 200)
            return false;
          return result.request().postDataJSON()?.campaignId === 'cloud-post';
        },
        { timeout: 45_000 },
      )
      .then((result) => result.json())
      .catch((error) => ({ captureError: error.message }));

    if (mobile) {
      for (const index of [1, 2]) {
        await delay(1_200);
        await activate(star(index));
        act('touch-tap', `star-${index}`);
      }
    } else {
      const cloud = center(await page.locator('.post-player-cloud').boundingBox());
      const first = center(await star(1).boundingBox());
      await page.mouse.move(cloud.x, cloud.y);
      await page.mouse.down();
      await delay(350);
      await slowDrag(page, cloud, first);
      await expect(star(1)).toBeDisabled();
      act('mouse-drag', 'cloud-to-star-1; real collection confirmed');
      await delay(450);
      const second = center(await star(2).boundingBox());
      await slowDrag(page, first, second);
      await page.mouse.up();
      await expect(star(3)).toBeVisible();
      act('mouse-drag', 'star-1-to-star-2; next group confirmed');
    }

    await delay(700);
    await expect(status).toContainText('正在收集星光');
    await page.screenshot({ path: screenshots.playing });
    await activate(page.getByRole('button', { name: '暂停收集', exact: true }));
    await expect(status).toContainText('星光收集已暂停');
    act(mobile ? 'touch-tap' : 'mouse-click', 'pause');
    await delay(1_200);
    await activate(page.getByRole('button', { name: '继续收集', exact: true }));
    await expect(status).toContainText('正在收集星光');
    act(mobile ? 'touch-tap' : 'mouse-click', 'resume');

    for (const index of [3, 4, 5, 6]) {
      await delay(1_300);
      await activate(star(index));
      act(mobile ? 'touch-tap' : 'mouse-click', `star-${index}`);
    }
    await expect(status).toContainText('星光已收集完成');
    const receipt = await receiptResult;
    ok(!receipt.captureError, `No real participation ACK: ${receipt.captureError}`);
    strictEqual(receipt.campaignId, 'cloud-post');
    strictEqual(receipt.status, 'recorded');
    strictEqual(receipt.providerMode, 'mock');
    const saved = page.getByRole('status', { name: '祝福保存状态', exact: true });
    await expect(saved).toContainText('这封星光已保存');
    act('server-ack', 'participation receipt and visible saved state confirmed');
    await delay(1_100);
    await page.screenshot({ path: screenshots.complete });

    const details = page.locator('summary').filter({ hasText: '验收记录' });
    if (!(await details.evaluate((element) => element.parentElement.hasAttribute('open')))) {
      await activate(details);
    }
    const readBackPath = `/api/lab/verification/${receipt.participationId}`;
    const readBack = page.waitForResponse(
      (result) => new URL(result.url()).pathname === readBackPath && result.ok(),
    );
    await activate(page.getByRole('button', { name: '核验数据库记录', exact: true }));
    const database = await (await readBack).json();
    deepStrictEqual(database.receipt, receipt);
    act('database-read-back', 'current signed session receipt confirmed');
    await delay(Math.max(0, 20_000 - recorder.elapsed()));
    recording = await recorder.stop();
    recorder = undefined;
    const video = inspectVideo(`${prefix}.webm`);
    strictEqual(video.decodedFrames, recording.encodedFrames);
    ok((await stat(`${prefix}.webm`)).size > 0);
    deepStrictEqual(pageErrors, []);
    return {
      variant,
      viewport,
      input: mobile ? 'Chromium touch emulation' : 'real Chromium mouse drag and clicks',
      screenshots,
      screenshotScope: 'actual browser viewport',
      video: { path: `${prefix}.webm`, ...video, ...recording },
      releaseId: ready.releaseId,
      receipt: {
        participationId: receipt.participationId,
        campaignId: receipt.campaignId,
        interaction: receipt.interaction,
        status: receipt.status,
        providerMode: receipt.providerMode,
        createdAt: receipt.createdAt,
      },
      visibleSavedState: await saved.textContent(),
      databaseReceiptMatches: true,
      actions,
      pageErrors,
    };
  } finally {
    if (recorder) await recorder.stop().catch(() => {});
    await context.close();
  }
}

await mkdir(outputDirectory, { recursive: true });
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
const browser = await chromium.launch(executablePath ? { executablePath } : {});
const report = {
  startedAt: new Date().toISOString(),
  origin: origin.origin,
  browser: browser.version(),
  source: 'actual Chromium CDP screencast JPEG frames encoded by existing system FFmpeg',
  captures: [],
  limitations: [
    'The mobile recording uses Chromium touch emulation, not a physical phone, Safari, or WeChat.',
    'The video is sampled at 10 fps and is not a rendering-performance benchmark.',
    'External integration remains mock; recorded status only proves this lab persisted a receipt.',
    'No microphone, system audio, cookies, session credentials, or raw events are exported.',
  ],
};
try {
  for (const variant of ['desktop', 'mobile']) {
    report.captures.push(await captureExperience(browser, variant));
  }
  report.status = 'passed';
  report.completedAt = new Date().toISOString();
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  log(`Actual Cloud Post capture passed: two WebM recordings and six state PNGs. ${reportPath}`);
} catch (error) {
  report.status = 'failed';
  report.completedAt = new Date().toISOString();
  report.failure = { name: error.name, message: error.message };
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  throw error;
} finally {
  await browser.close();
}
