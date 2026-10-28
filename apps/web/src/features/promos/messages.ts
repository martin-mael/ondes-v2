import { isApiError } from '../../app/api/client.ts';
import { useErrorMessage } from '../../app/forms.tsx';
import { useI18n } from '../../app/i18n/i18n.tsx';
import type { Locale } from '../../app/i18n/messages.ts';

// Promo VT strings (#60), English and French. `fr` must have `en`'s keys.

const en = {
  title: 'Promos',
  description: 'Voice tracks announcing shows and events, placed by the clocks’ promo slots.',
  forbidden: "You don't have access to this station's promos.",

  'pools.title': 'VT pools',
  'pools.new': 'New pool',
  'pools.empty': 'No VT pool yet. Make one, then pick it in a clock’s promo slot.',
  'pools.count': '{active} of {count} promos can air now',
  'pools.edit': 'Edit',
  'pools.delete': 'Delete',
  'pools.deleteConfirm':
    'Delete the pool “{name}”? Its promos stay; clock slots that use it lose their pool.',
  'pools.deleted': 'Pool deleted.',
  'pool.newTitle': 'New VT pool',
  'pool.editTitle': 'Edit VT pool',
  'pool.formDescription': 'A pool groups promos. A clock’s promo slot plays one of its promos.',
  'pool.name': 'Name',
  'pool.description': 'Description',
  'pool.color': 'Colour',
  'pool.noColor': 'No colour',
  'pool.create': 'Create',
  'pool.save': 'Save',

  'promos.title': 'Promos',
  'promos.new': 'New promo',
  'promos.empty': 'No promo yet. Record a voice track, then make it a promo.',
  'promos.emptyFilter': 'No promo matches these filters.',
  'promos.filterPool': 'Pool',
  'promos.filterStatus': 'Status',
  'promos.allPools': 'All pools',
  'promos.allStatuses': 'Any status',
  'promos.noPool': 'In no pool: it never airs',
  'promos.weight': 'Weight {weight}',
  'promos.maxPerDay': 'At most {max} a day',
  'promos.from': 'From {date}',
  'promos.until': 'Until {date}',
  'promos.always': 'No start or kill date',
  'promos.show': 'Promotes {name}',
  'promos.event': '{name}',
  'promos.eventAt': '{name}, {date}',
  'promos.plays': 'Aired {today} today · {week} in 7 days · {total} in all · {planned} planned',
  'promos.lastAired': 'Last aired {date}',
  'promos.neverAired': 'Never aired',
  'promos.edit': 'Edit',
  'promos.playsButton': 'Plays',
  'promos.delete': 'Delete',
  'promos.deleteConfirm':
    'Stop “{title}” being a promo? The voice track stays in the library; its planned plays are dropped.',
  'promos.deleted': 'Promo removed.',

  'status.scheduled': 'Scheduled',
  'status.active': 'Active',
  'status.expired': 'Expired',
  'status.disabled': 'Disabled',

  'form.newTitle': 'New promo',
  'form.editTitle': 'Edit promo',
  'form.description':
    'Its start and kill dates are the voice track’s own: it never airs outside them. Times are the station’s.',
  'form.asset': 'Voice track',
  'form.assetChoose': 'Choose a voice track',
  'form.assetChange': 'Change',
  'form.assetMissing': 'Choose the voice track to promote with.',
  'form.startAt': 'Start',
  'form.killAt': 'Kill',
  'form.dateHelp': 'Leave empty for no limit.',
  'form.datePartial': 'Add the time too (or the date): until then this one isn’t saved.',
  'form.killBeforeStart': 'The kill date must be after the start.',
  'form.show': 'Show',
  'form.showNone': 'No show',
  'form.eventName': 'Event',
  'form.eventPlaceholder': 'Concert at the Marché Gare',
  'form.eventAt': 'Event date',
  'form.useEventAsKill': 'Kill at the event',
  'form.weight': 'Weight',
  'form.weightHelp': 'Relative share of its pools’ plays: 2 plays twice as often as 1.',
  'form.maxPlaysPerDay': 'Max plays per day',
  'form.maxHelp': 'Empty: no cap.',
  'form.pools': 'Pools',
  'form.noPools': 'No VT pool yet: make one first, or save now and add it later.',
  'form.noPoolWarning': 'In no pool, the promo is kept but never airs.',
  'form.dayparts': 'Dayparts',
  'form.daypartsHelp': 'When it may air. None: any time.',
  'form.daypartAdd': 'Add a daypart',
  'form.daypartRemove': 'Remove daypart',
  'form.daypartFrom': 'From',
  'form.daypartTo': 'To',
  'form.daypartNoDay': 'Pick at least one day: this daypart is ignored until then.',
  'form.enabled': 'Enabled',
  'form.create': 'Create',
  'form.save': 'Save',
  'form.invalid': 'Check the highlighted fields.',
  'form.conflict': 'Someone saved this promo meanwhile: it was reloaded. Make your changes again.',

  'picker.title': 'Choose a voice track',
  'picker.description': 'Voice tracks of the library.',
  'picker.search': 'Search voice tracks',
  'picker.noResults': 'No voice track found.',
  'picker.choose': 'Choose',

  'plays.title': 'Plays of “{title}”',
  'plays.description': 'Last 7 days to 7 days ahead, in station time.',
  'plays.byDay': 'Aired per day',
  'plays.list': 'Plays',
  'plays.empty': 'Nothing aired or planned in this range.',
  'plays.aired': 'Aired',
  'plays.planned': 'Planned',
  'plays.placed': 'Planned',
  'plays.pending': 'Being placed',
  'plays.dropped': 'Dropped',
  'plays.openLog': 'Open the log',
  'plays.openSegue': 'Open the segue',

  'weekday.1': 'Mon',
  'weekday.2': 'Tue',
  'weekday.3': 'Wed',
  'weekday.4': 'Thu',
  'weekday.5': 'Fri',
  'weekday.6': 'Sat',
  'weekday.7': 'Sun',

  'error.promo_exists': 'This voice track is already a promo.',
  'error.not_a_voice_track': 'Only voice tracks can be promos.',
  'error.unknown_asset': 'This voice track is no longer in the station.',
  'error.unknown_pool': 'One of the pools is no longer in the station.',
  'error.unknown_show': 'The show is no longer in the station.',
  'error.name_taken': 'A pool already has this name.',
};

