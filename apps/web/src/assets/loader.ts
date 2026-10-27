import type { Campaign } from '@apple/contracts';

type Asset = Campaign['assets'][number];
interface LoaderOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  fetch?: typeof fetch;
  decode?: (blob: Blob, signal: AbortSignal) => Promise<void>;
}

function cancelled(): DOMException {
  return new DOMException('Asset loading cancelled', 'AbortError');
}

export function decodeImage(blob: Blob, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(cancelled());
      return;
    }
    const url = URL.createObjectURL(blob);
    const image = new Image();
    const cleanup = () => {
      image.onload = null;
      image.onerror = null;
      signal.removeEventListener('abort', onAbort);
      URL.revokeObjectURL(url);
    };
    const onAbort = () => {
      image.src = '';
      cleanup();
      reject(cancelled());
    };
    image.onload = () => {
      cleanup();
      resolve();
    };
    image.onerror = () => {
      cleanup();
      reject(new Error('Image decoding failed'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    image.src = url;
  });
}

async function loadImage(
  asset: Asset,
  fetcher: typeof fetch,
  decode: (blob: Blob, signal: AbortSignal) => Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) throw cancelled();
  if (asset.kind !== 'image') throw new Error(`暂不支持关键素材类型：${asset.kind}`);
  const response = await fetcher(asset.url, { credentials: 'same-origin', signal });
  if (!response.ok) throw new Error(`占位素材加载失败（HTTP ${response.status}）`);
  const blob = await response.blob();
  if (asset.bytes > 0 && blob.size !== asset.bytes) throw new Error('素材体积与版本清单不一致');
  if (signal.aborted) throw cancelled();
  await decode(blob, signal);
}

/** Critical images must fetch and decode successfully before the interaction is ready. */
export async function loadCriticalImages(
  campaign: Campaign,
  options: LoaderOptions = {},
): Promise<void> {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  options.signal?.addEventListener('abort', onAbort, { once: true });
  if (options.signal?.aborted) controller.abort();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
  try {
    await Promise.all(
      campaign.assets
        .filter((asset) => asset.critical)
        .map((asset) =>
          loadImage(asset, fetcher, options.decode ?? decodeImage, controller.signal),
        ),
    );
  } catch (error) {
    if (options.signal?.aborted) throw cancelled();
    if (controller.signal.aborted) throw new Error('素材加载超时，请重试', { cause: error });
    controller.abort();
    throw error;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', onAbort);
  }
}
