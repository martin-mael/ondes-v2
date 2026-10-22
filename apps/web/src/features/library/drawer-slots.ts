import type { AssetDetail, Permission } from '@ondes/shared';
import type { ComponentType } from 'react';
import type { Locale } from '../../app/i18n/messages.ts';

// Extension slots of the asset drawer (#23). Another feature adds a section to the drawer
// without touching the library's files: it creates a file named `asset-drawer-slot.tsx`
// anywhere under `src/features/` that exports `assetDrawerSlots`. The drawer finds those
// files at build time (Vite's `import.meta.glob`), so nothing else needs registering.
//
// The cue editor (#24), in e.g. src/features/cue-editor/asset-drawer-slot.tsx:
//
//     import type { AssetDrawerSlot } from '../library/drawer-slots.ts';
//     import { CueEditorSection } from './cue-editor-section.tsx';
//
//     export const assetDrawerSlots: AssetDrawerSlot[] = [
//       {
//         id: 'cue-editor',
//         title: { en: 'Cue editor', fr: 'Éditeur de cues' },
//         replaces: 'cues',
//         permission: 'library:read',
//         Component: CueEditorSection,
//       },
//     ];
//
// `Component` gets the asset as the drawer loaded it (`AssetDetail`: files with the peaks
// file's sha256 for `GET …/assets/:id/peaks?v=`, cues, loudness, …), whether the person may
// edit it, and `refresh()` to reload the drawer and the library list after a save.

/** The drawer's own sections, top to bottom. */
export const ASSET_DRAWER_SECTIONS = [
  'metadata',
  'tags',
  'loudness',
  'cues',
  'analysis',
  'files',
  'activity',
] as const;
export type AssetDrawerSectionId = (typeof ASSET_DRAWER_SECTIONS)[number];

export interface AssetDrawerSlotProps {
  stationId: string;
  asset: AssetDetail;
  /** The person has `library:write` on the station (the api checks it regardless). */
  canWrite: boolean;
  /** Reloads the asset (drawer) and the library list and counts. */
  refresh: () => Promise<void>;
  /**
   * Reports unsaved edits in the section: the drawer then asks before it closes, and the
   * page before it's left (`useUnsavedChanges`). Stable across renders.
   */
  onDirtyChange?: (dirty: boolean) => void;
}

export interface AssetDrawerSlot {
  /** Unique among slots. */
  id: string;
  /** Section heading, in every UI language. */
  title: Record<Locale, string>;
  /** Takes the place of a built-in section. */
  replaces?: AssetDrawerSectionId;
  /** Goes right after a built-in section (default: at the end). Ignored with `replaces`. */
  after?: AssetDrawerSectionId;
  /** Shown only to roles with it. */
  permission?: Permission;
  Component: ComponentType<AssetDrawerSlotProps>;
}

/** What an `asset-drawer-slot.tsx` file exports. */
export interface AssetDrawerSlotModule {
  assetDrawerSlots?: AssetDrawerSlot[];
}

const discovered = import.meta.glob<AssetDrawerSlotModule>(
  '/src/features/**/asset-drawer-slot.tsx',
  { eager: true },
);

const slots: AssetDrawerSlot[] = Object.values(discovered).flatMap((m) => m.assetDrawerSlots ?? []);

/** The slots found in `asset-drawer-slot.tsx` files, plus any registered at run time. */
export function assetDrawerSlots(): readonly AssetDrawerSlot[] {
  return slots;
}

/** Adds a slot at run time (tests, plugins). Returns a function that removes it. */
export function registerAssetDrawerSlot(slot: AssetDrawerSlot): () => void {
  slots.push(slot);
  return () => {
    const at = slots.indexOf(slot);
    if (at >= 0) slots.splice(at, 1);
  };
}

export type DrawerEntry =
  | { kind: 'builtin'; id: AssetDrawerSectionId }
  | { kind: 'slot'; slot: AssetDrawerSlot };

/** The drawer's sections in order, with the slots placed (`replaces`, then `after`). */
export function drawerLayout(
  available: readonly AssetDrawerSlot[],
  allowed: (permission: Permission) => boolean,
): DrawerEntry[] {
  const visible = available.filter((s) => !s.permission || allowed(s.permission));
  const entries: DrawerEntry[] = [];
  for (const id of ASSET_DRAWER_SECTIONS) {
    const replacing = visible.filter((s) => s.replaces === id);
    if (replacing.length > 0) {
      for (const slot of replacing) entries.push({ kind: 'slot', slot });
    } else {
      entries.push({ kind: 'builtin', id });
    }
    for (const slot of visible.filter((s) => !s.replaces && s.after === id)) {
      entries.push({ kind: 'slot', slot });
    }
  }
  for (const slot of visible.filter((s) => !s.replaces && !s.after)) {
    entries.push({ kind: 'slot', slot });
  }
  return entries;
}
