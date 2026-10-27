import { useCallback } from 'react';
import { useI18n } from '../../app/i18n/i18n.tsx';
import type { Locale } from '../../app/i18n/messages.ts';

// Strings of the segue editor (#58), English and French. `fr` must have every key.

const en = {
  title: 'Segue',
  description: 'Place the voice, shape the ducking and set where the next song comes in.',
  back: 'Back to the log',
  notFound: 'This transition is no longer in the log.',
  notTransition: 'Only two songs, voice tracks, jingles or beds in a row can have a segue.',
  noMedia: '{title} has no playout copy yet: it can’t be edited until it is ingested.',
  forbidden: 'You can’t voice-track this transition.',

  'lane.out': 'Outgoing',
  'lane.in': 'Incoming',
  'lane.voice': 'Voice {n}',
  'lane.noPeaks': 'No waveform yet',
  'lane.drag': 'Drag to move {title}',
  'lane.remove': 'Remove voice {n}',
  'lane.gain': 'Gain (dB)',
  'lane.point': 'Envelope point at {time}, {gain}',

  'toolbar.play': 'Play from cursor',
  'toolbar.playBefore': 'Play {seconds} s before the transition',
  'toolbar.stop': 'Stop',
  'toolbar.preroll': 'Pre-roll',
  'toolbar.undo': 'Undo',
  'toolbar.redo': 'Redo',
  'toolbar.zoomIn': 'Zoom in',
  'toolbar.zoomOut': 'Zoom out',
  'toolbar.fit': 'Show the whole transition',
  'toolbar.addVoice': 'Add a voice',
  'toolbar.record': 'Record a VT',
  'record.full':
    'This segue already has 4 voices: the take is in the library, remove a voice to place it.',
  'toolbar.presets': 'Envelopes',
  'toolbar.save': 'Save',
  'toolbar.loading': 'Loading the audio…',

  'preset.duck': 'Duck under the voice: {depth} dB, {ramp} ms ramps',
  'preset.fadeOut': 'Fade out the outgoing song (2 s)',
  'preset.auto': 'Auto placement (voices, next start and ducking)',
  'preset.clear': 'Clear every envelope',

  'cursor.at': 'Cursor {offset} · on air ≈ {time}',
  'incoming.at': 'Next starts {offset} · on air ≈ {time}',
  'timing.unknown': 'Planned time unknown',
  'overview.label': 'Whole transition',
  'ruler.label': 'Time from the end of the outgoing song',
  hint: 'Drag a lane to move it, drag a point to shape it. Double-click adds a point, Delete removes the selected one. Pinch or ⌘/Ctrl + scroll to zoom, scroll sideways to pan, Space plays.',

  'status.new': 'Not saved yet',
  'status.ready': 'Ready',
  'status.waiting': 'Waiting for audio',
  'status.detached': 'Detached',
  'status.invalid': 'Invalid',
  'island.pending': 'Island: waiting to render',
  'island.rendering': 'Island: rendering',
  'island.ready': 'Island: rendered',
  'island.failed': 'Island: render failed',
  'island.none': 'No island: airs as a crossfade',

  'problem.title': 'This segue can’t be rendered',
  'saved.toast': 'Segue saved: its island will render now',
  'conflict.title': 'Someone saved this segue meanwhile',
  'conflict.body':
    'Your changes are still here. Keep editing yours (saving replaces theirs), or load theirs: Undo brings yours back.',
  'conflict.keep': 'Keep mine',
  'conflict.load': 'Load theirs',
  'save.error': 'The segue couldn’t be saved: {reason}',
  'audio.error': 'The audio couldn’t be loaded for the preview.',
  'voice.pick': 'Add a voice',
};

export type SegueMessageKey = keyof typeof en;

