import type { ReactNode } from 'react';
import type { Campaign } from '@apple/contracts';
import type { BlessingIndex, PostStorage } from './recovery';

/** Fixed at mount: the standalone demo supplies local data and its own receipt view. */
export interface OfflinePostRuntime {
  campaign: Campaign;
  draftStorage: PostStorage | null;
  renderReceipt: (args: { roundId: string; blessingIndex: BlessingIndex }) => ReactNode;
}

export interface CloudPostProps {
  offline?: OfflinePostRuntime;
}
