import type { AssetDrawerSlot } from '../library/drawer-slots.ts';
import { CueEditorSection } from './cue-editor-section.tsx';

// The cue editor (#24) takes the place of the drawer's read-only cue list (#23).
export const assetDrawerSlots: AssetDrawerSlot[] = [
  {
    id: 'cue-editor',
    title: { en: 'Cue editor', fr: 'Éditeur de cues' },
    replaces: 'cues',
    permission: 'library:read',
    Component: CueEditorSection,
  },
];
