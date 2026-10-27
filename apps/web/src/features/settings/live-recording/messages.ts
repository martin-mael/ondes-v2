import { useCallback } from 'react';
import { useI18n } from '../../../app/i18n/i18n.tsx';
import type { Locale } from '../../../app/i18n/messages.ts';

// Strings of live recording (#67): the settings page and the episode's recording section,
// English and French. `fr` must have every key.

const en = {
  title: 'Live recording',
  description:
    'Every live show is recorded from the station’s output and becomes its episode’s audio, ready for reruns a few minutes after the show.',
  readOnly: 'Only station managers can change these.',
  'enabled.label': 'Record live shows',
  'enabled.hint': 'Off: live shows aren’t kept. The engine’s files are deleted after a day.',
  'retention.label': 'Keep the audio',
  'retention.hint':
    'Counted from the end of the show. After that the episode stays, without audio. Audio still planned in the log is kept until it aired.',
  'retention.forever': 'For good',
  'retention.days': '{days} days',
  'retention.custom': 'Another number of days',
  'retention.customLabel': 'Days',
  'retention.invalid': 'Enter 1 to 3650 days. The retention stays as it is until then.',
  saved: 'Live recording settings saved',
  save: 'Save',

  'episode.title': 'Live recording',
  'episode.none':
    'Not recorded: nobody went on air in this episode yet, or it aired before recording was on.',
  'episode.status.recording': 'Recording now',
  'episode.status.pending': 'Waiting to be processed',
  'episode.status.processing': 'Processing',
  'episode.status.ready': 'Ready for reruns',
  'episode.status.failed': 'Failed',
  'episode.status.expired': 'Deleted by the retention policy',
  'episode.status.skipped': 'Not kept: recording is off',
  'episode.parts': '{count} parts joined (the DJ reconnected or handed over)',
  'episode.duration': '{duration} of audio',
  'episode.builtIn': 'processed in {seconds} s',
  'episode.expires': 'Audio deleted after {date}',
  'episode.rebuild': 'Process again',
  'episode.rebuilt': 'The recording is processed again',
} as const;

export type LiveRecordingMessageKey = keyof typeof en;

const fr: Record<LiveRecordingMessageKey, string> = {
  title: 'Enregistrement des directs',
  description:
    'Chaque émission en direct est enregistrée depuis la sortie de la station et devient le son de son épisode, prêt pour les rediffusions quelques minutes après l’émission.',
  readOnly: 'Seuls les responsables de la station peuvent les modifier.',
  'enabled.label': 'Enregistrer les directs',
  'enabled.hint':
    'Désactivé : les directs ne sont pas conservés. Les fichiers du moteur sont supprimés au bout d’un jour.',
  'retention.label': 'Conserver le son',
  'retention.hint':
    'À partir de la fin de l’émission. Ensuite l’épisode reste, sans son. Un son encore prévu au conducteur est gardé jusqu’à sa diffusion.',
  'retention.forever': 'Pour toujours',
  'retention.days': '{days} jours',
  'retention.custom': 'Un autre nombre de jours',
  'retention.customLabel': 'Jours',
  'retention.invalid': 'Indiquez de 1 à 3650 jours. La conservation reste inchangée d’ici là.',
  saved: 'Réglages d’enregistrement enregistrés',
  save: 'Enregistrer',

  'episode.title': 'Enregistrement du direct',
  'episode.none':
    'Pas d’enregistrement : personne n’est encore passé à l’antenne dans cet épisode, ou il a été diffusé avant l’activation.',
  'episode.status.recording': 'Enregistrement en cours',
  'episode.status.pending': 'En attente de traitement',
  'episode.status.processing': 'Traitement en cours',
  'episode.status.ready': 'Prêt pour les rediffusions',
  'episode.status.failed': 'Échec',
  'episode.status.expired': 'Supprimé par la durée de conservation',
  'episode.status.skipped': 'Non conservé : l’enregistrement est désactivé',
  'episode.parts': '{count} parties assemblées (reconnexion ou passage de relais)',
  'episode.duration': '{duration} de son',
  'episode.builtIn': 'traité en {seconds} s',
  'episode.expires': 'Son supprimé après le {date}',
  'episode.rebuild': 'Retraiter',
  'episode.rebuilt': 'L’enregistrement est retraité',
};

const messages: Record<Locale, Record<LiveRecordingMessageKey, string>> = { en, fr };

/** `t` for live recording strings, in the app's current locale. */
export function useLiveRecordingT() {
  const { locale } = useI18n();
  return useCallback(
    (key: LiveRecordingMessageKey, params?: Record<string, string | number>) =>
      messages[locale][key].replace(/\{(\w+)\}/g, (match, name: string) =>
        params && name in params ? String(params[name]) : match,
      ),
    [locale],
  );
}
