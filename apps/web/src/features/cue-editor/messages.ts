import { useCallback } from 'react';
import { useI18n } from '../../app/i18n/i18n.tsx';
import type { Locale } from '../../app/i18n/messages.ts';

// Strings of the cue editor (#24), English and French. `fr` must have every key.

const en = {
  waveform: 'Waveform of {title}',
  'peaks.missing': 'The waveform is not ready yet (analysis pending). Cue points are listed below.',
  'peaks.error': "The waveform couldn't be loaded.",

  'field.cueIn': 'Cue in',
  'field.cueOut': 'Cue out',
  'field.introEnd': 'Intro end',
  'field.outroStart': 'Outro start',
  'field.fadeIn': 'Fade in',
  'field.fadeOut': 'Fade out',
  'field.crossStartNext': 'Next track starts',
  'short.cueIn': 'In',
  'short.cueOut': 'Out',
  'short.introEnd': 'Intro',
  'short.outroStart': 'Outro',
  'short.crossStartNext': 'Next',

  'point.unset': 'Not set',
  'point.auto': 'auto',
  'point.manual': 'manual',
  'point.edited': 'edited',
  'point.lock': 'Lock {field}: autocue leaves it alone',
  'point.unlock': 'Unlock {field}',
  'point.play': 'Play from {field}',
  'point.here': 'Set {field} at the playhead (or the clicked position)',
  'point.clear': 'Clear {field}',
  'point.show': 'Show {field}',
  'point.locked': '{field} is locked',

  'zoom.in': 'Zoom in',
  'zoom.out': 'Zoom out',
  'zoom.all': 'Whole track',
  'zoom.hint': 'Wheel to zoom, Shift + wheel to scroll. Drag a marker, or focus it and use ← →.',
  'keys.hint': 'With the waveform focused: Space plays or stops, ← → scroll, ↑ ↓ zoom.',
  'keys.region': 'Waveform: Space plays or stops, arrows scroll and zoom',

  'play.start': 'Play from cue in',
  'play.cursor': 'Play from the cursor',
  'play.stop': 'Stop',
  'play.error': "The audio couldn't be played.",
  'play.noAudio': 'No playout copy yet: nothing to play.',

  'next.label': 'Next track',
  'next.random': 'Random',
  'next.pick': 'Choose a track…',
  'next.preview': 'Preview the transition',
  'next.none': 'No other song with audio in the library.',
  'next.noMatch': 'No song matches.',
  'next.search': 'Search songs',
  'next.noAudio': 'This track has no playout copy any more: pick another one.',
  'next.more': 'More songs match: type to narrow the list, or draw one at random.',

  save: 'Save cue points',
  reset: 'Discard changes',
  saved: 'Cue points saved. They reach the engine the next time the track is queued.',
  'save.error': "The cue points couldn't be saved.",
  readOnly: "You can listen, but you don't have the right to edit cue points.",
  analyzer: 'Analyser: {version}',
  unsaved: 'Unsaved changes',
  'section.points': 'Cue points',
  'section.transition': 'Transition preview',

  'page.back': 'Back to the library',
  'page.notFound': 'This track is not in the library.',
  'summary.edit': 'Edit cues',
  'summary.waveform': 'Waveform of {title} with its cue points',
  'summary.none': 'Not analysed yet.',
} as const;

export type CueEditorMessageKey = keyof typeof en;

const fr: Record<CueEditorMessageKey, string> = {
  waveform: 'Forme d’onde de {title}',
  'peaks.missing':
    'La forme d’onde n’est pas encore prête (analyse en cours). Les points de cue sont listés ci-dessous.',
  'peaks.error': 'La forme d’onde n’a pas pu être chargée.',

  'field.cueIn': 'Entrée',
  'field.cueOut': 'Sortie',
  'field.introEnd': "Fin d'intro",
  'field.outroStart': "Début d'outro",
  'field.fadeIn': 'Fondu entrant',
  'field.fadeOut': 'Fondu sortant',
  'field.crossStartNext': 'Départ du suivant',
  'short.cueIn': 'Entrée',
  'short.cueOut': 'Sortie',
  'short.introEnd': 'Intro',
  'short.outroStart': 'Outro',
  'short.crossStartNext': 'Suivant',

  'point.unset': 'Non défini',
  'point.auto': 'auto',
  'point.manual': 'manuel',
  'point.edited': 'modifié',
  'point.lock': 'Verrouiller {field} : l’autocue n’y touche plus',
  'point.unlock': 'Déverrouiller {field}',
  'point.play': 'Écouter depuis {field}',
  'point.here': 'Placer {field} à la tête de lecture',
  'point.clear': 'Effacer {field}',
  'point.show': 'Afficher {field}',
  'point.locked': '{field} est verrouillé',

  'zoom.in': 'Zoomer',
  'zoom.out': 'Dézoomer',
  'zoom.all': 'Tout le morceau',
  'zoom.hint':
    'Molette pour zoomer, Maj + molette pour défiler. Faites glisser un repère, ou sélectionnez-le et utilisez ← →.',
  'keys.hint':
    'Forme d’onde sélectionnée : Espace lance ou arrête l’écoute, ← → font défiler, ↑ ↓ zooment.',
  'keys.region': 'Forme d’onde : Espace pour écouter ou arrêter, flèches pour défiler et zoomer',

  'play.start': "Écouter depuis l'entrée",
  'play.cursor': 'Écouter depuis le curseur',
  'play.stop': 'Arrêter',
  'play.error': 'Le son n’a pas pu être lu.',
  'play.noAudio': 'Pas encore de copie de diffusion : rien à écouter.',

  'next.label': 'Morceau suivant',
  'next.random': 'Au hasard',
  'next.pick': 'Choisir un morceau…',
  'next.preview': 'Écouter l’enchaînement',
  'next.none': 'Aucun autre morceau écoutable dans la bibliothèque.',
  'next.noMatch': 'Aucun morceau ne correspond.',
  'next.search': 'Chercher un morceau',
  'next.noAudio': 'Ce morceau n’a plus de copie de diffusion : choisissez-en un autre.',
  'next.more':
    'D’autres morceaux correspondent : tapez pour affiner la liste, ou tirez-en un au hasard.',

  save: 'Enregistrer les cues',
  reset: 'Annuler les modifications',
  saved:
    'Points de cue enregistrés. Le moteur les reçoit la prochaine fois que le morceau est mis en file.',
  'save.error': 'Les points de cue n’ont pas pu être enregistrés.',
  readOnly: 'Vous pouvez écouter, mais pas modifier les points de cue.',
  analyzer: 'Analyseur : {version}',
  unsaved: 'Modifications non enregistrées',
  'section.points': 'Points de cue',
  'section.transition': 'Écoute de l’enchaînement',

  'page.back': 'Retour à la bibliothèque',
  'page.notFound': 'Ce morceau n’est pas dans la bibliothèque.',
  'summary.edit': 'Éditer les points',
  'summary.waveform': 'Forme d’onde de {title} avec ses points de cue',
  'summary.none': 'Pas encore analysé.',
};

const messages: Record<Locale, Record<CueEditorMessageKey, string>> = { en, fr };

export type CueEditorT = (
  key: CueEditorMessageKey,
  params?: Record<string, string | number>,
) => string;

export function useCueEditorT(): CueEditorT {
  const { locale } = useI18n();
  return useCallback(
    (key, params) =>
      messages[locale][key].replace(/\{(\w+)\}/g, (match, name: string) =>
        params && name in params ? String(params[name]) : match,
      ),
    [locale],
  );
}
