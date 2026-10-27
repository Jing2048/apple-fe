import {
  CampaignSchema,
  ParticipationResponseSchema,
  VerificationResponseSchema,
  type Campaign,
  type ParticipationRequest,
  type ParticipationResponse,
  type VerificationResponse,
} from '@apple/contracts';
import { FormatRegistry, Type, type Static, type TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

FormatRegistry.Set('uuid', (value) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value),
);
FormatRegistry.Set(
  'date-time',
  (value) => /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value)),
);

const HealthSchema = Type.Object({ status: Type.Literal('ok'), releaseId: Type.String() });
const ReadySchema = Type.Object({
  status: Type.Literal('ready'),
  releaseId: Type.String(),
  providerMode: Type.Literal('mock'),
});

export class RequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly requestId: string | null = null,
  ) {
    super(message);
    this.name = 'RequestError';
  }
}

async function request<T extends TSchema>(
  path: string,
  schema: T,
  init: RequestInit = {},
): Promise<Static<T>> {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  init.signal?.addEventListener('abort', onAbort, { once: true });
  if (init.signal?.aborted) controller.abort();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(path, {
      ...init,
      credentials: 'same-origin',
      signal: controller.signal,
      headers: { Accept: 'application/json', ...init.headers },
    });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const requestId = response.headers.get('x-request-id');
      throw new RequestError(
        response.status === 503
          ? '服务暂未就绪，请稍后重试。'
          : `请求未完成（HTTP ${response.status}）。`,
        response.status,
        requestId,
      );
    }
    if (!Value.Check(schema, payload)) throw new RequestError('服务响应与接口契约不一致。', 502);
    return payload;
  } catch (error) {
    if (error instanceof RequestError) throw error;
    throw new RequestError('网络连接中断或请求超时，请重试。', 0);
  } finally {
    clearTimeout(timer);
    init.signal?.removeEventListener('abort', onAbort);
  }
}

export const api = {
  health: (signal?: AbortSignal) => request('/api/health', HealthSchema, signal ? { signal } : {}),
  ready: (signal?: AbortSignal) => request('/api/ready', ReadySchema, signal ? { signal } : {}),
  campaign: async (campaignId: string, signal?: AbortSignal): Promise<Campaign> => {
    const campaign = await request(
      `/api/campaigns/${encodeURIComponent(campaignId)}`,
      CampaignSchema,
      signal ? { signal } : {},
    );
    if (campaign.id !== campaignId) throw new RequestError('服务返回的活动与请求活动不一致。', 502);
    return campaign;
  },
  participate: async (input: ParticipationRequest): Promise<ParticipationResponse> => {
    const receipt = await request('/api/participations', ParticipationResponseSchema, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (receipt.campaignId !== input.campaignId || receipt.interaction !== input.interaction) {
      throw new RequestError('服务返回的记录与本次互动不一致。', 502);
    }
    return receipt;
  },
  verifyParticipation: (
    participationId: string,
    signal?: AbortSignal,
  ): Promise<VerificationResponse> =>
    request(
      `/api/lab/verification/${encodeURIComponent(participationId)}`,
      VerificationResponseSchema,
      { cache: 'no-store', ...(signal ? { signal } : {}) },
    ),
};
