import { useCallback } from 'react';
import { useI18n } from '../../../app/i18n/i18n.tsx';
import type { Locale } from '../../../app/i18n/messages.ts';

// Strings of the live recording settings page (#67), English and French. `fr` must have every key.

const en = {
  title: 'Live recording',
  description: 'Live shows are recorded and become their episode’s audio, ready for reruns.',
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
} as const;

export type LiveRecordingMessageKey = keyof typeof en;

const fr: Record<LiveRecordingMessageKey, string> = {
  title: 'Enregistrement des directs',
  description:
    'Les directs sont enregistrés et deviennent le son de leur épisode, prêt pour les rediffusions.',
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
