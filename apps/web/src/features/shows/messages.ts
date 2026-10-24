import { isApiError } from '../../app/api/client.ts';
import { useErrorMessage } from '../../app/forms.tsx';
import { useI18n } from '../../app/i18n/i18n.tsx';
import type { Locale } from '../../app/i18n/messages.ts';

// Shows strings (#45), English and French. `fr` must have `en`'s keys. A key with a `#one`
// variant uses it when `count` is 1.

const en = {
  forbidden: "You don't have access to this station's shows.",
  'list.title': 'Shows',
  'list.description':
    'The station’s programmes: when they air, their hosts and their episodes, pre-recorded or live.',
  'list.new': 'New show',
  'list.empty': 'No show yet.',
  'list.mine': 'Your shows',
  'list.others': 'All shows',
  'list.noHosts': 'No host',

  'form.newTitle': 'New show',
  'form.editTitle': 'Edit the show',
  'form.description': 'What listeners and the team see. Slots are set on the show’s page.',
  'form.save': 'Save',
  'form.create': 'Create',
  'field.name': 'Name',
  'field.required': 'Required.',
  'field.description': 'Description',
  'field.artworkUrl': 'Artwork URL',
  'field.artworkHelp': 'A square image, on https.',
  'field.artworkInvalid': 'An https link to an image.',
  'field.defaultDuration': 'Usual length (minutes)',
  'field.defaultSlotType': 'Usually',
  'field.colour': 'Colour in the calendar',
  'field.colourClear': 'Remove the colour',
  'field.colourNone': 'No colour',
  'field.tags': 'Tags',
  'field.tagsHelp': 'Comma separated.',
  'field.hosts': 'Hosts',
  'field.hostsHelp': 'Hosts can edit the show and upload its episodes.',
  'field.fallback': 'If an episode is missing',
  'field.fallbackHelp':
    'Hosts and programmers are emailed 48 h and 6 h before a slot whose episode has no audio. If it is still missing an hour before, this airs instead.',
  'fallback.latest_episode': 'Rerun the latest episode',
  'fallback.episode': 'Rerun a chosen episode',
  'fallback.clock_music': 'Music from the clock',
  'fallback.none': 'Nothing (safety playlist)',
  'field.fallbackEpisode': 'Episode to rerun',
  'field.fallbackEpisodeNone': 'Choose an episode',
  'field.fallbackEpisodeHelp': 'Only episodes with audio. Without one, the latest episode airs.',
  'field.fallbackEpisodeOnSave': 'Create the show first, then choose one of its episodes.',

  'type.prerecorded': 'Pre-recorded',
  'type.live': 'Live',
  'type.rerun': 'Rerun',

  'status.planned': 'Planned',
  'status.ready': 'Ready',
  'status.aired': 'Aired',
  'status.missing': 'Missing',
  'status.uploading': 'Uploading {pct}%',
  'status.processing': 'Processing…',

  'show.back': 'All shows',
  'show.edit': 'Edit',
  'show.hostedBy': 'Hosted by {hosts}',
  'show.notFound': 'This show doesn’t exist.',
  'show.delete': 'Delete the show',
  'show.deleteConfirm':
    'Delete “{name}”? Its slots and episodes are deleted too; the audio stays in the library.',
  'show.deleted': 'Show deleted.',

  'upcoming.title': 'Upcoming airings',
  'upcoming.timezone': 'Times in {timezone}.',
  'upcoming.empty': 'Nothing planned in the next weeks. Add a slot to put the show on air.',
  'upcoming.createMissing': 'Create the next 2 weeks’ episodes ({count})',
  'upcoming.created': '{count} episodes created.',
  'upcoming.created#one': 'Episode created.',
  'upcoming.plan': 'Plan…',
  'upcoming.assign': 'Use an episode…',
  'upcoming.rerun': 'A previous episode airs again.',
  'upcoming.rerunOf': 'Rerun of episode {number}',
  'upcoming.rerunNothing': 'Nothing to rerun yet: no earlier episode has audio.',

  'rerun.strategy': 'Episode to air again',
  'rerun.latest_episode': 'The latest episode',
  'rerun.episode': 'A chosen episode',
  'rerun.episodeField': 'Episode',
  'rerun.episodeNone': 'Choose an episode',
  'rerun.help':
    'Only aired episodes air again. The latest is the most recent one aired by then (a premiere planned earlier counts).',
  'rerun.episodeMissing':
    'No episode chosen yet: you can save, and the latest one airs until you pick one.',
  'rerun.slotLatest': 'Reruns the latest episode',
  'rerun.slotEpisode': 'Reruns episode {number}',
  'rerun.slotEpisodeGone': 'Reruns the latest episode: no episode chosen (or it was deleted)',
  'rerun.schedule': 'Schedule a rerun',
  'rerun.scheduleLabel': 'Schedule a rerun of episode {number}',
  'rerun.dialogTitle': 'Rerun episode {number}',
  'rerun.dialogDescription': 'It airs once more, at this time on the station’s clock ({timezone}).',
  'rerun.date': 'Date',
  'rerun.time': 'Time',
  'rerun.duration': 'Length (minutes)',
  'rerun.durationHelp':
    'Empty: the premiere’s length, else the show’s usual one, else the audio’s.',
  'rerun.beforePremiere': 'This is before the episode’s premiere ({date}): pick a later date.',
  'rerun.beforeAired': 'The episode first aired on {when}: a rerun comes after that.',
  'rerun.durationInvalid': 'A whole number of minutes, from 1 to 1440.',
  'rerun.premieres': 'premieres {date}',
  'rerun.submit': 'Schedule',
  'rerun.done': 'Rerun of episode {number} scheduled for {when}.',
  'upcoming.noEpisode': 'No episode yet.',

  'unscheduled.title': 'Episodes to plan',
  'unscheduled.description':
    'Not planned in any airing: new, or left over when a slot changed. Pick an airing for each.',
  'unscheduled.planIn': 'Plan #{number} on…',
  'unscheduled.planned': 'Episode #{number} planned.',
  'unscheduled.plannedShort': 'Episode planned.',

  'detached.title': '{count} episodes lost their airing',
  'detached.title#one': 'An episode lost its airing',
  'detached.description': '{episodes}: kept with their audio, under “Episodes to plan”.',
  'detached.toast': 'They are kept with their audio. Plan them again from the show’s page.',
  'detached.open': 'Open the show',
  'detached.dismiss': 'Dismiss',

  'slots.title': 'Slots',
  'slots.add': 'Add a slot',
  'slots.edit': 'Edit',
  'slots.empty': 'No slot: the show doesn’t air yet.',
  'slots.exceptions': '{count} exceptions',
  'slots.exceptions#one': '1 exception',

  'slot.newTitle': 'New slot',
  'slot.editTitle': 'Edit the slot',
  'slot.timezone': 'Times are on the station’s clock ({timezone}).',
  'slot.type': 'Type',
  'slot.repeat': 'Repeats',
  'slot.freq.weekly': 'Every week',
  'slot.freq.once': 'Once',
  'slot.days': 'Days',
  'slot.daysRequired': 'Pick at least one day.',
  'slot.interval': 'Every … weeks',
  'slot.intervalHelp': '1: every week, 2: every other week, counted from the start date.',
  'slot.startDate': 'From',
  'slot.until': 'Until (optional)',
  'slot.untilInvalid': 'Not before the start date.',
  'slot.date': 'Date',
  'slot.time': 'Time',
  'slot.duration': 'Length (min)',
  'slot.start': 'Start',
  'slot.start.hard': 'On time',
  'slot.start.soft': 'After the current item',
  'slot.startCap': 'Late by at most (s)',
  'slot.startCapInvalid': 'Seconds, from 0 to 600.',
  'slot.startHelp.hard':
    'Starts exactly on time: whatever is playing fades out under it. The music before it is planned to end on time.',
  'slot.startHelp.soft':
    'Lets the item playing end first, then starts, at most this late. Empty: 30 s.',
  'slot.detachWarning':
    'Episodes planned on airings this change removes are kept, but must be planned again.',
  'slot.exceptions': 'Exceptions',
  'slot.create': 'Add the slot',
  'slot.delete': 'Delete the slot',
  'slot.deleteConfirm':
    'Delete this slot? Episodes planned in it are kept, but must be planned again.',

  'rule.once': 'Once, {date} at {time}',
  'rule.weekly': 'Every {days} at {time}',
  'rule.everyN': 'Every {n} weeks on {days} at {time}',
  'rule.until': 'until {date}',

  'exception.cancelled': '{date}: cancelled',
  'exception.moved': '{date}: moved to {to}',
  'exception.restore': 'Restore',

  'episodes.title': 'Episodes',
  'episodes.new': 'New episode',
  'episodes.empty': 'No episode yet.',
  'episodes.status': 'Status',

  'episode.label': '#{number}',
  'episode.newTitle': 'New episode',
  'episode.editTitle': 'Episode #{number}',
  'episode.number': 'Number',
  'episode.numberHelp': 'Leave empty for the next number. Numbers are never reused.',
  'episode.numberInvalid': 'A whole number from 1.',
  'episode.title': 'Title',
  'episode.description': 'Description',
  'episode.kind': 'Kind',
  'episode.occurrence': 'Airs on',
  'episode.unscheduled': 'Not planned',
  'episode.audio': 'Audio',
  'episode.hasAudio': 'The audio file is attached.',
  'episode.noAudio': 'No audio yet.',
  'episode.uploadAudio': 'Upload audio',
  'episode.replaceAudio': 'Replace the audio',
  'episode.attachAsset': 'From the library',
  'episode.removeAudio': 'Remove the audio',
  'episode.attached': 'Audio attached.',
  'episode.create': 'Create',
  'episode.created': 'Episode created.',
  'episode.saved': 'Episode saved.',
  'episode.delete': 'Delete',
  'episode.deleteConfirm': 'Delete this episode? Its audio stays in the library.',
  'episode.deleted': 'Episode deleted.',

  'picker.title': 'Attach audio from the library',
  'picker.description': 'Episode files already in the library.',
  'picker.search': 'Search the library',
  'picker.noResults': 'No episode file found.',
  'picker.choose': 'Use',

  'upload.starting': '{file}: starting the upload…',
  'upload.uploading': '{file}: uploading, {pct}%',
  'upload.processing': '{file}: processing the audio…',
  'upload.done': '{file}: the episode is ready.',
  'upload.failed': '{file}: upload failed. {reason}',
  'upload.stopped': '{file}: upload stopped when you left the page.',
  'upload.stillProcessing':
    '{file}: still processing. Check later, then attach it from the library if needed.',

  'calendar.title': 'Calendar',
  'calendar.week': 'Week',
  'calendar.month': 'Month',
  'calendar.list': 'List',
  'calendar.view': 'View',
  'calendar.today': 'Today',
  'calendar.previous': 'Previous',
  'calendar.next': 'Next',
  'calendar.filter': 'Show',
  'calendar.allShows': 'All shows',
  'calendar.noEpisode': 'No episode',
  'calendar.nothing': 'Nothing on air.',
  'calendar.dropFile': 'Drop to upload',
  'calendar.dragHelp':
    'Drag an airing to move it (up to 7 days). Drop an audio file on an airing to upload its episode.',
  'calendar.dropHelp': 'Drop an audio file on one of your airings to upload its episode.',

  'conflict.title': '{count} overlaps',
  'conflict.title#one': 'An overlap',
  'conflict.line': '{a} and {b} overlap on {when} ({duration}).',
  'conflict.with': 'Overlaps {show} for {duration}.',
  'conflict.label': 'Overlap',

  'occurrence.episode': 'Episode',
  'occurrence.createEpisode': 'Create the episode',
  'occurrence.openShow': 'Open the show',
  'occurrence.moved': 'Moved',
  'occurrence.movedFrom': 'Moved from {date}',
  'occurrence.cancelled': 'cancelled',
  'occurrence.cancelledHelp': 'This airing is cancelled. Restore it to put it back on air.',
  'occurrence.move': 'Move or cancel this airing',
  'occurrence.moveHelp': 'Only this airing changes, by up to 7 days. Its episode follows it.',
  'occurrence.moveSubmit': 'Move',
  'occurrence.movedDone': 'Airing moved.',
  'occurrence.movedTo': 'Moved to {when}.',
  'occurrence.tooFar': 'An airing moves by {days} days at most.',
  'occurrence.undoMove': 'Undo the move',
  'occurrence.cancel': 'Cancel this airing',
  'occurrence.cancelConfirm': 'Cancel this airing? Its episode is kept, to plan again.',
  'occurrence.cancelledDone': 'Airing cancelled.',
  'occurrence.restored': 'Airing restored.',

  'error.asset_taken': 'This audio file is already used by another episode.',
  'error.episode_number_taken': 'The show already has an episode with this number.',
  'error.occurrence_taken': 'Another episode is already planned for this airing.',
  'error.not_an_occurrence': 'The show doesn’t air on that date any more.',
  'error.rerun_slot': 'A rerun airs a previous episode: plan new episodes on other airings.',
  'error.duration_required': 'Give the slot a length: the show has no usual length.',
  'error.no_audio': 'This episode has no audio to air again.',
  'error.before_premiere': 'A rerun comes after the episode’s premiere.',
  'error.not_aired': 'Only an episode that has aired can be rerun.',
  'error.not_a_rerun_slot': 'Only a rerun slot has an episode to air again.',
  'error.unknown_episode': 'This episode is not one of the show’s.',
  'error.invalid_host': 'A host is not a member of this station.',
  'error.invalid_asset': 'Only episode files can be attached.',
  'error.unknown_asset': 'This file is not in the station’s library.',
  'error.not_audio': 'This file is not audio.',
  'error.probe_failed': 'This file can’t be read.',
  'error.transcode_failed': 'This audio file can’t be decoded.',
  'error.empty': 'This audio file is empty.',
  'error.quota_exceeded': 'The organisation’s storage is full.',
  'error.upload_failed': 'The file couldn’t be sent.',
};

