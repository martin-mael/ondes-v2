import { useI18n } from '../../../app/i18n/i18n.tsx';
import type { Locale } from '../../../app/i18n/messages.ts';

// On-air strings (#70), English and French. `fr` must have `en`'s keys.

const en = {
  title: 'On air',
  stationTime: 'Station time ({timezone})',
  'mode.label': 'Mode',
  'mode.automation': 'Automation',
  'mode.show': 'Show (pre-recorded)',
  'mode.live': 'Live: {name}',
  'mode.liveUnknown': 'Live',
  'mode.safety': 'Safety',
  'mode.emergency': 'Emergency',
  'mode.off_air': 'Off air',

  'now.title': 'Now playing',
  'now.nothing': 'Nothing is on air.',
  'now.untitled': 'Untitled',
  'now.live': 'Live from the studio',
  'now.safety': 'Safety playlist',
  'now.emergency': 'Emergency file',
  'now.elapsed': 'Elapsed',
  'now.remaining': 'Remaining',
  'now.intro': 'Intro ends',
  'now.outro': 'Outro starts',
  'now.progress': 'Progress',

  'next.title': 'Up next',
  'next.empty': 'Nothing planned in the published log.',
  'next.estimated': 'Estimated start',
  'next.hard': 'Hard start',
  'next.soft': 'Soft start',
  'next.not_before': 'Not before',

  'event.title': 'Next fixed event',
  'event.show': 'Show',
  'event.hard_start': 'Hard start',
  'event.soft_start': 'Soft start',
  'event.marker': 'Marker',
  'event.none': 'None in the next 24 hours.',
  'event.at': 'at {time}',

  'show.title': 'Show block',
  'show.none': 'No show right now.',
  'show.episode': 'Episode {number}',
  'show.rerun': 'Rerun',
  'show.range': '{from} – {to}',
  'show.type.prerecorded': 'Pre-recorded',
  'show.type.live': 'Live',
  'show.type.rerun': 'Rerun',

  'kind.song': 'Song',
  'kind.vt': 'Voice track',
  'kind.jingle': 'Jingle',
  'kind.bed': 'Bed',
  'kind.episode': 'Episode',
  'kind.live_slot': 'Live',
  'kind.marker': 'Marker',
  'kind.fill': 'Fill',
  'kind.segment': 'Island',

  error: 'Couldn’t load what’s on air.',
};

const fr: typeof en = {
  title: 'À l’antenne',
  stationTime: 'Heure de la station ({timezone})',
  'mode.label': 'Mode',
  'mode.automation': 'Automatisation',
  'mode.show': 'Émission (préenregistrée)',
  'mode.live': 'Direct : {name}',
  'mode.liveUnknown': 'Direct',
  'mode.safety': 'Secours',
  'mode.emergency': 'Urgence',
  'mode.off_air': 'Hors antenne',

  'now.title': 'En cours',
  'now.nothing': 'Rien à l’antenne.',
  'now.untitled': 'Sans titre',
  'now.live': 'En direct du studio',
  'now.safety': 'Playlist de secours',
  'now.emergency': 'Fichier d’urgence',
  'now.elapsed': 'Écoulé',
  'now.remaining': 'Restant',
  'now.intro': 'Fin de l’intro',
  'now.outro': 'Début de l’outro',
  'now.progress': 'Progression',

  'next.title': 'À suivre',
  'next.empty': 'Rien de prévu dans le conducteur publié.',
  'next.estimated': 'Début estimé',
  'next.hard': 'Début fixe',
  'next.soft': 'Début souple',
  'next.not_before': 'Pas avant',

  'event.title': 'Prochain horaire fixe',
  'event.show': 'Émission',
  'event.hard_start': 'Début fixe',
  'event.soft_start': 'Début souple',
  'event.marker': 'Repère',
  'event.none': 'Aucun dans les prochaines 24 heures.',
  'event.at': 'à {time}',

  'show.title': 'Émission',
  'show.none': 'Pas d’émission en ce moment.',
  'show.episode': 'Épisode {number}',
  'show.rerun': 'Rediffusion',
  'show.range': '{from} – {to}',
  'show.type.prerecorded': 'Préenregistrée',
  'show.type.live': 'Direct',
  'show.type.rerun': 'Rediffusion',

  'kind.song': 'Titre',
  'kind.vt': 'Voix enregistrée',
  'kind.jingle': 'Jingle',
  'kind.bed': 'Tapis',
  'kind.episode': 'Épisode',
  'kind.live_slot': 'Direct',
  'kind.marker': 'Repère',
  'kind.fill': 'Remplissage',
  'kind.segment': 'Îlot',

  error: 'Impossible de charger ce qui est à l’antenne.',
};

export type OnAirMessageKey = keyof typeof en;
const messages: Record<Locale, Record<OnAirMessageKey, string>> = { en, fr };

export type OnAirT = (key: OnAirMessageKey, params?: Record<string, string | number>) => string;

/** The on-air dictionary in the current locale, `{name}` placeholders included. */
export function useOnAirT(): OnAirT {
  const { locale } = useI18n();
  return (key, params) => {
    const template = messages[locale][key];
    if (!params) return template;
    return template.replace(/\{(\w+)\}/g, (match, name: string) =>
      name in params ? String(params[name]) : match,
    );
  };
}
