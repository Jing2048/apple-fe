import { randomUUID } from 'node:crypto';
import {
  CampaignSchema,
  CampaignIdSchema,
  ErrorSchema,
  EventBatchResponseSchema,
  EventBatchSchema,
  ParticipationRequestSchema,
  ParticipationResponseSchema,
  VerificationResponseSchema,
  type Campaign,
  type Event,
  type ParticipationRequest,
} from '@apple/contracts';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyReply } from 'fastify';
import type { ApiConfig } from './config.js';
import { CampaignCatalog } from './campaigns.js';
import { DomainError } from './errors.js';
import { mockProvider } from './provider.js';
import type { Store } from './store/types.js';

const cookieName = 'campaign_session';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const statusSchema = (status: string) => ({
  type: 'object',
  additionalProperties: false,
  required: ['status', 'releaseId'],
  properties: { status: { type: 'string', const: status }, releaseId: { type: 'string' } },
});

function sessionOf(request: FastifyRequest): string | undefined {
  const raw = request.cookies[cookieName];
  if (!raw) return undefined;
  const signed = request.unsignCookie(raw);
  return signed.valid && signed.value && uuid.test(signed.value) ? signed.value : undefined;
}

function ensureSession(request: FastifyRequest, reply: FastifyReply, config: ApiConfig): void {
  if (sessionOf(request)) return;
  reply.setCookie(cookieName, randomUUID(), {
    path: '/api',
    httpOnly: true,
    sameSite: 'strict',
    secure: config.appOrigin.startsWith('https:'),
    signed: true,
    maxAge: 60 * 60 * 24,
  });
}