export type ShowMessageKey = keyof typeof en;

const fr: Record<ShowMessageKey, string> = {
  forbidden: "Vous n'avez pas accès aux émissions de cette station.",
  'list.title': 'Émissions',
  'list.description':
    'Les émissions de la station : quand elles passent, leurs animateurs et leurs épisodes, enregistrés ou en direct.',
  'list.new': 'Nouvelle émission',
  'list.empty': 'Aucune émission pour l’instant.',
  'list.mine': 'Vos émissions',
  'list.others': 'Toutes les émissions',
  'list.noHosts': 'Sans animateur',

  'form.newTitle': 'Nouvelle émission',
  'form.editTitle': 'Modifier l’émission',
  'form.description':
    'Ce que voient les auditeurs et l’équipe. Les créneaux se règlent sur la page de l’émission.',
  'form.save': 'Enregistrer',
  'form.create': 'Créer',
  'field.name': 'Nom',
  'field.required': 'Obligatoire.',
  'field.description': 'Description',
  'field.artworkUrl': 'URL du visuel',
  'field.artworkHelp': 'Une image carrée, en https.',
  'field.artworkInvalid': 'Un lien https vers une image.',
  'field.defaultDuration': 'Durée habituelle (minutes)',
  'field.defaultSlotType': 'D’habitude',
  'field.colour': 'Couleur dans le calendrier',
  'field.colourClear': 'Retirer la couleur',
  'field.colourNone': 'Sans couleur',
  'field.tags': 'Tags',
  'field.tagsHelp': 'Séparés par des virgules.',
  'field.hosts': 'Animateurs',
  'field.hostsHelp': 'Les animateurs peuvent modifier l’émission et envoyer ses épisodes.',
  'field.fallback': 'Si un épisode manque',
  'field.fallbackHelp':
    'Les animateurs et programmateurs reçoivent un e-mail 48 h et 6 h avant un créneau dont l’épisode n’a pas d’audio. S’il manque encore une heure avant, ceci est diffusé à la place.',
  'fallback.latest_episode': 'Rediffuser le dernier épisode',
  'fallback.episode': 'Rediffuser un épisode choisi',
  'fallback.clock_music': 'De la musique selon l’horloge',
  'fallback.none': 'Rien (playlist de secours)',
  'field.fallbackEpisode': 'Épisode à rediffuser',
  'field.fallbackEpisodeNone': 'Choisir un épisode',
  'field.fallbackEpisodeHelp':
    'Seulement les épisodes avec audio. Sans choix, le dernier épisode passe.',
  'field.fallbackEpisodeOnSave': 'Créez d’abord l’émission, puis choisissez un de ses épisodes.',

  'type.prerecorded': 'Enregistrée',
  'type.live': 'Direct',
  'type.rerun': 'Rediffusion',

  'status.planned': 'Prévu',
  'status.ready': 'Prêt',
  'status.aired': 'Diffusé',
  'status.missing': 'Manquant',
  'status.uploading': 'Envoi {pct} %',
  'status.processing': 'Traitement…',

  'show.back': 'Toutes les émissions',
  'show.edit': 'Modifier',
  'show.hostedBy': 'Animée par {hosts}',
  'show.notFound': 'Cette émission n’existe pas.',
  'show.delete': 'Supprimer l’émission',
  'show.deleteConfirm':
    'Supprimer « {name} » ? Ses créneaux et épisodes sont supprimés aussi ; l’audio reste dans la médiathèque.',
  'show.deleted': 'Émission supprimée.',

  'upcoming.title': 'Prochaines diffusions',
  'upcoming.timezone': 'Heures de {timezone}.',
  'upcoming.empty':
    'Rien de prévu dans les semaines à venir. Ajoutez un créneau pour mettre l’émission à l’antenne.',
  'upcoming.createMissing': 'Créer les épisodes des 2 prochaines semaines ({count})',
  'upcoming.created': '{count} épisodes créés.',
  'upcoming.created#one': 'Épisode créé.',
  'upcoming.plan': 'Planifier…',
  'upcoming.assign': 'Choisir un épisode…',
  'upcoming.rerun': 'Un épisode précédent est rediffusé.',
  'upcoming.rerunOf': 'Rediffusion de l’épisode {number}',
  'upcoming.rerunNothing':
    'Rien à rediffuser pour l’instant : aucun épisode précédent n’a d’audio.',

  'rerun.strategy': 'Épisode rediffusé',
  'rerun.latest_episode': 'Le dernier épisode',
  'rerun.episode': 'Un épisode choisi',
  'rerun.episodeField': 'Épisode',
  'rerun.episodeNone': 'Choisir un épisode',
  'rerun.help':
    'Seuls les épisodes déjà diffusés repassent. Le dernier est le plus récent diffusé d’ici là (une première diffusion prévue avant compte).',
  'rerun.episodeMissing':
    'Pas encore d’épisode choisi : vous pouvez enregistrer, le dernier passe en attendant.',
  'rerun.slotLatest': 'Rediffuse le dernier épisode',
  'rerun.slotEpisode': 'Rediffuse l’épisode {number}',
  'rerun.slotEpisodeGone':
    'Rediffuse le dernier épisode : aucun épisode choisi (ou il a été supprimé)',
  'rerun.schedule': 'Programmer une rediffusion',
  'rerun.scheduleLabel': 'Programmer une rediffusion de l’épisode {number}',
  'rerun.dialogTitle': 'Rediffuser l’épisode {number}',
  'rerun.dialogDescription': 'Il passe une fois de plus, à l’heure de la station ({timezone}).',
  'rerun.date': 'Date',
  'rerun.time': 'Heure',
  'rerun.duration': 'Durée (minutes)',
  'rerun.durationHelp':
    'Vide : la durée de la première diffusion, sinon celle de l’émission, sinon celle de l’audio.',
  'rerun.beforePremiere':
    'C’est avant la première diffusion de l’épisode ({date}) : choisissez une date plus tardive.',
  'rerun.beforeAired':
    'L’épisode a été diffusé pour la première fois le {when} : une rediffusion vient après.',
  'rerun.durationInvalid': 'Un nombre entier de minutes, de 1 à 1440.',
  'rerun.premieres': 'première diffusion le {date}',
  'rerun.submit': 'Programmer',
  'rerun.done': 'Rediffusion de l’épisode {number} programmée le {when}.',
  'upcoming.noEpisode': 'Pas encore d’épisode.',

  'unscheduled.title': 'Épisodes à planifier',
  'unscheduled.description':
    'Prévus sur aucune diffusion : nouveaux, ou laissés de côté quand un créneau a changé. Choisissez une diffusion pour chacun.',
  'unscheduled.planIn': 'Planifier le n° {number} le…',
  'unscheduled.planned': 'Épisode n° {number} planifié.',
  'unscheduled.plannedShort': 'Épisode planifié.',

  'detached.title': '{count} épisodes ont perdu leur diffusion',
  'detached.title#one': 'Un épisode a perdu sa diffusion',
  'detached.description': '{episodes} : conservés avec leur audio, dans « Épisodes à planifier ».',
  'detached.toast':
    'Ils sont conservés avec leur audio. Planifiez-les à nouveau depuis la page de l’émission.',
  'detached.open': 'Ouvrir l’émission',
  'detached.dismiss': 'Masquer',

  'slots.title': 'Créneaux',
  'slots.add': 'Ajouter un créneau',
  'slots.edit': 'Modifier',
  'slots.empty': 'Aucun créneau : l’émission n’est pas encore à l’antenne.',
  'slots.exceptions': '{count} exceptions',
  'slots.exceptions#one': '1 exception',

  'slot.newTitle': 'Nouveau créneau',
  'slot.editTitle': 'Modifier le créneau',
  'slot.timezone': 'Heures de la station ({timezone}).',
  'slot.type': 'Type',
  'slot.repeat': 'Répétition',
  'slot.freq.weekly': 'Chaque semaine',
  'slot.freq.once': 'Une fois',
  'slot.days': 'Jours',
  'slot.daysRequired': 'Choisissez au moins un jour.',
  'slot.interval': 'Toutes les … semaines',
  'slot.intervalHelp':
    '1 : chaque semaine, 2 : une semaine sur deux, à partir de la date de début.',
  'slot.startDate': 'À partir du',
  'slot.until': 'Jusqu’au (facultatif)',
  'slot.untilInvalid': 'Pas avant la date de début.',
  'slot.date': 'Date',
  'slot.time': 'Heure',
  'slot.duration': 'Durée (min)',
  'slot.start': 'Début',
  'slot.start.hard': 'À l’heure',
  'slot.start.soft': 'Après l’élément en cours',
  'slot.startCap': 'Retard maximal (s)',
  'slot.startCapInvalid': 'En secondes, de 0 à 600.',
  'slot.startHelp.hard':
    'Commence pile à l’heure : ce qui passe s’efface en fondu. La musique avant est prévue pour finir à l’heure.',
  'slot.startHelp.soft':
    'Laisse finir l’élément en cours, puis commence, avec au plus ce retard. Vide : 30 s.',
  'slot.detachWarning':
    'Les épisodes prévus sur des diffusions que ce changement supprime sont conservés, mais à replanifier.',
  'slot.exceptions': 'Exceptions',
  'slot.create': 'Ajouter le créneau',
  'slot.delete': 'Supprimer le créneau',
  'slot.deleteConfirm':
    'Supprimer ce créneau ? Les épisodes qui y sont prévus sont conservés, mais à replanifier.',

  'rule.once': 'Une fois, le {date} à {time}',
  'rule.weekly': 'Chaque {days} à {time}',
  'rule.everyN': 'Toutes les {n} semaines le {days} à {time}',
  'rule.until': 'jusqu’au {date}',

  'exception.cancelled': '{date} : annulée',
  'exception.moved': '{date} : déplacée au {to}',
  'exception.restore': 'Rétablir',

  'episodes.title': 'Épisodes',
  'episodes.new': 'Nouvel épisode',
  'episodes.empty': 'Aucun épisode pour l’instant.',
  'episodes.status': 'État',

  'episode.label': 'n° {number}',
  'episode.newTitle': 'Nouvel épisode',
  'episode.editTitle': 'Épisode n° {number}',
  'episode.number': 'Numéro',
  'episode.numberHelp': 'Laissez vide pour le numéro suivant. Un numéro n’est jamais réutilisé.',
  'episode.numberInvalid': 'Un nombre entier à partir de 1.',
  'episode.title': 'Titre',
  'episode.description': 'Description',
  'episode.kind': 'Type',
  'episode.occurrence': 'Diffusé le',
  'episode.unscheduled': 'Non planifié',
  'episode.audio': 'Audio',
  'episode.hasAudio': 'Le fichier audio est joint.',
  'episode.noAudio': 'Pas encore d’audio.',
  'episode.uploadAudio': 'Envoyer l’audio',
  'episode.replaceAudio': 'Remplacer l’audio',
  'episode.attachAsset': 'Depuis la médiathèque',
  'episode.removeAudio': 'Retirer l’audio',
  'episode.attached': 'Audio joint.',
  'episode.create': 'Créer',
  'episode.created': 'Épisode créé.',
  'episode.saved': 'Épisode enregistré.',
  'episode.delete': 'Supprimer',
  'episode.deleteConfirm': 'Supprimer cet épisode ? Son audio reste dans la médiathèque.',
  'episode.deleted': 'Épisode supprimé.',

  'picker.title': 'Joindre un audio de la médiathèque',
  'picker.description': 'Les fichiers d’épisodes déjà dans la médiathèque.',
  'picker.search': 'Chercher dans la médiathèque',
  'picker.noResults': 'Aucun fichier d’épisode trouvé.',
  'picker.choose': 'Utiliser',

  'upload.starting': '{file} : début de l’envoi…',
  'upload.uploading': '{file} : envoi, {pct} %',
  'upload.processing': '{file} : traitement de l’audio…',
  'upload.done': '{file} : l’épisode est prêt.',
  'upload.failed': '{file} : l’envoi a échoué. {reason}',
  'upload.stopped': '{file} : envoi interrompu en quittant la page.',
  'upload.stillProcessing':
    '{file} : traitement en cours. Revenez plus tard, et joignez-le depuis la médiathèque si besoin.',

  'calendar.title': 'Calendrier',
  'calendar.week': 'Semaine',
  'calendar.month': 'Mois',
  'calendar.list': 'Liste',
  'calendar.view': 'Affichage',
  'calendar.today': 'Aujourd’hui',
  'calendar.previous': 'Précédent',
  'calendar.next': 'Suivant',
  'calendar.filter': 'Émission',
  'calendar.allShows': 'Toutes les émissions',
  'calendar.noEpisode': 'Pas d’épisode',
  'calendar.nothing': 'Rien à l’antenne.',
  'calendar.dropFile': 'Déposez pour envoyer',
  'calendar.dragHelp':
    'Glissez une diffusion pour la déplacer (jusqu’à 7 jours). Déposez un fichier audio sur une diffusion pour envoyer son épisode.',
  'calendar.dropHelp':
    'Déposez un fichier audio sur une de vos diffusions pour envoyer son épisode.',

  'conflict.title': '{count} chevauchements',
  'conflict.title#one': 'Un chevauchement',
  'conflict.line': '{a} et {b} se chevauchent le {when} ({duration}).',
  'conflict.with': 'Chevauche {show} pendant {duration}.',
  'conflict.label': 'Chevauchement',

  'occurrence.episode': 'Épisode',
  'occurrence.createEpisode': 'Créer l’épisode',
  'occurrence.openShow': 'Ouvrir l’émission',
  'occurrence.moved': 'Déplacée',
  'occurrence.movedFrom': 'Déplacée du {date}',
  'occurrence.cancelled': 'annulée',
  'occurrence.cancelledHelp':
    'Cette diffusion est annulée. Rétablissez-la pour la remettre à l’antenne.',
  'occurrence.move': 'Déplacer ou annuler cette diffusion',
  'occurrence.moveHelp': 'Seule cette diffusion change, de 7 jours au plus. Son épisode la suit.',
  'occurrence.moveSubmit': 'Déplacer',
  'occurrence.movedDone': 'Diffusion déplacée.',
  'occurrence.movedTo': 'Déplacée au {when}.',
  'occurrence.tooFar': 'Une diffusion se déplace de {days} jours au plus.',
  'occurrence.undoMove': 'Annuler le déplacement',
  'occurrence.cancel': 'Annuler cette diffusion',
  'occurrence.cancelConfirm': 'Annuler cette diffusion ? Son épisode est conservé, à replanifier.',
  'occurrence.cancelledDone': 'Diffusion annulée.',
  'occurrence.restored': 'Diffusion rétablie.',

  'error.asset_taken': 'Ce fichier audio est déjà utilisé par un autre épisode.',
  'error.episode_number_taken': 'L’émission a déjà un épisode avec ce numéro.',
  'error.occurrence_taken': 'Un autre épisode est déjà prévu sur cette diffusion.',
  'error.not_an_occurrence': 'L’émission ne passe plus à cette date.',
  'error.rerun_slot':
    'Une rediffusion reprend un épisode précédent : planifiez les nouveaux sur d’autres diffusions.',
  'error.duration_required':
    'Donnez une durée au créneau : l’émission n’a pas de durée habituelle.',
  'error.no_audio': 'Cet épisode n’a pas d’audio à rediffuser.',
  'error.before_premiere': 'Une rediffusion vient après la première diffusion de l’épisode.',
  'error.not_aired': 'Seul un épisode déjà diffusé peut être rediffusé.',
  'error.not_a_rerun_slot': 'Seul un créneau de rediffusion a un épisode à rediffuser.',
  'error.unknown_episode': 'Cet épisode n’appartient pas à l’émission.',
  'error.invalid_host': 'Un animateur n’est pas membre de cette station.',
  'error.invalid_asset': 'Seuls des fichiers d’épisodes peuvent être joints.',
  'error.unknown_asset': 'Ce fichier n’est pas dans la médiathèque de la station.',
  'error.not_audio': 'Ce fichier n’est pas de l’audio.',
  'error.probe_failed': 'Ce fichier est illisible.',
  'error.transcode_failed': 'Ce fichier audio ne peut pas être décodé.',
  'error.empty': 'Ce fichier audio est vide.',
  'error.quota_exceeded': 'Le stockage de l’organisation est plein.',
  'error.upload_failed': 'Le fichier n’a pas pu être envoyé.',
};

const messages: Record<Locale, Record<ShowMessageKey, string>> = { en, fr };

/** Keys that have a `#one` variant are written without it. */
type BaseKey = Exclude<ShowMessageKey, `${string}#one`>;
export type ShowT = (key: BaseKey, params?: Record<string, string | number>) => string;

/** The shows dictionary in the current locale, `{name}` placeholders included. */
export function useShowT(): ShowT {
  const { locale } = useI18n();
  return (key, params) => {
    const dict = messages[locale];
    const one = `${key}#one` as ShowMessageKey;
    const template = params?.count === 1 && one in dict ? dict[one] : dict[key];
    if (!params) return template;
    return template.replace(/\{(\w+)\}/g, (match, name: string) =>
      name in params ? String(params[name]) : match,
    );
  };
}

/** An api error in words: the shows' own codes, else the app's messages. */
export function useShowError() {
  const t = useShowT();
  const generic = useErrorMessage();
  return (error: unknown): string => {
    if (isApiError(error)) {
      const key = `error.${error.code}` as BaseKey;
      if (key in en) return t(key);
    }
    return generic(error);
  };
}
