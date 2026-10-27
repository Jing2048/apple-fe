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
  /** Optional playfield background; it must not intercept pointer input. */
  scene?: ReactNode;
  /** Optional controls rendered outside the playfield, only during the journey. */
  controls?: ReactNode;
  introNote?: ReactNode;
  /** Playing is active; pause, completion and leaving the field deactivate it. */
  onSceneActiveChange?: (active: boolean) => void;
}
