import {
  isCampaignConfiguration,
  labCampaign,
  type Campaign,
  type Interaction,
} from '@apple/contracts';
import { DomainError } from './errors.js';
import { cloudPostCampaign } from './campaign-config.js';

type Immutable<T> = T extends object ? { readonly [K in keyof T]: Immutable<T[K]> } : T;

function freeze<T>(value: T): Immutable<T> {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value as Immutable<T>;
}

/** Trusted, version-controlled campaign configuration. No editor or remote configuration service. */
export class CampaignCatalog {
  private readonly campaigns = new Map<string, Immutable<Campaign>>();

  constructor(campaigns: readonly Campaign[] = [labCampaign, cloudPostCampaign]) {
    for (const campaign of campaigns) {
      if (!isCampaignConfiguration(campaign))
        throw new Error('Campaign configuration does not match the runtime contract.');
      if (this.campaigns.has(campaign.id))
        throw new Error('Campaign configuration has duplicate IDs.');
      this.campaigns.set(campaign.id, freeze(structuredClone(campaign)));
    }
  }

  require(campaignId: string, interaction?: Interaction): Immutable<Campaign> {
    const campaign = this.campaigns.get(campaignId);
    if (!campaign) throw new DomainError('CAMPAIGN_NOT_FOUND', 404, 'Campaign not found.');
    if (interaction && !campaign.interactions.includes(interaction)) {
      throw new DomainError(
        'INTERACTION_NOT_SUPPORTED',
        400,
        'The interaction is not enabled for this campaign.',
      );
    }
    return campaign;
  }
}
