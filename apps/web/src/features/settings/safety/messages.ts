import { useCallback } from 'react';
import { useI18n } from '../../../app/i18n/i18n.tsx';
import type { Locale } from '../../../app/i18n/messages.ts';

// Strings of the safety settings page (#34), English and French. `fr` must have every key.

const en = {
  title: 'Safety & emergency',
  description:
    'What the station plays when the log runs dry or its files aren’t ready: the safety playlist first, then the emergency file on a loop.',
  'onAir.safety': 'Safety mode: safety playlist on air',
  'onAir.emergency': 'Safety mode: emergency file on air',
  'onAir.normal': 'On schedule',
  'onAir.since': 'since {time}',
  syncedAt: 'Engine cache synced {time}',
  neverSynced: 'Not synced to the engine yet',
  readOnly: 'Only station managers can change these.',

  'emergency.title': 'Emergency file',
  'emergency.description':
    'Looped when there is nothing else to play. It also feeds the listeners’ fallback stream.',
  'emergency.none': 'No emergency file: the station goes silent if the safety playlist is empty.',
  'emergency.choose': 'Choose from library',
  'emergency.upload': 'Upload a file',
  'emergency.clear': 'Remove',
  'emergency.uploading': 'Uploading {name}… {pct}%',
  'emergency.processing': 'Processing {name}…',
  'emergency.uploadFailed': 'Upload failed: {reason}',
  'emergency.set': 'Emergency file updated',
  'emergency.previous':
    'The engine still loops the previous emergency file: this one isn’t in its cache yet.',

  'safety.title': 'Safety playlist',
  'safety.description':
    'Played in random order when the log runs dry. Kept in the engine’s cache for good.',
  'safety.summary': '{ready} of {total} ready in the engine · {duration}',
  'safety.empty': 'No safety playlist yet. Add a few hours of evergreen tracks.',
  'safety.add': 'Add tracks',
  'safety.addByTag': 'Add by tag',
  'safety.remove': 'Remove {title} from the safety playlist',
  'safety.added': '{count} tracks added',

  'col.title': 'Title',
  'col.duration': 'Duration',
  'col.status': 'In the engine',

  'state.ready': 'Ready',
  'state.pending': 'Syncing',
  'state.failed': 'Failed',
  'state.no_file': 'No audio file',

  'picker.title': 'Add from the library',
  'picker.titleSingle': 'Choose the emergency file',
  'picker.search': 'Search title, artist or album',
  'picker.noResults': 'No matching asset.',
  'picker.confirm': 'Add {count}',
  'picker.choose': 'Choose',

  'tag.title': 'Add every track with a tag',
  'tag.description': 'Adds the tracks that have the tag now; tracks tagged later aren’t added.',
  'tag.key': 'Tag',
  'tag.value': 'Value',
  'tag.confirm': 'Add',

  'error.safety_playlist_full': 'A safety playlist holds at most 1000 tracks.',
} as const;

export type SafetyMessageKey = keyof typeof en;

const fr: Record<SafetyMessageKey, string> = {
  title: 'Secours et urgence',
  description:
    'Ce que la station diffuse quand le conducteur est vide ou que ses fichiers ne sont pas prêts : d’abord la playlist de secours, puis le fichier d’urgence en boucle.',
  'onAir.safety': 'Mode secours : playlist de secours à l’antenne',
  'onAir.emergency': 'Mode secours : fichier d’urgence à l’antenne',
  'onAir.normal': 'Programme normal',
  'onAir.since': 'depuis {time}',
  syncedAt: 'Cache du moteur synchronisé {time}',
  neverSynced: 'Pas encore synchronisé avec le moteur',
  readOnly: 'Seuls les responsables de la station peuvent les modifier.',

  'emergency.title': 'Fichier d’urgence',
  'emergency.description':
    'Diffusé en boucle quand il n’y a rien d’autre. Il sert aussi de flux de repli aux auditeurs.',
  'emergency.none':
    'Aucun fichier d’urgence : la station devient silencieuse si la playlist de secours est vide.',
  'emergency.choose': 'Choisir dans la bibliothèque',
  'emergency.upload': 'Envoyer un fichier',
  'emergency.clear': 'Retirer',
  'emergency.uploading': 'Envoi de {name}… {pct} %',
  'emergency.processing': 'Traitement de {name}…',
  'emergency.uploadFailed': 'Échec de l’envoi : {reason}',
  'emergency.set': 'Fichier d’urgence mis à jour',
  'emergency.previous':
    'Le moteur diffuse encore l’ancien fichier d’urgence : celui-ci n’est pas encore dans son cache.',

  'safety.title': 'Playlist de secours',
  'safety.description':
    'Diffusée dans un ordre aléatoire quand le conducteur est vide. Conservée en permanence dans le cache du moteur.',
  'safety.summary': '{ready} sur {total} prêts dans le moteur · {duration}',
  'safety.empty':
    'Pas encore de playlist de secours. Ajoutez quelques heures de titres intemporels.',
  'safety.add': 'Ajouter des titres',
  'safety.addByTag': 'Ajouter par tag',
  'safety.remove': 'Retirer {title} de la playlist de secours',
  'safety.added': '{count} titres ajoutés',

  'col.title': 'Titre',
  'col.duration': 'Durée',
  'col.status': 'Dans le moteur',

  'state.ready': 'Prêt',
  'state.pending': 'En cours',
  'state.failed': 'Échec',
  'state.no_file': 'Aucun fichier audio',

  'picker.title': 'Ajouter depuis la bibliothèque',
  'picker.titleSingle': 'Choisir le fichier d’urgence',
  'picker.search': 'Rechercher un titre, un artiste, un album',
  'picker.noResults': 'Aucun élément trouvé.',
  'picker.confirm': 'Ajouter {count}',
  'picker.choose': 'Choisir',

  'tag.title': 'Ajouter tous les titres d’un tag',
  'tag.description':
    'Ajoute les titres qui ont ce tag maintenant ; ceux tagués plus tard ne sont pas ajoutés.',
  'tag.key': 'Tag',
  'tag.value': 'Valeur',
  'tag.confirm': 'Ajouter',

  'error.safety_playlist_full': 'Une playlist de secours contient au plus 1000 titres.',
};

const messages: Record<Locale, Record<SafetyMessageKey, string>> = { en, fr };

/** `t` for this page's strings, in the app's current locale. */
export function useSafetyT() {
  const { locale } = useI18n();
  return useCallback(
    (key: SafetyMessageKey, params?: Record<string, string | number>) =>
      messages[locale][key].replace(/\{(\w+)\}/g, (match, name: string) =>
        params && name in params ? String(params[name]) : match,
      ),
    [locale],
  );
}
