import { useCallback } from 'react';
import { useI18n } from '../../app/i18n/i18n.tsx';
import type { Locale } from '../../app/i18n/messages.ts';

// Strings of the VT recorder (#59), English and French. `fr` must have every key.

const en = {
  title: 'Record a VT',
  'title.segue': 'Record a VT for this segue',
  'back.segue': 'Back to the segue',
  'back.library': 'Library',
  notFound: 'This transition is no longer in the log.',
  forbidden: 'You can’t record voice tracks on this station.',

  'mic.title': 'Microphone',
  'mic.allow': 'Use the microphone',
  'mic.device': 'Input',
  'mic.default': 'Default input',
  'mic.level': 'Input level',
  'mic.headphones': 'Wear headphones: the music plays while you record and must not reach the mic.',
  'mic.denied':
    'The microphone is blocked. Allow it in the browser’s settings for this site, then try again.',
  'mic.unsupported':
    'This browser can’t record audio here. Use a recent Chrome, Firefox or Safari over HTTPS.',
  'mic.error': 'The microphone could not be opened: {reason}',

  'record.preroll': 'Pre-roll',
  'record.prerollHint': '{seconds} s of the outgoing song before the transition',
  'record.start': 'Record',
  'record.stop': 'Stop',
  'record.retake': 'Retake',
  'record.recording': 'Recording {time}',
  'record.loading': 'Loading the music…',
  'record.noMusic': 'The music of this segue isn’t ready yet: you can record without pre-roll.',
  'record.audioError': 'The music could not be loaded for the pre-roll.',

  'take.title': 'Take',
  'take.trim': 'Trim the take: drag the In and Out handles.',
  'take.in': 'In',
  'take.out': 'Out',
  'take.inTitle': 'Start of the kept part',
  'take.outTitle': 'End of the kept part',
  'take.length': '{length} kept of {total}',
  'take.play': 'Play the take',
  'take.playMusic': 'Play over the music',
  'take.stop': 'Stop',
  'take.waveform': 'Take waveform',
  'take.empty': 'Nothing was recorded. Check the input level and record again.',
  'take.clipping': 'The take clips: lower the input gain and record again for a cleaner voice.',
  'take.quiet':
    'The take is very quiet: its loudness is raised on air, along with the noise. Move closer or raise the input gain.',
  'take.loudness':
    'Loudness is measured after the upload and brought to the station’s loudness target on air, as for every asset.',

  'save.name': 'Name',
  'save.defaultName': 'VT {from} → {to}',
  'save.defaultStandalone': 'VT {date} {time}',
  'save.place': 'Upload and place',
  'save.library': 'Upload to the library',
  'save.uploading': 'Uploading… {pct} %',
  'save.processing': 'Processing the audio…',
  'save.placed': 'Take uploaded: place it, then save the segue.',
  'save.done': 'Take uploaded to the library.',
  'save.error': 'The take could not be uploaded: {reason}',
  'save.stillProcessing':
    'The take is uploaded but still processing. It will appear in the library; add it to the segue from there.',
};

export type VtMessageKey = keyof typeof en;

const fr: Record<VtMessageKey, string> = {
  title: 'Enregistrer une voix',
  'title.segue': 'Enregistrer une voix pour cet enchaînement',
  'back.segue': 'Retour à l’enchaînement',
  'back.library': 'Médiathèque',
  notFound: 'Cette transition n’est plus dans le conducteur.',
  forbidden: 'Vous ne pouvez pas enregistrer de voix sur cette station.',

  'mic.title': 'Micro',
  'mic.allow': 'Utiliser le micro',
  'mic.device': 'Entrée',
  'mic.default': 'Entrée par défaut',
  'mic.level': 'Niveau d’entrée',
  'mic.headphones':
    'Mettez un casque : la musique joue pendant l’enregistrement et ne doit pas repasser dans le micro.',
  'mic.denied':
    'Le micro est bloqué. Autorisez-le dans les réglages du navigateur pour ce site, puis réessayez.',
  'mic.unsupported':
    'Ce navigateur ne peut pas enregistrer ici. Utilisez un Chrome, Firefox ou Safari récent en HTTPS.',
  'mic.error': 'Le micro n’a pas pu être ouvert : {reason}',

  'record.preroll': 'Pré-écoute',
  'record.prerollHint': '{seconds} s du morceau sortant avant la transition',
  'record.start': 'Enregistrer',
  'record.stop': 'Arrêter',
  'record.retake': 'Refaire',
  'record.recording': 'Enregistrement {time}',
  'record.loading': 'Chargement de la musique…',
  'record.noMusic':
    'La musique de cet enchaînement n’est pas encore prête : vous pouvez enregistrer sans pré-écoute.',
  'record.audioError': 'La musique n’a pas pu être chargée pour la pré-écoute.',

  'take.title': 'Prise',
  'take.trim': 'Coupez la prise : faites glisser les poignées Début et Fin.',
  'take.in': 'Début',
  'take.out': 'Fin',
  'take.inTitle': 'Début de la partie gardée',
  'take.outTitle': 'Fin de la partie gardée',
  'take.length': '{length} gardées sur {total}',
  'take.play': 'Écouter la prise',
  'take.playMusic': 'Écouter sur la musique',
  'take.stop': 'Arrêter',
  'take.waveform': 'Forme d’onde de la prise',
  'take.empty': 'Rien n’a été enregistré. Vérifiez le niveau d’entrée et recommencez.',
  'take.clipping':
    'La prise sature : baissez le gain d’entrée et recommencez pour une voix plus propre.',
  'take.quiet':
    'La prise est très faible : son volume est remonté à l’antenne, le bruit avec. Rapprochez-vous ou montez le gain d’entrée.',
  'take.loudness':
    'Le volume est mesuré après l’envoi et ramené à la cible de volume de la station à l’antenne, comme pour tout fichier.',

  'save.name': 'Nom',
  'save.defaultName': 'Voix {from} → {to}',
  'save.defaultStandalone': 'Voix {date} {time}',
  'save.place': 'Envoyer et placer',
  'save.library': 'Envoyer dans la médiathèque',
  'save.uploading': 'Envoi… {pct} %',
  'save.processing': 'Traitement de l’audio…',
  'save.placed': 'Prise envoyée : placez-la, puis enregistrez l’enchaînement.',
  'save.done': 'Prise envoyée dans la médiathèque.',
  'save.error': 'La prise n’a pas pu être envoyée : {reason}',
  'save.stillProcessing':
    'La prise est envoyée mais encore en traitement. Elle apparaîtra dans la médiathèque ; ajoutez-la à l’enchaînement depuis là.',
};

const messages: Record<Locale, Record<VtMessageKey, string>> = { en, fr };

export type VtT = (key: VtMessageKey, params?: Record<string, string | number>) => string;

/** `t` for the VT recorder's strings, in the app's current locale. */
export function useVtT(): VtT {
  const { locale } = useI18n();
  return useCallback(
    (key: VtMessageKey, params?: Record<string, string | number>) =>
      messages[locale][key].replace(/\{(\w+)\}/g, (match, name: string) =>
        params && name in params ? String(params[name]) : match,
      ),
    [locale],
  );
}
