import type { AssetDrawerSlot } from '../library/drawer-slots.ts';
import { CueSummary } from './cue-summary.tsx';

// The cue summary (#24), with a link to the cue editor page, takes the place of the drawer's
// read-only cue list (#23).
export const assetDrawerSlots: AssetDrawerSlot[] = [
  {
    id: 'cue-editor',
    title: { en: 'Cue points', fr: 'Points de cue' },
    replaces: 'cues',
    permission: 'library:read',
    Component: CueSummary,
  },
];