export async function buildApp(options: {
  store: Store;
  config: ApiConfig;
  logger?: boolean;
  campaigns?: readonly Campaign[];
}): Promise<FastifyInstance> {
  const { store, config } = options;
  const campaigns = new CampaignCatalog(options.campaigns);
  if (config.nodeEnv === 'production') {
    throw new Error('Production startup is blocked: the external provider is still a mock.');
  }
  const app = Fastify({
    logger:
      options.logger === false
        ? false
        : {
            level: config.nodeEnv === 'test' ? 'silent' : 'info',
            redact: [
              'req.headers.cookie',
              'req.headers.authorization',
              'res.headers["set-cookie"]',
            ],
            serializers: {
              req(request: { method: string; url: string }) {
                return { method: request.method, path: request.url.split('?')[0] };
              },
            },
          },
    bodyLimit: 131_072,
    requestIdHeader: false,
    genReqId: () => randomUUID(),
    trustProxy: false,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false, useDefaults: false } },
  });
  await app.register(helmet);
  await app.register(cookie, { secret: config.sessionSecret });
  await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });
  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'Campaign infrastructure API',
        version: '0.1.0',
        description:
          'Development validation API. External provider is a mock; no benefits are awarded.',
      },
    },
  });

  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', request.id);
    reply.header('cache-control', 'no-store');
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) {
      if (request.headers.origin !== config.appOrigin) {
        throw new DomainError('ORIGIN_FORBIDDEN', 403, 'A same-origin request is required.');
      }
    }
  });

  app.setErrorHandler((error, request, reply) => {
    const safeError = error instanceof Error ? error : new Error('Unknown error');
    const frameworkStatus =
      'statusCode' in safeError && typeof safeError.statusCode === 'number'
        ? safeError.statusCode
        : 500;
    const hasValidation = 'validation' in safeError && Boolean(safeError.validation);
    const statusCode =
      error instanceof DomainError
        ? error.statusCode
        : frameworkStatus >= 400 && frameworkStatus < 500
          ? frameworkStatus
          : 500;
    const code =
      error instanceof DomainError
        ? error.code
        : hasValidation
          ? 'VALIDATION_ERROR'
          : statusCode === 429
            ? 'RATE_LIMITED'
            : statusCode === 413
              ? 'PAYLOAD_TOO_LARGE'
              : statusCode >= 500
                ? 'INTERNAL_ERROR'
                : 'BAD_REQUEST';
    const message =
      error instanceof DomainError
        ? error.message
        : statusCode >= 500
          ? 'The request could not be completed.'
          : statusCode === 429
            ? 'Too many requests. Retry later.'
            : 'The request does not match the API contract.';
    if (statusCode >= 500)
      request.log.error({ code, requestId: request.id }, 'API operation failed');
    void reply.code(statusCode).send({ error: { code, message, requestId: request.id } });
  });

  app.setNotFoundHandler((request, reply) => {
    void reply
      .code(404)
      .send({ error: { code: 'NOT_FOUND', message: 'Route not found.', requestId: request.id } });
  });

  app.get('/api/health', { schema: { response: { 200: statusSchema('ok') } } }, async () => ({
    status: 'ok',
    releaseId: config.releaseId,
  }));
  app.get(
    '/api/ready',
    {
      schema: {
        response: {
          200: {
            ...statusSchema('ready'),
            required: ['status', 'releaseId', 'providerMode'],
            properties: {
              ...statusSchema('ready').properties,
              providerMode: { type: 'string', const: 'mock' },
            },
          },
          default: ErrorSchema,
        },
      },
    },
    async () => {
      if (!(await store.ready()))
        throw new DomainError(
          'NOT_READY',
          503,
          'Database migrations and connectivity are required.',
        );
      return { status: 'ready', releaseId: config.releaseId, providerMode: mockProvider.mode };
    },
  );
  app.get<{ Params: { campaignId: string } }>(
    '/api/campaigns/:campaignId',
    {
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['campaignId'],
          properties: { campaignId: CampaignIdSchema },
        },
        response: { 200: CampaignSchema, default: ErrorSchema },
      },
    },
    async (request, reply) => {
      const campaign = campaigns.require(request.params.campaignId);
      ensureSession(request, reply, config);
      return campaign;
    },
  );
  app.post<{ Body: { events: Event[] } }>(
    '/api/events',
    {
      config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
      schema: {
        body: EventBatchSchema,
        response: { 200: EventBatchResponseSchema, default: ErrorSchema },
      },
    },
    async (request) => {
      const sessionId = sessionOf(request);
      if (!sessionId)
        throw new DomainError(
          'SESSION_REQUIRED',
          401,
          'Load the campaign to establish an anonymous session first.',
        );
      for (const event of request.body.events)
        campaigns.require(event.campaignId, event.properties.interaction);
      return store.ingestEvents(request.body.events, sessionId);
    },
  );
  app.get<{ Params: { participationId: string } }>(
    '/api/lab/verification/:participationId',
    {
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['participationId'],
          properties: { participationId: { type: 'string', format: 'uuid' } },
        },
        response: { 200: VerificationResponseSchema, default: ErrorSchema },
      },
    },
    async (request) => {
      const sessionId = sessionOf(request);
      if (!sessionId)
        throw new DomainError(
          'SESSION_REQUIRED',
          401,
          'Load the campaign to establish an anonymous session first.',
        );
      const result = await store.verification(sessionId, request.params.participationId);
      if (!result) throw new DomainError('NOT_FOUND', 404, 'Verification receipt not found.');
      return result;
    },
  );
  app.post<{ Body: ParticipationRequest }>(
    '/api/participations',
    {
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
      schema: {
        body: ParticipationRequestSchema,
        response: { 200: ParticipationResponseSchema, default: ErrorSchema },
      },
    },
    async (request) => {
      const sessionId = sessionOf(request);
      if (!sessionId)
        throw new DomainError(
          'SESSION_REQUIRED',
          401,
          'Load the campaign to establish an anonymous session first.',
        );
      campaigns.require(request.body.campaignId, request.body.interaction);
      const result = await store.recordParticipation(sessionId, request.body);
      return { ...result, providerMode: mockProvider.mode };
    },
  );
  app.get('/api/openapi.json', { schema: { hide: true } }, async () => app.swagger());
  app.addHook('onClose', async () => store.close());
  await app.ready();
  return app;
}
