import type {
  Event,
  ParticipationRequest,
  ParticipationResponse,
  VerificationResponse,
} from '@apple/contracts';

export interface EventBatchResult {
  accepted: number;
  duplicates: number;
}

export interface Store {
  ready(): Promise<boolean>;
  ingestEvents(events: Event[], sessionId: string): Promise<EventBatchResult>;
  recordParticipation(
    sessionId: string,
    request: ParticipationRequest,
  ): Promise<ParticipationResponse>;
  verification(
    sessionId: string,
    participationId: string,
  ): Promise<VerificationResponse | undefined>;
  close(): Promise<void>;
}
