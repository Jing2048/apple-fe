/** This interface marks the integration boundary; it does not imply an Apple integration. */
export interface ParticipationProvider {
  readonly mode: 'mock';
  readonly grantsBenefits: false;
}

export const mockProvider: ParticipationProvider = Object.freeze({
  mode: 'mock',
  grantsBenefits: false,
});
