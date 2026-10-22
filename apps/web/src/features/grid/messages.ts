import { isApiError } from '../../app/api/client.ts';
import { useI18n } from '../../app/i18n/i18n.tsx';
import type { Locale } from '../../app/i18n/messages.ts';

// Weekly grid strings (#40), English and French. `fr` must have `en`'s keys.

const en = {
  title: 'Weekly grid',
  description:
    'Which clock airs in each hour of the week. Pick a clock, then click or drag across the hours to paint it. Shift-click paints the rectangle from the last hour you clicked.',
  stationTime: 'Hours in station time ({timezone}).',
  forbidden: "You don't have access to this station's grid.",
  save: 'Save grid',
  saved: 'Grid saved.',
  discard: 'Discard changes',
  conflict:
    'Someone saved the grid while you were editing it. Load their version, or keep your changes and save them over theirs.',
  'conflict.load': 'Load their version',
  'conflict.loadConfirm': 'Load their version? Your unsaved changes will be lost.',
  'conflict.keep': 'Keep my changes',
  unknownClock: 'Some hours use clocks that no longer exist. Reload the grid.',
  incomplete: 'Choose a default clock or paint every hour before saving.',
  noClocks: 'No clock yet. Create a clock first, then paint it on the grid.',
  createClock: 'Create a clock',

  'brush.title': 'Paint with',
  'brush.default': 'Default clock',
  'brush.defaultHelp': 'Clears hours back to the default clock.',
  'default.label': 'Default clock',
  'default.help': 'Airs in every hour you haven’t painted.',
  'default.none': 'None',
  'default.missing':
    '{count} hours have no clock: choose a default clock (or paint every hour) before saving.',
  'default.missingOne': '1 hour has no clock: choose a default clock before saving.',
  'touch.paint': 'Drag to paint',
  'touch.help':
    'On a touch screen a drag scrolls and a tap paints one hour. Turn this on to paint by dragging.',

  'cell.label': '{day} {hour}: {clock}',
  'cell.default': 'default ({clock})',
  'cell.none': 'no clock',

  'dayparts.title': 'Dayparts',
  'dayparts.help':
    'Named ranges of hours. Apply one to paint all its hours with the selected clock.',
  'dayparts.empty': 'No daypart yet.',
  'dayparts.new': 'New daypart',
  'dayparts.apply': 'Paint',
  'dayparts.applyTo': 'Paint {daypart} with {clock}',
  'dayparts.applied': '{daypart} painted. Save the grid to keep it.',
  'dayparts.edit': 'Edit',
  'dayparts.delete': 'Delete',
  'dayparts.deleteConfirm': 'Delete the daypart “{name}”? The grid keeps its hours.',
  'dayparts.deleted': 'Daypart deleted.',
  'dayparts.created': 'Daypart created.',
  'dayparts.updated': 'Daypart saved.',
  'dayparts.nameTaken': 'Another daypart already has this name.',
  'daypart.newTitle': 'New daypart',
  'daypart.editTitle': 'Edit daypart',
  'daypart.name': 'Name',
  'daypart.days': 'Days',
  'daypart.from': 'From',
  'daypart.to': 'To',
  'daypart.overnight': 'Runs past midnight into the next day.',
  'daypart.noDays': 'Choose at least one day.',

  'overrides.title': 'Overrides',
  'overrides.help':
    'Date ranges that replace the weekly grid: holidays, special weeks, one-off evenings. When two overlap, the shorter one wins.',
  'overrides.empty': 'No override.',
  'overrides.new': 'New override',
  'overrides.past': 'Past',
  'overrides.allDay': 'all day',
  'overrides.edit': 'Edit',
  'overrides.delete': 'Delete',
  'overrides.deleteConfirm': 'Delete the override “{name}”?',
  'overrides.deleted': 'Override deleted.',
  'overrides.created': 'Override created.',
  'overrides.updated': 'Override saved.',
  'override.newTitle': 'New override',
  'override.editTitle': 'Edit override',
  'override.name': 'Name',
  'override.from': 'From',
  'override.to': 'To (included)',
  'override.allDay': 'All day',
  'override.startHour': 'From',
  'override.endHour': 'Until',
  'override.clock': 'Clock',
  'override.chooseClock': 'Choose a clock',
  'override.invalidRange': 'The override ends before it starts.',

  cancel: 'Cancel',
  create: 'Create',
  saveDialog: 'Save',
};

type GridMessageKey = keyof typeof en;

