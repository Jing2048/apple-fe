import { afterEach, describe, expect, it, vi } from 'vitest';
import { labCampaign } from '@apple/contracts';
import { api } from './client';

afterEach(() => vi.unstubAllGlobals());

describe('campaign transport', () => {
  it('loads an explicit campaign and keeps the same-origin session handshake', async () => {
    const campaign = { ...labCampaign, id: 'spring-sale', version: 'spring-2027-v1' };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(campaign)));
    vi.stubGlobal('fetch', fetcher);
    await expect(api.campaign('spring-sale')).resolves.toEqual(campaign);
    expect(fetcher).toHaveBeenCalledWith(
      '/api/campaigns/spring-sale',
      expect.objectContaining({
        credentials: 'same-origin',
      }),
    );
  });

  it('rejects a valid response for a different campaign', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(labCampaign))),
    );
    await expect(api.campaign('spring-sale')).rejects.toThrow('请求活动不一致');
  });
});

describe('participation transport', () => {
  it.each([
    { campaignId: 'lab', interaction: 'swipe' },
    { campaignId: 'cloud-post', interaction: 'timing' },
  ])('rejects a schema-valid receipt for a different interaction scope: %o', async (scope) => {
    const receipt = {
      participationId: 'c941ad64-a313-43f1-90f0-2844528c9896',
      ...scope,
      status: 'recorded',
      providerMode: 'mock',
      createdAt: '2026-10-27T00:00:00.000Z',
    };
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(receipt))),
    );
    await expect(
      api.participate({
        campaignId: 'cloud-post',
        interaction: 'swipe',
        idempotencyKey: '4e8b3ae7-b069-47d0-a3a8-b849ef2519a1',
      }),
    ).rejects.toThrow('本次互动不一致');
  });
});
