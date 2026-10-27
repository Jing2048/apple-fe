import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import {
  CampaignSchema,
  EventBatchSchema,
  ParticipationRequestSchema,
  VerificationResponseSchema,
  isCampaignConfiguration,
  labCampaign,
} from './index.js';

const ajv = new Ajv({ allErrors: true, removeAdditional: false, coerceTypes: false });
addFormats(ajv);
const validateBatch = ajv.compile(EventBatchSchema);
const validEvent = {
  eventId: '5af39fe2-e78f-4376-a046-b96f00a465db',
  eventName: 'interaction_started',
  schemaVersion: 1,
  campaignId: 'lab',
  releaseId: 'test-v1',
  sessionId: '97f85487-d73d-41f0-8b2e-8564f9710c94',
  clientTime: '2026-10-27T00:00:00.000Z',
  properties: { interaction: 'timing' },
};

describe('public contracts', () => {
  it('validates the exact campaign delivered by the API', () => {
    expect(ajv.validate(CampaignSchema, labCampaign)).toBe(true);
  });
  it('accepts another activity configuration without changing the public contract', () => {
    expect(
      ajv.validate(CampaignSchema, {
        ...labCampaign,
        id: 'spring-2027',
        version: 'v2.1',
        title: 'Fixture only',
      }),
    ).toBe(true);
    for (const id of ['Bad', '-bad', 'bad-', 'two--dashes', '../lab', 'x'.repeat(65)]) {
      expect(ajv.validate(CampaignSchema, { ...labCampaign, id })).toBe(false);
    }
  });
  it('checks all catalog fields at runtime, including version and asset metadata', () => {
    expect(isCampaignConfiguration(labCampaign)).toBe(true);
    expect(isCampaignConfiguration({ ...labCampaign, version: '' })).toBe(false);
    expect(isCampaignConfiguration({ ...labCampaign, title: '' })).toBe(false);
    expect(
      isCampaignConfiguration({
        ...labCampaign,
        assets: [{ ...labCampaign.assets[0], bytes: -1 }],
      }),
    ).toBe(false);
    expect(
      isCampaignConfiguration({
        ...labCampaign,
        assets: [{ ...labCampaign.assets[0], url: '/assets/../private.svg' }],
      }),
    ).toBe(false);
  });
  it('accepts a valid versioned event batch', () => {
    expect(validateBatch({ events: [validEvent] })).toBe(true);
  });
  it('allows a UUID round reference but rejects malformed round identifiers', () => {
    expect(
      validateBatch({ events: [{ ...validEvent, properties: { roundId: validEvent.eventId } }] }),
    ).toBe(true);
    expect(
      validateBatch({
        events: [{ ...validEvent, properties: { roundId: 'arbitrary-user-value' } }],
      }),
    ).toBe(false);
  });
  it('exposes only the narrow verification response, not private session or raw event data', () => {
    const validate = ajv.compile(VerificationResponseSchema);
    const response = {
      receipt: {
        participationId: validEvent.eventId,
        campaignId: 'lab',
        interaction: 'timing',
        status: 'recorded',
        providerMode: 'mock',
        createdAt: validEvent.clientTime,
      },
      roundId: validEvent.eventId,
      checkedAt: validEvent.clientTime,
      eventSummary: {
        sessionTotal: 2,
        roundTotal: 1,
        byName: [{ eventName: 'interaction_completed', count: 1 }],
      },
    };
    expect(validate(response)).toBe(true);
    expect(validate({ ...response, ownerSessionId: validEvent.sessionId })).toBe(false);
    expect(validate({ ...response, events: [validEvent] })).toBe(false);
    expect(
      validate({ ...response, eventSummary: { ...response.eventSummary, rawPayload: {} } }),
    ).toBe(false);
  });
  it.each(['email', 'phone', 'userId', 'url', 'score'])(
    'rejects undeclared event property %s rather than silently dropping it',
    (key) => {
      expect(
        validateBatch({
          events: [{ ...validEvent, properties: { ...validEvent.properties, [key]: 'value' } }],
        }),
      ).toBe(false);
    },
  );
  it('rejects invalid identifiers, unknown events, overlarge batches and negative durations', () => {
    for (const bad of [
      { events: [{ ...validEvent, eventId: 'not-uuid' }] },
      { events: [{ ...validEvent, clientTime: 'yesterday' }] },
      { events: [{ ...validEvent, eventName: 'reward_granted' }] },
      { events: [{ ...validEvent, properties: { durationMs: -1 } }] },
      { events: Array.from({ length: 51 }, () => validEvent) },
      { events: [] },
    ])
      expect(validateBatch(bad)).toBe(false);
  });
  it('does not accept a client score or reward instruction as participation input', () => {
    const validate = ajv.compile(ParticipationRequestSchema);
    const request = {
      campaignId: 'lab',
      interaction: 'timing',
      idempotencyKey: validEvent.eventId,
    };
    expect(validate(request)).toBe(true);
    expect(validate({ ...request, score: 9999 })).toBe(false);
    expect(validate({ ...request, winner: true })).toBe(false);
  });
});
