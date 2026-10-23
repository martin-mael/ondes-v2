import { isApiError } from '../../app/api/client.ts';
import { useErrorMessage } from '../../app/forms.tsx';
import { useI18n } from '../../app/i18n/i18n.tsx';
import type { Locale } from '../../app/i18n/messages.ts';

// Live strings (#63), English and French. `fr` must have `en`'s keys.

const en = {
  title: 'Live',
  description:
    'DJ credentials for going live from BUTT, Mixxx or OBS, and the settings to type in.',
  forbidden: "You don't have access to this station's live settings.",

  'connection.title': 'Connection settings',
  'connection.off': 'The live input is off in this station’s engine settings: nobody can connect.',
  'connection.noPort': 'The station’s engine hasn’t started yet: its port shows here once it runs.',
  'connection.host': 'Server',
  'connection.port': 'Port',
  'connection.mount': 'Mount point',
  'connection.user': 'Username',
  'connection.password': 'Password',
  'connection.yourUser': 'your username',
  'connection.yourPassword': 'your password',
  'connection.formats': 'Send {formats}. 128 kbps or more, 44.1 kHz stereo.',
  'connection.shoutcast':
    'Shoutcast (v1) clients: type port {port} (they connect on the next one) and username:password as the password.',
  'connection.shoutcastOff':
    'This station doesn’t take Shoutcast (v1) clients: use the Icecast settings.',
  'connection.mounts':
    'If {mount} is taken (another DJ is connected), use {others}: the next DJ connects and waits while the current one is on air.',
  'connection.window':
    'You can connect from {minutes} minutes before your show’s slot until it ends. Connecting doesn’t put you on air: the station switches to you at the slot’s start.',
  'connection.noStreamers':
    'Nobody can go live yet: each DJ connects with their own streamer credentials, made below. There is no shared station password.',
  'connection.copy': 'Copy',
  'connection.copied': 'Copied.',
  'butt.title': 'BUTT',
  'butt.where': 'Settings → Main → Server: Add',
  'butt.type': 'Type: Icecast',
  'mixxx.title': 'Mixxx',
  'mixxx.where': 'Options → Preferences → Live Broadcasting',
  'mixxx.type': 'Type: Icecast 2',
  'obs.title': 'OBS',
  'obs.where':
    'Settings → Output, Output Mode “Advanced” → Recording, Type “Custom Output (FFmpeg)”',
  'obs.urlLabel': 'URL',
  'obs.url': 'FFmpeg output type “Output to URL”, URL:',
  'obs.format': 'Container format mp3, audio encoder libmp3lame, then Start Recording.',

  'streamers.title': 'Streamers',
  'streamers.mine': 'Your credentials',
  'streamers.new': 'New streamer',
  'streamers.empty': 'No streamer yet. Create one per DJ, guests included.',
  'streamers.emptyMine': 'You have no live credentials on this station. Ask a station manager.',
  'streamers.anyTime': 'Any time',
  'streamers.noShow': 'No show: can’t connect',
  'streamers.guest': 'Guest',
  'streamers.expires': 'Until {date}',
  'streamers.lastConnected': 'Last connected {date}',
  'streamers.never': 'Never connected',
  'streamers.edit': 'Edit',
  'streamers.newPassword': 'New password',
  'streamers.newPasswordConfirm':
    'Make a new password for “{name}”? The current one stops working at once.',
  'streamers.delete': 'Delete',
  'streamers.deleteConfirm': 'Delete “{name}”? These credentials stop working at once.',
  'streamers.deleted': 'Streamer deleted.',

  'status.active': 'Active',
  'status.disabled': 'Disabled',
  'status.expired': 'Expired',

  'form.newTitle': 'New streamer',
  'form.editTitle': 'Edit the streamer',
  'form.description': 'One per DJ. The password is shown once, when it’s made.',
  'form.create': 'Create',
  'form.save': 'Save',
  'field.displayName': 'Name',
  'field.username': 'Username',
  'field.usernameHelp': 'Lowercase letters, digits, dots, dashes. Unique on the station.',
  'field.usernameInvalid': '2 to 32 lowercase letters, digits, dots, dashes or underscores.',
  'field.password': 'Password',
  'field.passwordHelp': 'Leave empty to generate a strong one.',
  'field.passwordInvalid': 'At least 12 characters.',
  'field.required': 'Required.',
  'field.user': 'Team member',
  'field.userNone': 'None (guest DJ)',
  'field.userHelp': 'A linked member sees these credentials and can reset the password.',
  'field.enabled': 'Enabled',
  'field.expires': 'Expires (station time)',
  'field.expiresHelp': 'For a one-off guest. Empty: no expiry.',
  'field.expiresInvalid': 'A date and a time.',
  'field.anyTime': 'May connect any time',
  'field.anyTimeHelp': 'Otherwise only around the slots of the shows below.',
  'field.shows': 'Shows',
  'field.noShows': 'This station has no show yet.',

  'password.title': 'Password for {username}',
  'password.description':
    'Copy it now and give it to the DJ: it won’t be shown again. Make a new one if it’s lost.',
  'password.done': 'Done',

  'error.streamer_username_taken': 'This username is already used on this station.',
  'error.invalid_show': 'One of the shows isn’t on this station any more.',
  'error.invalid_user': 'This person isn’t a member of the station.',
};

