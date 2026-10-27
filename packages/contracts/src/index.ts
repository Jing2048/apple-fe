import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

const strict = { additionalProperties: false } as const;
const Uuid = Type.String({ format: 'uuid' });
export const CAMPAIGN_ID_PATTERN = '^[a-z0-9]+(-[a-z0-9]+)*$';
export const CampaignIdSchema = Type.String({
  minLength: 1,
  maxLength: 64,
  pattern: CAMPAIGN_ID_PATTERN,
});
export type CampaignId = Static<typeof CampaignIdSchema>;
export const InteractionSchema = Type.Union([Type.Literal('timing'), Type.Literal('swipe')]);
export type Interaction = Static<typeof InteractionSchema>;

export const CampaignSchema = Type.Object(
  {
    id: CampaignIdSchema,
    version: Type.String({ minLength: 1, maxLength: 80, pattern: '^[a-zA-Z0-9._-]+$' }),
    title: Type.String({ minLength: 1, maxLength: 100 }),
    interactions: Type.Array(InteractionSchema, { minItems: 1, uniqueItems: true }),
    assets: Type.Array(
      Type.Object(
        {
          id: Type.String({ minLength: 1, maxLength: 100 }),
          url: Type.String({ pattern: '^/assets/(?!.*\\.\\.)[a-zA-Z0-9][a-zA-Z0-9._/-]*$' }),
          kind: Type.Union([Type.Literal('image'), Type.Literal('audio'), Type.Literal('video')]),
          bytes: Type.Integer({ minimum: 0 }),
          critical: Type.Boolean(),
        },
        strict,
      ),
    ),
    privacy: Type.Object({ analyticsOptional: Type.Literal(true) }, strict),
  },
  strict,
);
export type Campaign = Static<typeof CampaignSchema>;
export function isCampaignConfiguration(value: unknown): value is Campaign {
  return Value.Check(CampaignSchema, value);
}
export const labCampaign: Campaign = {
  id: 'lab',
  version: 'lab-v1',
  title: '互动基础设施验证台',
  interactions: ['timing', 'swipe'],
  assets: [
    {
      id: 'lab-marker',
      url: '/assets/lab-marker.5d0c3a787c21.svg',
      kind: 'image',
      bytes: 204,
      critical: true,
    },
  ],
  privacy: { analyticsOptional: true },
};

export const EventNameSchema = Type.Union([
  Type.Literal('page_view'),
  Type.Literal('interaction_started'),
  Type.Literal('interaction_completed'),
  Type.Literal('interaction_paused'),
  Type.Literal('interaction_resumed'),
  Type.Literal('interaction_reset'),
  Type.Literal('resource_failed'),
]);
export const EventPropertiesSchema = Type.Object(
  {
    interaction: Type.Optional(InteractionSchema),
    roundId: Type.Optional(Uuid),
    durationMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 3_600_000 })),
    reason: Type.Optional(
      Type.Union([
        Type.Literal('hidden'),
        Type.Literal('user'),
        Type.Literal('network'),
        Type.Literal('asset'),
      ]),
    ),
    steps: Type.Optional(Type.Integer({ minimum: 0, maximum: 100 })),
  },
  strict,
);
export const EventSchema = Type.Object(
  {
    eventId: Uuid,
    eventName: EventNameSchema,
    schemaVersion: Type.Literal(1),
    campaignId: CampaignIdSchema,
    releaseId: Type.String({ minLength: 1, maxLength: 100, pattern: '^[a-zA-Z0-9._-]+$' }),
    sessionId: Uuid,
    clientTime: Type.String({ format: 'date-time' }),
    properties: EventPropertiesSchema,
  },
  strict,
);
export type Event = Static<typeof EventSchema>;
export type EventName = Static<typeof EventNameSchema>;
export type EventProperties = Static<typeof EventPropertiesSchema>;
export const EventBatchSchema = Type.Object(
  { events: Type.Array(EventSchema, { minItems: 1, maxItems: 50 }) },
  strict,
);
export const EventBatchResponseSchema = Type.Object(
  {
    accepted: Type.Integer({ minimum: 0 }),
    duplicates: Type.Integer({ minimum: 0 }),
  },
  strict,
);
export type EventBatchResponse = Static<typeof EventBatchResponseSchema>;

export const ParticipationRequestSchema = Type.Object(
  {
    campaignId: CampaignIdSchema,
    interaction: InteractionSchema,
    idempotencyKey: Uuid,
  },
  strict,
);
export type ParticipationRequest = Static<typeof ParticipationRequestSchema>;
export const ParticipationResponseSchema = Type.Object(
  {
    participationId: Uuid,
    campaignId: CampaignIdSchema,
    interaction: InteractionSchema,
    status: Type.Literal('recorded'),
    providerMode: Type.Literal('mock'),
    createdAt: Type.String({ format: 'date-time' }),
  },
  strict,
);
export type ParticipationResponse = Static<typeof ParticipationResponseSchema>;

/** Read-only facts scoped by the server-verified anonymous session cookie. */
export const VerificationResponseSchema = Type.Object(
  {
    receipt: ParticipationResponseSchema,
    roundId: Uuid,
    checkedAt: Type.String({ format: 'date-time' }),
    eventSummary: Type.Object(
      {
        sessionTotal: Type.Integer({ minimum: 0 }),
        roundTotal: Type.Integer({ minimum: 0 }),
        byName: Type.Array(
          Type.Object({ eventName: EventNameSchema, count: Type.Integer({ minimum: 1 }) }, strict),
          { maxItems: 7, uniqueItems: true },
        ),
      },
      strict,
    ),
  },
  strict,
);
export type VerificationResponse = Static<typeof VerificationResponseSchema>;

export const ErrorSchema = Type.Object(
  {
    error: Type.Object(
      {
        code: Type.String(),
        message: Type.String(),
        requestId: Type.String(),
      },
      strict,
    ),
  },
  strict,
);
export type ApiError = Static<typeof ErrorSchema>;
