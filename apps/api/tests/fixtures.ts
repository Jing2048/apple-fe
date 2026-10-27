import { randomUUID } from 'node:crypto';
import type { Campaign, Event, ParticipationRequest } from '@apple/contracts';
import { loadConfig } from '../src/config.js';

/** Injection fixture only; this campaign is never registered in runtime startup. */
export const secondCampaign: Campaign = {
  id: 'test-second',
  version: 'test-v1',
  title: 'Test-only second campaign',
  interactions: ['swipe'],
  assets: [],
  privacy: { analyticsOptional: true },
};

export const testConfig = () =>
  loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://unused:unused@localhost/test',
    APP_ORIGIN: 'http://localhost:5173',
    RELEASE_ID: 'test-release',
    SESSION_SECRET: 'test-only-session-signing-secret-32-characters',
  });

export function event(overrides: Partial<Event> = {}): Event {
  return {
    eventId: randomUUID(),
    eventName: 'interaction_completed',
    schemaVersion: 1,
    campaignId: 'lab',
    releaseId: 'test-release',
    sessionId: randomUUID(),
    clientTime: '2026-10-27T00:00:00.000Z',
    properties: { interaction: 'timing', durationMs: 1200, steps: 3 },
    ...overrides,
  };
}

export function participation(overrides: Partial<ParticipationRequest> = {}): ParticipationRequest {
  return { campaignId: 'lab', interaction: 'timing', idempotencyKey: randomUUID(), ...overrides };
}