const fr: typeof en = {
  title: 'Direct',
  description:
    'Les identifiants des DJ pour passer en direct depuis BUTT, Mixxx ou OBS, et les réglages à saisir.',
  forbidden: 'Vous n’avez pas accès aux réglages du direct de cette station.',

  'connection.title': 'Réglages de connexion',
  'connection.off':
    'L’entrée directe est coupée dans les réglages du moteur de cette station : personne ne peut se connecter.',
  'connection.noPort':
    'Le moteur de la station n’a pas encore démarré : son port s’affichera ici dès qu’il tournera.',
  'connection.host': 'Serveur',
  'connection.port': 'Port',
  'connection.mount': 'Point de montage',
  'connection.user': 'Identifiant',
  'connection.password': 'Mot de passe',
  'connection.yourUser': 'votre identifiant',
  'connection.yourPassword': 'votre mot de passe',
  'connection.formats': 'Envoyez du {formats}. 128 kb/s ou plus, 44,1 kHz stéréo.',
  'connection.shoutcast':
    'Clients Shoutcast (v1) : saisissez le port {port} (ils se connectent sur le suivant) et identifiant:mot de passe comme mot de passe.',
  'connection.shoutcastOff':
    'Cette station n’accepte pas les clients Shoutcast (v1) : utilisez les réglages Icecast.',
  'connection.mounts':
    'Si {mount} est pris (un autre DJ est connecté), utilisez {others} : le DJ suivant se connecte et attend pendant que l’actuel est à l’antenne.',
  'connection.window':
    'Vous pouvez vous connecter {minutes} minutes avant le créneau de votre émission et jusqu’à sa fin. Vous connecter ne vous met pas à l’antenne : la station bascule sur vous au début du créneau.',
  'connection.noStreamers':
    'Personne ne peut encore passer en direct : chaque DJ se connecte avec ses propres identifiants de streamer, créés ci-dessous. Il n’y a pas de mot de passe partagé pour la station.',
  'connection.copy': 'Copier',
  'connection.copied': 'Copié.',
  'butt.title': 'BUTT',
  'butt.where': 'Settings → Main → Server: Add',
  'butt.type': 'Type : Icecast',
  'mixxx.title': 'Mixxx',
  'mixxx.where': 'Options → Préférences → Diffusion en direct',
  'mixxx.type': 'Type : Icecast 2',
  'obs.title': 'OBS',
  'obs.where':
    'Paramètres → Sortie, mode de sortie « Avancé » → Enregistrement, type « Sortie personnalisée (FFmpeg) »',
  'obs.urlLabel': 'URL',
  'obs.url': 'Type de sortie FFmpeg « Sortie vers une URL », URL :',
  'obs.format':
    'Format de conteneur mp3, encodeur audio libmp3lame, puis Démarrer l’enregistrement.',

  'streamers.title': 'Streamers',
  'streamers.mine': 'Vos identifiants',
  'streamers.new': 'Nouveau streamer',
  'streamers.empty': 'Aucun streamer. Créez-en un par DJ, invités compris.',
  'streamers.emptyMine':
    'Vous n’avez pas d’identifiants de direct sur cette station. Demandez à un responsable.',
  'streamers.anyTime': 'À tout moment',
  'streamers.noShow': 'Aucune émission : connexion impossible',
  'streamers.guest': 'Invité',
  'streamers.expires': 'Jusqu’au {date}',
  'streamers.lastConnected': 'Dernière connexion {date}',
  'streamers.never': 'Jamais connecté',
  'streamers.edit': 'Modifier',
  'streamers.newPassword': 'Nouveau mot de passe',
  'streamers.newPasswordConfirm':
    'Créer un nouveau mot de passe pour « {name} » ? L’actuel cesse aussitôt de fonctionner.',
  'streamers.delete': 'Supprimer',
  'streamers.deleteConfirm':
    'Supprimer « {name} » ? Ces identifiants cessent aussitôt de fonctionner.',
  'streamers.deleted': 'Streamer supprimé.',

  'status.active': 'Actif',
  'status.disabled': 'Désactivé',
  'status.expired': 'Expiré',

  'form.newTitle': 'Nouveau streamer',
  'form.editTitle': 'Modifier le streamer',
  'form.description': 'Un par DJ. Le mot de passe n’est affiché qu’une fois, à sa création.',
  'form.create': 'Créer',
  'form.save': 'Enregistrer',
  'field.displayName': 'Nom',
  'field.username': 'Identifiant',
  'field.usernameHelp': 'Minuscules, chiffres, points, tirets. Unique sur la station.',
  'field.usernameInvalid': 'De 2 à 32 minuscules, chiffres, points, tirets ou tirets bas.',
  'field.password': 'Mot de passe',
  'field.passwordHelp': 'Laissez vide pour en générer un solide.',
  'field.passwordInvalid': 'Au moins 12 caractères.',
  'field.required': 'Obligatoire.',
  'field.user': 'Membre de l’équipe',
  'field.userNone': 'Aucun (DJ invité)',
  'field.userHelp': 'Un membre lié voit ces identifiants et peut en changer le mot de passe.',
  'field.enabled': 'Activé',
  'field.expires': 'Expire (heure de la station)',
  'field.expiresHelp': 'Pour un invité ponctuel. Vide : pas d’expiration.',
  'field.expiresInvalid': 'Une date et une heure.',
  'field.anyTime': 'Peut se connecter à tout moment',
  'field.anyTimeHelp': 'Sinon, seulement autour des créneaux des émissions ci-dessous.',
  'field.shows': 'Émissions',
  'field.noShows': 'Cette station n’a pas encore d’émission.',

  'password.title': 'Mot de passe de {username}',
  'password.description':
    'Copiez-le maintenant et donnez-le au DJ : il ne sera plus affiché. Créez-en un nouveau s’il est perdu.',
  'password.done': 'Terminé',

  'error.streamer_username_taken': 'Cet identifiant est déjà utilisé sur cette station.',
  'error.invalid_show': 'Une des émissions n’est plus sur cette station.',
  'error.invalid_user': 'Cette personne n’est pas membre de la station.',
};

export type LiveMessageKey = keyof typeof en;
const messages: Record<Locale, Record<LiveMessageKey, string>> = { en, fr };

export type LiveT = (key: LiveMessageKey, params?: Record<string, string | number>) => string;

/** The live dictionary in the current locale, `{name}` placeholders included. */
export function useLiveT(): LiveT {
  const { locale } = useI18n();
  return (key, params) => {
    const template = messages[locale][key];
    if (!params) return template;
    return template.replace(/\{(\w+)\}/g, (match, name: string) =>
      name in params ? String(params[name]) : match,
    );
  };
}

/** An api error in words: the live module's own codes, else the app's messages. */
export function useLiveError() {
  const t = useLiveT();
  const generic = useErrorMessage();
  return (error: unknown): string => {
    if (isApiError(error)) {
      const key = `error.${error.code}` as LiveMessageKey;
      if (key in en) return t(key);
    }
    return generic(error);
  };
}