const fr: Record<SegueMessageKey, string> = {
  title: 'Enchaînement',
  description: 'Placez la voix, réglez l’atténuation et choisissez où démarre le titre suivant.',
  back: 'Retour au conducteur',
  notFound: 'Cet enchaînement n’est plus dans le conducteur.',
  notTransition:
    'Seuls deux titres, voice tracks, jingles ou tapis consécutifs peuvent avoir un enchaînement.',
  noMedia: '{title} n’a pas encore de copie de diffusion : modifiable une fois importé.',
  forbidden: 'Vous ne pouvez pas faire de voice track sur cet enchaînement.',

  'lane.out': 'Sortant',
  'lane.in': 'Entrant',
  'lane.voice': 'Voix {n}',
  'lane.noPeaks': 'Pas encore de forme d’onde',
  'lane.drag': 'Glisser pour déplacer {title}',
  'lane.remove': 'Retirer la voix {n}',
  'lane.gain': 'Gain (dB)',
  'lane.point': 'Point d’enveloppe à {time}, {gain}',

  'toolbar.play': 'Écouter depuis le curseur',
  'toolbar.playBefore': 'Écouter {seconds} s avant l’enchaînement',
  'toolbar.stop': 'Arrêter',
  'toolbar.preroll': 'Pré-écoute',
  'toolbar.undo': 'Annuler',
  'toolbar.redo': 'Rétablir',
  'toolbar.zoomIn': 'Zoom avant',
  'toolbar.zoomOut': 'Zoom arrière',
  'toolbar.fit': 'Voir tout l’enchaînement',
  'toolbar.addVoice': 'Ajouter une voix',
  'toolbar.record': 'Enregistrer une voix',
  'record.full':
    'Cet enchaînement a déjà 4 voix : la prise est dans la médiathèque, retirez une voix pour la placer.',
  'toolbar.presets': 'Enveloppes',
  'toolbar.save': 'Enregistrer',
  'toolbar.loading': 'Chargement de l’audio…',

  'preset.duck': 'Atténuer sous la voix : {depth} dB, rampes de {ramp} ms',
  'preset.fadeOut': 'Fondu de sortie du titre sortant (2 s)',
  'preset.auto': 'Placement automatique (voix, titre suivant et atténuation)',
  'preset.clear': 'Effacer toutes les enveloppes',

  'cursor.at': 'Curseur {offset} · à l’antenne ≈ {time}',
  'incoming.at': 'Le suivant démarre {offset} · à l’antenne ≈ {time}',
  'timing.unknown': 'Heure prévue inconnue',
  'overview.label': 'Tout l’enchaînement',
  'ruler.label': 'Temps depuis la fin du titre sortant',
  hint: 'Glissez une piste pour la déplacer, un point pour la modeler. Double-clic : ajouter un point ; Suppr : retirer le point choisi. Pincez ou ⌘/Ctrl + défilement pour zoomer, défilement horizontal pour vous déplacer, Espace pour écouter.',

  'status.new': 'Pas encore enregistré',
  'status.ready': 'Prêt',
  'status.waiting': 'En attente de l’audio',
  'status.detached': 'Détaché',
  'status.invalid': 'Invalide',
  'island.pending': 'Îlot : en attente de rendu',
  'island.rendering': 'Îlot : rendu en cours',
  'island.ready': 'Îlot : rendu',
  'island.failed': 'Îlot : échec du rendu',
  'island.none': 'Pas d’îlot : diffusé en fondu enchaîné',

  'problem.title': 'Cet enchaînement ne peut pas être rendu',
  'saved.toast': 'Enchaînement enregistré : son îlot va être rendu',
  'conflict.title': 'Quelqu’un a enregistré cet enchaînement entre-temps',
  'conflict.body':
    'Vos modifications sont toujours là. Continuez avec les vôtres (enregistrer remplace les siennes) ou chargez les siennes : Annuler ramène les vôtres.',
  'conflict.keep': 'Garder les miennes',
  'conflict.load': 'Charger les siennes',
  'save.error': 'L’enchaînement n’a pas pu être enregistré : {reason}',
  'audio.error': 'L’audio n’a pas pu être chargé pour l’écoute.',
  'voice.pick': 'Ajouter une voix',
};

const messages: Record<Locale, Record<SegueMessageKey, string>> = { en, fr };

export type SegueT = (key: SegueMessageKey, params?: Record<string, string | number>) => string;

/** `t` for the segue editor's strings, in the app's current locale. */
export function useSegueT(): SegueT {
  const { locale } = useI18n();
  return useCallback(
    (key: SegueMessageKey, params?: Record<string, string | number>) =>
      messages[locale][key].replace(/\{(\w+)\}/g, (match, name: string) =>
        params && name in params ? String(params[name]) : match,
      ),
    [locale],
  );
}