const fr: Record<GridMessageKey, string> = {
  title: 'Grille hebdomadaire',
  description:
    'L’horloge diffusée à chaque heure de la semaine. Choisissez une horloge, puis cliquez ou glissez sur les heures pour la peindre. Maj-clic peint le rectangle depuis la dernière heure cliquée.',
  stationTime: 'Heures de la station ({timezone}).',
  forbidden: 'Vous n’avez pas accès à la grille de cette station.',
  save: 'Enregistrer la grille',
  saved: 'Grille enregistrée.',
  discard: 'Annuler les modifications',
  conflict:
    'Quelqu’un a enregistré la grille pendant votre modification. Chargez sa version, ou gardez vos modifications et enregistrez-les à la place.',
  'conflict.load': 'Charger sa version',
  'conflict.loadConfirm': 'Charger sa version ? Vos modifications non enregistrées seront perdues.',
  'conflict.keep': 'Garder mes modifications',
  unknownClock: 'Certaines heures utilisent des horloges supprimées. Rechargez la grille.',
  incomplete: 'Choisissez une horloge par défaut ou peignez toutes les heures avant d’enregistrer.',
  noClocks: 'Aucune horloge. Créez d’abord une horloge, puis peignez-la sur la grille.',
  createClock: 'Créer une horloge',

  'brush.title': 'Peindre avec',
  'brush.default': 'Horloge par défaut',
  'brush.defaultHelp': 'Remet les heures sur l’horloge par défaut.',
  'default.label': 'Horloge par défaut',
  'default.help': 'Diffusée à toutes les heures non peintes.',
  'default.none': 'Aucune',
  'default.missing':
    '{count} heures n’ont pas d’horloge : choisissez une horloge par défaut (ou peignez toutes les heures) avant d’enregistrer.',
  'default.missingOne':
    '1 heure n’a pas d’horloge : choisissez une horloge par défaut avant d’enregistrer.',
  'touch.paint': 'Glisser pour peindre',
  'touch.help':
    'Sur un écran tactile, glisser fait défiler et toucher peint une heure. Activez ceci pour peindre en glissant.',

  'cell.label': '{day} {hour} : {clock}',
  'cell.default': 'par défaut ({clock})',
  'cell.none': 'aucune horloge',

  'dayparts.title': 'Tranches horaires',
  'dayparts.help':
    'Des plages d’heures nommées. Appliquez-en une pour peindre toutes ses heures avec l’horloge choisie.',
  'dayparts.empty': 'Aucune tranche horaire.',
  'dayparts.new': 'Nouvelle tranche',
  'dayparts.apply': 'Peindre',
  'dayparts.applyTo': 'Peindre {daypart} avec {clock}',
  'dayparts.applied': '{daypart} peinte. Enregistrez la grille pour la garder.',
  'dayparts.edit': 'Modifier',
  'dayparts.delete': 'Supprimer',
  'dayparts.deleteConfirm': 'Supprimer la tranche « {name} » ? La grille garde ses heures.',
  'dayparts.deleted': 'Tranche supprimée.',
  'dayparts.created': 'Tranche créée.',
  'dayparts.updated': 'Tranche enregistrée.',
  'dayparts.nameTaken': 'Une autre tranche porte déjà ce nom.',
  'daypart.newTitle': 'Nouvelle tranche horaire',
  'daypart.editTitle': 'Modifier la tranche horaire',
  'daypart.name': 'Nom',
  'daypart.days': 'Jours',
  'daypart.from': 'De',
  'daypart.to': 'À',
  'daypart.overnight': 'Continue après minuit sur le jour suivant.',
  'daypart.noDays': 'Choisissez au moins un jour.',

  'overrides.title': 'Exceptions',
  'overrides.help':
    'Des périodes qui remplacent la grille : vacances, semaines spéciales, soirées ponctuelles. Si deux se chevauchent, la plus courte l’emporte.',
  'overrides.empty': 'Aucune exception.',
  'overrides.new': 'Nouvelle exception',
  'overrides.past': 'Passée',
  'overrides.allDay': 'toute la journée',
  'overrides.edit': 'Modifier',
  'overrides.delete': 'Supprimer',
  'overrides.deleteConfirm': 'Supprimer l’exception « {name} » ?',
  'overrides.deleted': 'Exception supprimée.',
  'overrides.created': 'Exception créée.',
  'overrides.updated': 'Exception enregistrée.',
  'override.newTitle': 'Nouvelle exception',
  'override.editTitle': 'Modifier l’exception',
  'override.name': 'Nom',
  'override.from': 'Du',
  'override.to': 'Au (inclus)',
  'override.allDay': 'Toute la journée',
  'override.startHour': 'De',
  'override.endHour': 'Jusqu’à',
  'override.clock': 'Horloge',
  'override.chooseClock': 'Choisissez une horloge',
  'override.invalidRange': 'L’exception se termine avant de commencer.',

  cancel: 'Annuler',
  create: 'Créer',
  saveDialog: 'Enregistrer',
};

const messages: Record<Locale, Record<GridMessageKey, string>> = { en, fr };

export type GridT = (key: GridMessageKey, params?: Record<string, string | number>) => string;

/** The grid dictionary in the current locale, `{name}` placeholders included. */
export function useGridT(): GridT {
  const { locale } = useI18n();
  return (key, params) => {
    const template = messages[locale][key];
    if (!params) return template;
    return template.replace(/\{(\w+)\}/g, (match, name: string) =>
      name in params ? String(params[name]) : match,
    );
  };
}

/** An api error in words, for toasts and alerts. */
export function useGridError() {
  const t = useGridT();
  return (error: unknown): string => {
    if (isApiError(error, 'daypart_name_taken')) return t('dayparts.nameTaken');
    if (isApiError(error, 'unknown_clock')) return t('unknownClock');
    if (isApiError(error, 'incomplete_grid')) return t('incomplete');
    if (isApiError(error, 'invalid_range')) return t('override.invalidRange');
    return error instanceof Error ? error.message : String(error);
  };
}

/** Short weekday names, Monday first. */
export function weekdayNames(locale: Locale, width: 'short' | 'long' = 'short'): string[] {
  const f = new Intl.DateTimeFormat(locale, { weekday: width, timeZone: 'UTC' });
  // 2024-01-01 is a Monday.
  return Array.from({ length: 7 }, (_, i) => f.format(new Date(Date.UTC(2024, 0, 1 + i))));
}

/** Hours a range starts at, and ends at (exclusive: 24 is the end of the day). */
export const HOURS = Array.from({ length: 24 }, (_, hour) => hour);
export const END_HOURS = HOURS.map((hour) => hour + 1);

export const formatHour = (hour: number) => `${String(hour).padStart(2, '0')}:00`;