const fr: typeof en = {
  title: 'Promos',
  description:
    'Des voix qui annoncent émissions et événements, placées par les créneaux promo des horloges.',
  forbidden: 'Vous n’avez pas accès aux promos de cette station.',

  'pools.title': 'Groupes de promos',
  'pools.new': 'Nouveau groupe',
  'pools.empty':
    'Aucun groupe de promos. Créez-en un, puis choisissez-le dans le créneau promo d’une horloge.',
  'pools.count': '{active} promos sur {count} peuvent passer maintenant',
  'pools.edit': 'Modifier',
  'pools.delete': 'Supprimer',
  'pools.deleteConfirm':
    'Supprimer le groupe « {name} » ? Ses promos restent ; les créneaux qui l’utilisent perdent leur groupe.',
  'pools.deleted': 'Groupe supprimé.',
  'pool.newTitle': 'Nouveau groupe de promos',
  'pool.editTitle': 'Modifier le groupe',
  'pool.formDescription':
    'Un groupe réunit des promos. Le créneau promo d’une horloge diffuse l’une d’elles.',
  'pool.name': 'Nom',
  'pool.description': 'Description',
  'pool.color': 'Couleur',
  'pool.noColor': 'Sans couleur',
  'pool.create': 'Créer',
  'pool.save': 'Enregistrer',

  'promos.title': 'Promos',
  'promos.new': 'Nouvelle promo',
  'promos.empty': 'Aucune promo. Enregistrez une voix, puis faites-en une promo.',
  'promos.emptyFilter': 'Aucune promo ne correspond à ces filtres.',
  'promos.filterPool': 'Groupe',
  'promos.filterStatus': 'État',
  'promos.allPools': 'Tous les groupes',
  'promos.allStatuses': 'Tous les états',
  'promos.noPool': 'Dans aucun groupe : elle ne passe jamais',
  'promos.weight': 'Poids {weight}',
  'promos.maxPerDay': '{max} par jour au plus',
  'promos.from': 'À partir du {date}',
  'promos.until': 'Jusqu’au {date}',
  'promos.always': 'Ni début ni fin',
  'promos.show': 'Annonce {name}',
  'promos.event': '{name}',
  'promos.eventAt': '{name}, {date}',
  'promos.plays':
    'Diffusée {today} fois aujourd’hui · {week} en 7 jours · {total} au total · {planned} prévues',
  'promos.lastAired': 'Dernière diffusion le {date}',
  'promos.neverAired': 'Jamais diffusée',
  'promos.edit': 'Modifier',
  'promos.playsButton': 'Diffusions',
  'promos.delete': 'Supprimer',
  'promos.deleteConfirm':
    '« {title} » ne sera plus une promo ? La voix reste dans la médiathèque ; ses diffusions prévues sont annulées.',
  'promos.deleted': 'Promo retirée.',

  'status.scheduled': 'Programmée',
  'status.active': 'Active',
  'status.expired': 'Expirée',
  'status.disabled': 'Désactivée',

  'form.newTitle': 'Nouvelle promo',
  'form.editTitle': 'Modifier la promo',
  'form.description':
    'Ses dates de début et de fin sont celles de la voix : elle ne passe jamais en dehors. Heures de la station.',
  'form.asset': 'Voix',
  'form.assetChoose': 'Choisir une voix',
  'form.assetChange': 'Changer',
  'form.assetMissing': 'Choisissez la voix de la promo.',
  'form.startAt': 'Début',
  'form.killAt': 'Fin',
  'form.dateHelp': 'Vide : sans limite.',
  'form.datePartial': 'Ajoutez aussi l’heure (ou la date) : d’ici là, elle n’est pas enregistrée.',
  'form.killBeforeStart': 'La fin doit être après le début.',
  'form.show': 'Émission',
  'form.showNone': 'Aucune émission',
  'form.eventName': 'Événement',
  'form.eventPlaceholder': 'Concert au Marché Gare',
  'form.eventAt': 'Date de l’événement',
  'form.useEventAsKill': 'Finir à l’événement',
  'form.weight': 'Poids',
  'form.weightHelp': 'Part des diffusions de ses groupes : 2 passe deux fois plus que 1.',
  'form.maxPlaysPerDay': 'Diffusions par jour au plus',
  'form.maxHelp': 'Vide : sans plafond.',
  'form.pools': 'Groupes',
  'form.noPools':
    'Aucun groupe de promos : créez-en un d’abord, ou enregistrez maintenant et ajoutez-le plus tard.',
  'form.noPoolWarning': 'Sans groupe, la promo est gardée mais ne passe jamais.',
  'form.dayparts': 'Tranches horaires',
  'form.daypartsHelp': 'Quand elle peut passer. Aucune : à toute heure.',
  'form.daypartAdd': 'Ajouter une tranche',
  'form.daypartRemove': 'Retirer la tranche',
  'form.daypartFrom': 'De',
  'form.daypartTo': 'À',
  'form.daypartNoDay': 'Choisissez au moins un jour : cette tranche est ignorée d’ici là.',
  'form.enabled': 'Active',
  'form.create': 'Créer',
  'form.save': 'Enregistrer',
  'form.invalid': 'Vérifiez les champs signalés.',
  'form.conflict':
    'Quelqu’un a enregistré cette promo entre-temps : elle a été rechargée. Refaites vos modifications.',

  'picker.title': 'Choisir une voix',
  'picker.description': 'Les voix de la médiathèque.',
  'picker.search': 'Chercher une voix',
  'picker.noResults': 'Aucune voix trouvée.',
  'picker.choose': 'Choisir',

  'plays.title': 'Diffusions de « {title} »',
  'plays.description': 'Des 7 derniers jours aux 7 prochains, heure de la station.',
  'plays.byDay': 'Diffusions par jour',
  'plays.list': 'Diffusions',
  'plays.empty': 'Rien de diffusé ni de prévu sur cette période.',
  'plays.aired': 'Diffusée',
  'plays.planned': 'Prévue',
  'plays.placed': 'Prévue',
  'plays.pending': 'En cours de placement',
  'plays.dropped': 'Annulée',
  'plays.openLog': 'Ouvrir le conducteur',
  'plays.openSegue': 'Ouvrir l’enchaînement',

  'weekday.1': 'lun.',
  'weekday.2': 'mar.',
  'weekday.3': 'mer.',
  'weekday.4': 'jeu.',
  'weekday.5': 'ven.',
  'weekday.6': 'sam.',
  'weekday.7': 'dim.',

  'error.promo_exists': 'Cette voix est déjà une promo.',
  'error.not_a_voice_track': 'Seules les voix peuvent être des promos.',
  'error.unknown_asset': 'Cette voix n’est plus dans la station.',
  'error.unknown_pool': 'Un des groupes n’est plus dans la station.',
  'error.unknown_show': 'L’émission n’est plus dans la station.',
  'error.name_taken': 'Un groupe porte déjà ce nom.',
};

export type PromoMessageKey = keyof typeof en;
const messages: Record<Locale, Record<PromoMessageKey, string>> = { en, fr };

export type PromoT = (key: PromoMessageKey, params?: Record<string, string | number>) => string;

/** The promos dictionary in the current locale, `{name}` placeholders included. */
export function usePromoT(): PromoT {
  const { locale } = useI18n();
  return (key, params) => {
    const template = messages[locale][key];
    if (!params) return template;
    return template.replace(/\{(\w+)\}/g, (match, name: string) =>
      name in params ? String(params[name]) : match,
    );
  };
}

/** An api error in words: the promos module's own codes, else the app's messages. */
export function usePromoError() {
  const t = usePromoT();
  const generic = useErrorMessage();
  return (error: unknown): string => {
    if (isApiError(error)) {
      const key = `error.${error.code}` as PromoMessageKey;
      if (key in en) return t(key);
    }
    return generic(error);
  };
}
