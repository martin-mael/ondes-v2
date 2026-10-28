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
  'connection.notAssigned': 'Not assigned yet',
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

  'field.adHoc': 'Outside their slots',
  'field.adHoc.approval': 'Ask a manager before going on air',
  'field.adHoc.allowed': 'On air as soon as they connect',
  'field.adHocHelp':
    'When this DJ connects outside their shows’ live slots and events (ad-hoc live). With “on air”, they take the air unless another DJ is on.',
  'streamers.adHocAllowed': 'Ad-hoc live allowed',

  'requests.title': 'Waiting to go on air',
  'requests.prompt': '{name} is connected (input {input}). Put them on air?',
  'requests.since': 'since {time}',
  'requests.approve': 'Put on air',
  'requests.refuse': 'Refuse',
  'requests.approved': '{name} is on air.',
  'requests.refused': 'Refused: {name} stays connected, off air.',

  // DJ handover (#66)
  'handover.goLive': 'Put on air',
  'handover.unknownDj': 'Unknown DJ',
  'handover.handOver': 'Hand over',
  'handover.onAir': '{name} is on air.',
  'handover.back': 'Back to automation',
  'handover.backDone': 'Back to automation.',
  'handover.mute': 'Mute',
  'handover.unmute': 'Unmute',
  'handover.mutedBadge': 'Muted',
  'handover.mutedDone': 'Input {input} muted: silence on air from it until unmuted.',
  'handover.unmutedDone': 'Input {input} unmuted.',
  'handover.kick': 'Disconnect',
  'handover.kickTitle': 'Disconnect {name}?',
  'handover.kickDescription':
    'Their software hangs up now; if they are on air, automation takes the air back. They can connect again unless their streamer is disabled.',
  'handover.kickConfirm': 'Disconnect',
  'handover.kicked': '{name} is disconnected.',
  'handover.fade': 'Crossfade',
  'handover.fadeCut': 'Cut',
  'handover.fadeSeconds': '{seconds} s',
  'handover.scheduled': 'Scheduled handovers',
  'handover.schedule': 'Schedule a handover',
  'handover.none': 'No handover scheduled.',
  'handover.item': '{time}: {name}, {fade}',
  'handover.cancel': 'Cancel',
  'handover.cancelled': 'Handover cancelled.',
  'handover.status.pending': 'Scheduled',
  'handover.status.running': 'Switching',
  'handover.status.done': 'Done',
  'handover.status.failed': 'Failed',
  'handover.status.cancelled': 'Cancelled',
  'handover.reason.not_connected': 'the DJ wasn’t connected',
  'handover.reason.streamer_not_allowed': 'the DJ may not go on air',
  'handover.reason.engine_unavailable': 'the engine didn’t answer',
  'handover.reason.missed': 'missed (the server was down)',
  'handover.reason.interrupted': 'interrupted',
  'handover.reason.error': 'an error',
  'handover.form.description':
    'At this time (station time), the DJ takes the air with a crossfade from whoever is on. They must be connected by then, on any input.',
  'handover.form.dj': 'DJ',
  'handover.form.pickDj': 'Choose a DJ',
  'handover.form.at': 'At',
  'handover.form.submit': 'Schedule',
  'handover.form.done': 'Handover scheduled.',
  'handover.form.djRequired': 'Choose the DJ who takes the air.',
  'handover.form.atInvalid': 'Choose a time in the next 24 hours.',

  'events.title': 'Events',
  'events.description':
    'One-off live blocks with a title, outside the shows: a concert, a festival stage. Their DJs connect up to {minutes} minutes before and go on air at the start.',
  'events.new': 'New event',
  'events.empty': 'No upcoming event.',
  'events.anyStreamer': 'Any streamer',
  'events.edit': 'Edit',
  'events.delete': 'Delete',
  'events.deleteConfirm': 'Delete the event “{title}”?',
  'events.deleted': 'Event deleted.',
  'events.now': 'Now',
  'eventForm.newTitle': 'New event',
  'eventForm.editTitle': 'Edit the event',
  'eventForm.description': 'Times are the station’s.',
  'eventForm.title': 'Title',
  'eventForm.starts': 'Starts',
  'eventForm.ends': 'Ends',
  'eventForm.spanInvalid': 'It ends after it starts, at most 24 hours later.',
  'eventForm.streamers': 'Streamers',
  'eventForm.streamersHelp': 'None ticked: any of the station’s streamers.',
  'eventForm.noStreamers': 'This station has no streamer yet.',

  'error.live_request_decided': 'Someone already answered this request.',
  'error.live_input_not_connected': 'The DJ is no longer connected.',
  'error.streamer_not_allowed': 'This DJ’s streamer is disabled or expired.',
  'error.live_session_conflict': 'The air changed at the same time: try again.',
  'error.live_switch_busy': 'Another change of DJ is under way: try again in a moment.',
  'error.engine_unavailable': 'The station’s engine isn’t running.',
  'error.live_handover_in_past': 'This time has passed.',
  'error.live_handover_too_far': 'A handover is at most 24 hours ahead.',
  'error.live_handover_ended': 'This handover already ran or was cancelled.',
  'error.invalid_streamer': 'One of the streamers isn’t on this station any more.',
  'error.invalid_span': 'An event ends after it starts, at most 24 hours later.',

  'field.encoderMetadata': 'Show what their DJ software sends',
  'field.encoderMetadataHelp':
    'Track titles from BUTT, Mixxx… reach the streams while they’re on air. Otherwise listeners see the show and the DJ’s name.',
  'nowPlaying.title': 'Now playing on the streams',
  'nowPlaying.source.default': 'Show and DJ',
  'nowPlaying.source.encoder': 'From the DJ software',
  'nowPlaying.source.manual': 'Typed by hand',
  'nowPlaying.empty': 'Nothing',
  'nowPlaying.songTitle': 'Title',
  'nowPlaying.artist': 'Artist',
  'nowPlaying.placeholder': 'e.g. the artist on stage',
  'nowPlaying.set': 'Show on the streams',
  'nowPlaying.clear': 'Back to automatic',
  'nowPlaying.saved': 'The streams now show it.',
  'nowPlaying.cleared': 'Back to the automatic now-playing.',
  'nowPlaying.help': 'Until you go back to automatic or the DJ leaves the air.',
  'error.live_not_on_air': 'No DJ is on air any more.',
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
  'connection.notAssigned': 'Pas encore attribué',
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

  'field.adHoc': 'En dehors de ses créneaux',
  'field.adHoc.approval': 'Demander à un responsable avant l’antenne',
  'field.adHoc.allowed': 'À l’antenne dès la connexion',
  'field.adHocHelp':
    'Quand ce DJ se connecte en dehors des créneaux en direct de ses émissions et des événements (direct improvisé). Avec « à l’antenne », il prend l’antenne sauf si un autre DJ y est.',
  'streamers.adHocAllowed': 'Direct improvisé autorisé',

  'requests.title': 'En attente d’antenne',
  'requests.prompt': '{name} est connecté (entrée {input}). Le mettre à l’antenne ?',
  'requests.since': 'depuis {time}',
  'requests.approve': 'Mettre à l’antenne',
  'requests.refuse': 'Refuser',
  'requests.approved': '{name} est à l’antenne.',
  'requests.refused': 'Refusé : {name} reste connecté, hors antenne.',

  // Passage de relais (#66)
  'handover.goLive': 'Mettre à l’antenne',
  'handover.unknownDj': 'DJ inconnu',
  'handover.handOver': 'Passer le relais',
  'handover.onAir': '{name} est à l’antenne.',
  'handover.back': 'Retour à l’automation',
  'handover.backDone': 'Retour à l’automation.',
  'handover.mute': 'Couper le son',
  'handover.unmute': 'Rétablir le son',
  'handover.mutedBadge': 'Son coupé',
  'handover.mutedDone':
    'Entrée {input} coupée : silence à l’antenne de sa part jusqu’au rétablissement.',
  'handover.unmutedDone': 'Son de l’entrée {input} rétabli.',
  'handover.kick': 'Déconnecter',
  'handover.kickTitle': 'Déconnecter {name} ?',
  'handover.kickDescription':
    'Son logiciel est raccroché tout de suite ; s’il est à l’antenne, l’automation reprend l’antenne. Il peut se reconnecter, sauf si son streamer est désactivé.',
  'handover.kickConfirm': 'Déconnecter',
  'handover.kicked': '{name} est déconnecté.',
  'handover.fade': 'Fondu enchaîné',
  'handover.fadeCut': 'Coupure franche',
  'handover.fadeSeconds': '{seconds} s',
  'handover.scheduled': 'Passages de relais programmés',
  'handover.schedule': 'Programmer un passage de relais',
  'handover.none': 'Aucun passage de relais programmé.',
  'handover.item': '{time} : {name}, {fade}',
  'handover.cancel': 'Annuler',
  'handover.cancelled': 'Passage de relais annulé.',
  'handover.status.pending': 'Programmé',
  'handover.status.running': 'En cours',
  'handover.status.done': 'Fait',
  'handover.status.failed': 'Échoué',
  'handover.status.cancelled': 'Annulé',
  'handover.reason.not_connected': 'le DJ n’était pas connecté',
  'handover.reason.streamer_not_allowed': 'le DJ ne peut pas passer à l’antenne',
  'handover.reason.engine_unavailable': 'le moteur n’a pas répondu',
  'handover.reason.missed': 'manqué (le serveur était arrêté)',
  'handover.reason.interrupted': 'interrompu',
  'handover.reason.error': 'une erreur',
  'handover.form.description':
    'À cette heure (heure de la station), le DJ prend l’antenne en fondu enchaîné. Il doit être connecté d’ici là, sur n’importe quelle entrée.',
  'handover.form.dj': 'DJ',
  'handover.form.pickDj': 'Choisir un DJ',
  'handover.form.at': 'À',
  'handover.form.submit': 'Programmer',
  'handover.form.done': 'Passage de relais programmé.',
  'handover.form.djRequired': 'Choisissez le DJ qui prend l’antenne.',
  'handover.form.atInvalid': 'Choisissez une heure dans les prochaines 24 heures.',

  'events.title': 'Événements',
  'events.description':
    'Des blocs en direct ponctuels, avec un titre, en dehors des émissions : un concert, une scène de festival. Leurs DJ se connectent jusqu’à {minutes} minutes avant et passent à l’antenne au début.',
  'events.new': 'Nouvel événement',
  'events.empty': 'Aucun événement à venir.',
  'events.anyStreamer': 'Tous les streamers',
  'events.edit': 'Modifier',
  'events.delete': 'Supprimer',
  'events.deleteConfirm': 'Supprimer l’événement « {title} » ?',
  'events.deleted': 'Événement supprimé.',
  'events.now': 'En cours',
  'eventForm.newTitle': 'Nouvel événement',
  'eventForm.editTitle': 'Modifier l’événement',
  'eventForm.description': 'Les heures sont celles de la station.',
  'eventForm.title': 'Titre',
  'eventForm.starts': 'Début',
  'eventForm.ends': 'Fin',
  'eventForm.spanInvalid': 'Il finit après son début, au plus 24 heures plus tard.',
  'eventForm.streamers': 'Streamers',
  'eventForm.streamersHelp': 'Aucun coché : tous les streamers de la station.',
  'eventForm.noStreamers': 'Cette station n’a pas encore de streamer.',

  'error.live_request_decided': 'Quelqu’un a déjà répondu à cette demande.',
  'error.live_input_not_connected': 'Le DJ n’est plus connecté.',
  'error.streamer_not_allowed': 'Le streamer de ce DJ est désactivé ou expiré.',
  'error.live_session_conflict': 'L’antenne a changé au même moment : réessayez.',
  'error.live_switch_busy': 'Un autre changement de DJ est en cours : réessayez dans un instant.',
  'error.engine_unavailable': 'Le moteur de la station ne tourne pas.',
  'error.live_handover_in_past': 'Cette heure est passée.',
  'error.live_handover_too_far': 'Un passage de relais est au plus 24 heures à l’avance.',
  'error.live_handover_ended': 'Ce passage de relais a déjà eu lieu ou a été annulé.',
  'error.invalid_streamer': 'Un des streamers n’est plus sur cette station.',
  'error.invalid_span': 'Un événement finit après son début, au plus 24 heures plus tard.',

  'field.encoderMetadata': 'Afficher ce qu’envoie son logiciel de DJ',
  'field.encoderMetadataHelp':
    'Les titres envoyés par BUTT, Mixxx… arrivent sur les flux pendant son direct. Sinon, les auditeurs voient l’émission et le nom du DJ.',
  'nowPlaying.title': 'En ce moment sur les flux',
  'nowPlaying.source.default': 'Émission et DJ',
  'nowPlaying.source.encoder': 'Envoyé par le logiciel du DJ',
  'nowPlaying.source.manual': 'Saisi à la main',
  'nowPlaying.empty': 'Rien',
  'nowPlaying.songTitle': 'Titre',
  'nowPlaying.artist': 'Artiste',
  'nowPlaying.placeholder': 'p. ex. l’artiste sur scène',
  'nowPlaying.set': 'Afficher sur les flux',
  'nowPlaying.clear': 'Revenir à l’automatique',
  'nowPlaying.saved': 'Les flux l’affichent.',
  'nowPlaying.cleared': 'Retour à l’affichage automatique.',
  'nowPlaying.help': 'Jusqu’au retour à l’automatique ou à la fin du direct de ce DJ.',
  'error.live_not_on_air': 'Plus aucun DJ n’est à l’antenne.',
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
