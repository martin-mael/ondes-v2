import { useCallback } from 'react';
import { useI18n } from '../../../app/i18n/i18n.tsx';
import type { Locale } from '../../../app/i18n/messages.ts';

// Strings of the log vs as-run view (#53), English and French. `fr` must have every key.

const en = {
  'view.plan': 'Plan',
  'view.history': 'Plan vs aired',

  'summary.title': 'What aired',
  'summary.empty': 'Nothing planned or aired on this day.',
  'summary.pendingHint': 'The rest of the day hasn’t aired yet.',

  'hour.aired': '{count} aired',
  'hour.issues': '{count} off plan',
  'hour.drift': 'drift up to {drift}',

  'col.aired': 'Aired',
  'col.planned': 'Planned',

  'status.aired': 'Aired',
  'status.replaced': 'Replaced',
  'status.fallback': 'Fallback',
  'status.missed': 'Not aired',
  'status.pending': 'Upcoming',
  'status.live': 'Live',
  'status.safety': 'Safety playlist',
  'status.emergency': 'Emergency file',
  'status.unplanned': 'Off plan',
  'status.transition': 'Transition',

  'outcome.cut': 'Cut',
  'outcome.skipped': 'Skipped',
  'outcome.interrupted': 'Interrupted',
  onAir: 'On air',
  repeat: 'Aired again',

  'fallback.latest_episode': 'latest episode',
  'fallback.episode': 'another episode',
  'fallback.clock_music': 'music',

  plannedAs: 'Planned: {title}',
  voices: 'Voice: {titles}',
  voicesOver: 'Voice over the crossfade (island not ready): {titles}',
  replacedBy: 'Its slot went to: {what}',
  wasPlanned: 'Was planned at {time} (log changed since)',
  untitled: 'Untitled',
  liveDj: 'Live',
  drift: '{drift} vs plan',
  forbidden: 'You can’t see what aired on this station.',
};

export type HistoryMessageKey = keyof typeof en;

const fr: Record<HistoryMessageKey, string> = {
  'view.plan': 'Conducteur',
  'view.history': 'Prévu / diffusé',

  'summary.title': 'Ce qui est passé',
  'summary.empty': 'Rien de prévu ni de diffusé ce jour-là.',
  'summary.pendingHint': 'La suite de la journée n’est pas encore passée.',

  'hour.aired': '{count} diffusés',
  'hour.issues': '{count} hors conducteur',
  'hour.drift': 'décalage jusqu’à {drift}',

  'col.aired': 'Diffusé',
  'col.planned': 'Prévu',

  'status.aired': 'Diffusé',
  'status.replaced': 'Remplacé',
  'status.fallback': 'Repli',
  'status.missed': 'Pas diffusé',
  'status.pending': 'À venir',
  'status.live': 'Direct',
  'status.safety': 'Playlist de secours',
  'status.emergency': 'Fichier d’urgence',
  'status.unplanned': 'Hors conducteur',
  'status.transition': 'Enchaînement',

  'outcome.cut': 'Coupé',
  'outcome.skipped': 'Sauté',
  'outcome.interrupted': 'Interrompu',
  onAir: 'À l’antenne',
  repeat: 'Rediffusé',

  'fallback.latest_episode': 'dernier épisode',
  'fallback.episode': 'autre épisode',
  'fallback.clock_music': 'musique',

  plannedAs: 'Prévu : {title}',
  voices: 'Voix : {titles}',
  voicesOver: 'Voix sur le fondu (îlot pas prêt) : {titles}',
  replacedBy: 'Son créneau est allé à : {what}',
  wasPlanned: 'Prévu à {time} (conducteur modifié depuis)',
  untitled: 'Sans titre',
  liveDj: 'Direct',
  drift: '{drift} par rapport au conducteur',
  forbidden: 'Vous ne pouvez pas voir ce qui est passé sur cette station.',
};

const messages: Record<Locale, Record<HistoryMessageKey, string>> = { en, fr };

export type HistoryT = (key: HistoryMessageKey, params?: Record<string, string | number>) => string;

/** `t` for the history view's strings, in the app's current locale. */
export function useHistoryT(): HistoryT {
  const { locale } = useI18n();
  return useCallback(
    (key: HistoryMessageKey, params?: Record<string, string | number>) =>
      (messages[locale][key] ?? key).replace(/\{(\w+)\}/g, (match, name: string) =>
        params && name in params ? String(params[name]) : match,
      ),
    [locale],
  );
}
