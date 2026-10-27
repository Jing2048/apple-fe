import { describe, expect, it, vi } from 'vitest';
import { labCampaign, type Campaign } from '@apple/contracts';
import { loadCriticalImages } from './loader';

const campaign: Campaign = {
  ...labCampaign,
  assets: [
    {
      id: 'test-marker',
      url: '/assets/test.svg',
      kind: 'image',
      bytes: 3,
      critical: true,
    },
  ],
};

describe('critical image readiness', () => {
  it('requires successful decoding after a successful response', async () => {
    const decode = vi.fn().mockResolvedValue(undefined);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('svg'));
    await loadCriticalImages(campaign, { fetch: fetcher, decode });
    expect(decode).toHaveBeenCalledOnce();
    expect((decode.mock.calls[0]?.[0] as Blob).size).toBe(3);
  });
  it('fails a missing resource and retries with a fresh fetch', async () => {
    const decode = vi.fn().mockResolvedValue(undefined);
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('missing', { status: 404 }))
      .mockResolvedValueOnce(new Response('svg'));
    await expect(loadCriticalImages(campaign, { fetch: fetcher, decode })).rejects.toThrow('404');
    expect(decode).not.toHaveBeenCalled();
    await loadCriticalImages(campaign, { fetch: fetcher, decode });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('rejects invalid size and decoder failure instead of declaring readiness', async () => {
    await expect(
      loadCriticalImages(campaign, {
        fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response('invalid')),
        decode: vi.fn(),
      }),
    ).rejects.toThrow('体积');
    await expect(
      loadCriticalImages(campaign, {
        fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response('svg')),
        decode: vi.fn().mockRejectedValue(new Error('cannot decode')),
      }),
    ).rejects.toThrow('cannot decode');
  });
  it('propagates caller cancellation and aborts the underlying fetch', async () => {
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('cancelled', 'AbortError')),
          );
        }),
    );
    const loading = loadCriticalImages(campaign, {
      fetch: fetcher,
      signal: controller.signal,
      decode: vi.fn(),
    });
    controller.abort();
    await expect(loading).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });
  it('rejects unsupported critical media while ignoring optional assets', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(
      loadCriticalImages(
        { ...campaign, assets: [{ ...campaign.assets[0]!, kind: 'video' }] },
        { fetch: fetcher },
      ),
    ).rejects.toThrow('暂不支持');
    await loadCriticalImages(
      { ...campaign, assets: [{ ...campaign.assets[0]!, kind: 'audio', critical: false }] },
      { fetch: fetcher },
    );
    expect(fetcher).not.toHaveBeenCalled();
  });
});
