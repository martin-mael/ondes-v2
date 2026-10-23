import { useCallback } from 'react';
import { useI18n } from '../../../app/i18n/i18n.tsx';
import type { Locale } from '../../../app/i18n/messages.ts';

// Strings of the regeneration dialog (#101), English and French. `fr` must have every key.

const en = {
  open: 'Regenerate',
  title: 'Regenerate the log',
  description:
    'Plans the days again from the clocks, the grid and the shows. Locked items, manual edits and everything in the next hour stay as they are.',
  from: 'From',
  to: 'To',
  preview: 'Preview changes',
  apply: 'Regenerate',
  cancel: 'Cancel',
  close: 'Close',
  rangeHint: 'Up to 7 days per preview.',
  frozenUntil: 'Items before {time} stay as they are.',
  totals: '{added} added · {removed} removed · {moved} moved · {relaxed} with relaxed rules',
  'day.new': 'New day',
  'day.changed': 'Changes',
  'day.unchanged': 'No change',
  'day.kept': '{count} kept',
  'day.unchangedCount': '{count} unchanged',
  'section.added': 'Added',
  'section.removed': 'Removed',
  'section.moved': 'Moved',
  'section.relaxed': 'Rules relaxed',
  'section.issues': 'Could not plan',
  more: 'and {count} more',
  shift: '{shift}',
  newRelaxed: 'new',
  nothing: 'Regenerating these days would change nothing.',
  applied: 'Regeneration queued: the log updates in a moment',
  stale: 'The log changed since the preview. Preview again.',
  past: 'Days before today can’t be regenerated.',
  untitled: 'Untitled',
  'kept.past': 'aired or soon on air',
  'kept.manual': 'manual edit',
  'kept.locked': 'locked',
  'kept.segue': 'in a segue',
  'kept.fallback': 'fallback',
  'issue.no_clock': 'No clock for this hour',
  'issue.unknown_clock': 'The grid names a missing clock',
  'issue.unfilled_slot': 'A slot nothing could fill',
  'issue.underfilled_clock': 'The clock is too short for its hour',
  'issue.episode_missing': 'Episode without audio',
  'issue.occurrence_dropped': 'Show occurrence dropped',
  'issue.occurrence_overlap': 'Show occurrences overlap',
  'issue.vt_placeholder': 'Voice track not placed',
};

export type RegenMessageKey = keyof typeof en;

const fr: Record<RegenMessageKey, string> = {
  open: 'Régénérer',
  title: 'Régénérer le conducteur',
  description:
    'Planifie à nouveau les jours à partir des horloges, de la grille et des émissions. Les éléments verrouillés, les modifications manuelles et tout ce qui passe dans l’heure restent tels quels.',
  from: 'Du',
  to: 'Au',
  preview: 'Voir les changements',
  apply: 'Régénérer',
  cancel: 'Annuler',
  close: 'Fermer',
  rangeHint: 'Jusqu’à 7 jours par aperçu.',
  frozenUntil: 'Les éléments avant {time} restent tels quels.',
  totals:
    '{added} ajoutés · {removed} retirés · {moved} déplacés · {relaxed} avec règles assouplies',
  'day.new': 'Nouveau jour',
  'day.changed': 'Changements',
  'day.unchanged': 'Aucun changement',
  'day.kept': '{count} conservés',
  'day.unchangedCount': '{count} inchangés',
  'section.added': 'Ajoutés',
  'section.removed': 'Retirés',
  'section.moved': 'Déplacés',
  'section.relaxed': 'Règles assouplies',
  'section.issues': 'Impossible à planifier',
  more: 'et {count} de plus',
  shift: '{shift}',
  newRelaxed: 'nouveau',
  nothing: 'Régénérer ces jours ne changerait rien.',
  applied: 'Régénération lancée : le conducteur se met à jour dans un instant',
  stale: 'Le conducteur a changé depuis l’aperçu. Relancez l’aperçu.',
  past: 'Les jours passés ne peuvent pas être régénérés.',
  untitled: 'Sans titre',
  'kept.past': 'passé ou bientôt à l’antenne',
  'kept.manual': 'modification manuelle',
  'kept.locked': 'verrouillé',
  'kept.segue': 'dans un enchaînement',
  'kept.fallback': 'remplacement',
  'issue.no_clock': 'Aucune horloge pour cette heure',
  'issue.unknown_clock': 'La grille désigne une horloge absente',
  'issue.unfilled_slot': 'Un créneau que rien n’a pu remplir',
  'issue.underfilled_clock': 'L’horloge est trop courte pour son heure',
  'issue.episode_missing': 'Épisode sans audio',
  'issue.occurrence_dropped': 'Diffusion d’émission écartée',
  'issue.occurrence_overlap': 'Diffusions d’émissions qui se chevauchent',
  'issue.vt_placeholder': 'Voix non placée',
};

const messages: Record<Locale, Record<RegenMessageKey, string>> = { en, fr };

export type RegenT = (key: RegenMessageKey, params?: Record<string, string | number>) => string;

/** `t` for the regeneration dialog's strings, in the app's current locale. */
export function useRegenT(): RegenT {
  const { locale } = useI18n();
  return useCallback(
    (key: RegenMessageKey, params?: Record<string, string | number>) =>
      (messages[locale][key] ?? key).replace(/\{(\w+)\}/g, (match, name: string) =>
        params && name in params ? String(params[name]) : match,
      ),
    [locale],
  );
}
