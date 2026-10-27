import { useCallback } from 'react';
import { useI18n } from '../../app/i18n/i18n.tsx';
import type { Locale } from '../../app/i18n/messages.ts';

// Strings of the log timeline (#51), English and French. `fr` must have every key.

const en = {
  title: 'Log',
  description:
    'What airs, hour by hour. Edits to upcoming items reach the engine on its next re-plan.',
  timezone: 'Station time ({zone})',

  'nav.previousDay': 'Previous day',
  'nav.nextDay': 'Next day',
  'nav.date': 'Date',
  'nav.now': 'Now',
  'nav.hour': 'Jump to hour',

  'day.draft': 'Draft',
  'day.published': 'Published',
  'day.draftHint': 'Not on air: the engine only plays published days.',
  'day.publish': 'Publish',
  'day.unpublish': 'Back to draft',
  'day.published.toast': 'Day published: the feeder plays it',
  'day.draft.toast': 'Day back to draft',
  'day.empty': 'No log for this day yet.',
  'day.addFirst': 'Add an item',
  'day.addEnd': 'Add at the end of the day',
  'day.summary': '{count} items · {duration}',

  'onAir.title': 'On air',
  'onAir.none': 'Nothing from the log on air',
  'onAir.plan': 'Planned now (no as-run)',
  'onAir.started': 'since {time}',
  'onAir.next': 'Next: {title} at {time}',
  'onAir.jump': 'Show',

  'strip.label': 'Day timeline',
  'strip.zoomIn': 'Zoom in',
  'strip.zoomOut': 'Zoom out',
  'strip.now': 'Now',

  'hour.total': '{duration} planned',
  'hour.overrun': 'Overrun {duration}',
  'hour.gap': 'Underrun {duration}',
  'hour.relaxed': '{count} relaxed',
  'hour.empty': 'Nothing starts in this hour.',

  'col.planned': 'Planned',
  'col.actual': 'Aired',
  'col.item': 'Item',
  'col.duration': 'Length',

  'kind.song': 'Song',
  'kind.vt': 'Voice track',
  'kind.jingle': 'Jingle',
  'kind.bed': 'Bed',
  'kind.episode': 'Episode',
  'kind.live_slot': 'Live',
  'kind.marker': 'Marker',
  'kind.fill': 'Fill',
  'kind.segment': 'Island',

  'timing.hard': 'Hard {time}',
  'timing.soft': 'Soft {time}',
  'timing.not_before': 'Not before {time}',
  'timing.cap': 'up to {duration} late',

  'marker.times': 'Times: {title}',
  'marker.timesNothing': 'Times nothing: a timing point',
  'marker.met': 'Aired {delta}',
  'marker.missed': 'Aired {delta}: outside the marker',
  'marker.add': 'Add marker',
  'marker.edit': 'Edit marker…',
  'marker.addTitle': 'Add a marker',
  'marker.editTitle': 'Edit the marker',
  'marker.description':
    'A fixed time in the log (a top-of-hour ID, the news): it times the item right after it.',
  'marker.hour': 'Hour',
  'marker.minSec': 'Minutes:seconds',
  'marker.timing': 'Timing',
  'marker.timing.hard': 'Hard',
  'marker.timing.soft': 'Soft',
  'marker.timing.not_before': 'Not before',
  'marker.help.hard': 'Starts at the time: what is on air fades out under it.',
  'marker.help.soft':
    'The item on air ends first, at most the cap after the time (then it is cut); queued items after the time are skipped.',
  'marker.help.not_before':
    'Never before the time: the music before stretches, or the safety playlist waits. Never cut.',
  'marker.cap': 'Cap (seconds)',
  'marker.label': 'Label',
  'marker.labelPlaceholder': 'Top of hour, News…',
  'marker.save': 'Save marker',
  'marker.error.time': 'Enter minutes and seconds within the hour, e.g. 30:00.',
  'marker.error.past': 'This time has passed.',
  'marker.error.cap': 'The cap is 0 to 600 seconds.',
  'toast.markerAdded': 'Marker added',
  'toast.markerSaved': 'Marker saved',

  'state.on_air': 'On air',
  'state.queued': 'In the engine queue',
  'state.queuedHint': 'Probably pushed already: an edit reaches air on the feeder’s next re-plan.',
  'state.aired': 'Aired',

  'outcome.complete': 'Complete',
  'outcome.cut': 'Cut',
  'outcome.skipped': 'Skipped',
  'outcome.interrupted': 'Interrupted',
  drift: '{drift} vs plan',

  'badge.locked': 'Locked',
  'badge.relaxed': 'Rule relaxed',
  'relaxed.rule': 'Relaxed: {rule}',
  'badge.overrun': 'Overrun {duration}',
  'badge.gap': 'Gap {duration}',
  'badge.missing': 'Missing asset',
  'badge.show': 'Show',
  'badge.manual': 'Manual',

  'passedOver.title': 'Passed over',
  'passedOver.not_cached': 'Passed over: not in the playout cache',
  'passedOver.unresolvable': 'Passed over: the engine refused the file',
  'passedOver.no_media_file': 'Passed over: no playout file',
  'passedOver.dropped': 'Passed over: dropped to meet an anchor',
  'passedOver.expired': 'Passed over: outside its start and kill dates',

  untitled: 'Untitled',
  'segment.parts': '{count} parts',

  'action.menu': 'Actions for {title}',
  'action.preview': 'Listen',
  'action.previewTransition': 'Listen to the transition into the next item',
  'action.editSegue': 'Edit the segue into the next item',
  'action.insertBefore': 'Insert before…',
  'action.insertAfter': 'Insert after…',
  'action.replace': 'Replace…',
  'action.moveUp': 'Move up',
  'action.moveDown': 'Move down',
  'action.lock': 'Lock',
  'action.unlock': 'Unlock',
  'action.delete': 'Delete',
  'action.frozen': 'Already aired or on air: read-only.',
  'action.lockedHint': 'Unlock the item to change it.',
  'action.dragHint': 'Drag to move',

  'toast.inserted': 'Item inserted',
  'toast.replaced': 'Item replaced',
  'toast.moved': 'Item moved',
  'toast.locked': 'Item locked',
  'toast.unlocked': 'Item unlocked',
  'toast.deleted': 'Item deleted',
  'toast.onAir': 'The feeder re-plans the engine queue with this change.',

  'delete.title': 'Delete this item?',
  'delete.description': '“{title}” leaves the log; the items after it move up.',
  'delete.confirm': 'Delete',

  'picker.insertTitle': 'Insert an item',
  'picker.replaceTitle': 'Replace “{title}”',
  'picker.search': 'Search title, artist, album',
  'picker.kind': 'Type',
  'picker.fits': 'Fits the slot ({duration})',
  'picker.tolerance': 'Tolerance',
  'picker.delta': '{delta} vs slot',
  'picker.noResults': 'Nothing matches.',
  'picker.rulesHint':
    'The library list doesn’t check the rotation rules: check separation before you pick.',
  'picker.choose': 'Choose',
  'picker.listen': 'Listen to {title}',

  'picker.rulesSource':
    'Candidates from the rules engine for this slot: the pick first, then those that respect every rule.',
  'picker.source': 'Suggestions',
  'picker.source.rules': 'Rules',
  'picker.source.library': 'Library',
  'picker.category': 'Category',
  'picker.relaxed': 'To fill this slot, the rules engine relaxed:',
  'picker.bestPick': 'Rules pick',
  'picker.eligible': 'Respects every rule',
  'picker.pickFailed': 'The rules engine couldn’t suggest anything: pick from the library.',

  'rule.song_rest': 'Song rest',
  'rule.max_plays': 'Max plays per day and week',
  'rule.search_depth': 'Search depth',
  'rule.artist_separation': 'Artist separation',
  'rule.title_separation': 'Title separation',
  'rule.album_separation': 'Album separation',
  'rule.same_hour_yesterday': 'Not the same hour as yesterday',
  'rule.tag_run': 'Tag run limit',
  'rule.segue_ban': 'Segue ban',
  'rule.max_tag_per_hour': 'Max tag per hour',
  'rule.flow': 'Tempo and energy flow',

  'preview.playing': 'Listening: {title}',
  'preview.transition': 'Transition: {from} → {to}',
  'preview.stop': 'Stop',
  'preview.failed': 'Can’t play this audio.',
  'preview.noAudio': 'No audio file for this item yet: upload it in the library.',

  'error.log_item_locked': 'This item is locked: unlock it first.',
  'error.segment_part': 'Edit the island this item is a part of.',
  'error.log_item_aired': 'This item aired or is on air: it can’t change any more.',
  'error.edit_conflict': 'The log changed meanwhile. It’s reloaded: try again.',
  'error.invalid_placement': 'An item can’t go there.',
  forbidden: 'You can’t see this station’s log.',
};

export type TimelineMessageKey = keyof typeof en;

const fr: Record<TimelineMessageKey, string> = {
  title: 'Conducteur',
  description:
    'Ce qui passe à l’antenne, heure par heure. Les modifications à venir arrivent au moteur à sa prochaine replanification.',
  timezone: 'Heure de la station ({zone})',

  'nav.previousDay': 'Jour précédent',
  'nav.nextDay': 'Jour suivant',
  'nav.date': 'Date',
  'nav.now': 'Maintenant',
  'nav.hour': 'Aller à l’heure',

  'day.draft': 'Brouillon',
  'day.published': 'Publié',
  'day.draftHint': 'Pas à l’antenne : le moteur ne joue que les jours publiés.',
  'day.publish': 'Publier',
  'day.unpublish': 'Repasser en brouillon',
  'day.published.toast': 'Jour publié : le feeder le joue',
  'day.draft.toast': 'Jour repassé en brouillon',
  'day.empty': 'Pas encore de conducteur pour ce jour.',
  'day.addFirst': 'Ajouter un élément',
  'day.addEnd': 'Ajouter en fin de journée',
  'day.summary': '{count} éléments · {duration}',

  'onAir.title': 'À l’antenne',
  'onAir.none': 'Rien du conducteur à l’antenne',
  'onAir.plan': 'Prévu maintenant (pas d’as-run)',
  'onAir.started': 'depuis {time}',
  'onAir.next': 'Ensuite : {title} à {time}',
  'onAir.jump': 'Afficher',

  'strip.label': 'Frise de la journée',
  'strip.zoomIn': 'Zoomer',
  'strip.zoomOut': 'Dézoomer',
  'strip.now': 'Maintenant',

  'hour.total': '{duration} prévus',
  'hour.overrun': 'Dépassement {duration}',
  'hour.gap': 'Manque {duration}',
  'hour.relaxed': '{count} règles assouplies',
  'hour.empty': 'Rien ne commence dans cette heure.',

  'col.planned': 'Prévu',
  'col.actual': 'Diffusé',
  'col.item': 'Élément',
  'col.duration': 'Durée',

  'kind.song': 'Titre',
  'kind.vt': 'Voix enregistrée',
  'kind.jingle': 'Jingle',
  'kind.bed': 'Tapis',
  'kind.episode': 'Épisode',
  'kind.live_slot': 'Direct',
  'kind.marker': 'Repère',
  'kind.fill': 'Remplissage',
  'kind.segment': 'Îlot',

  'timing.hard': 'Fixe {time}',
  'timing.soft': 'Souple {time}',
  'timing.not_before': 'Pas avant {time}',
  'timing.cap': 'jusqu’à {duration} de retard',

  'marker.times': 'Cale : {title}',
  'marker.timesNothing': 'Ne cale rien : simple repère horaire',
  'marker.met': 'Diffusé {delta}',
  'marker.missed': 'Diffusé {delta} : hors du repère',
  'marker.add': 'Ajouter un repère',
  'marker.edit': 'Modifier le repère…',
  'marker.addTitle': 'Ajouter un repère',
  'marker.editTitle': 'Modifier le repère',
  'marker.description':
    'Une heure fixe dans le conducteur (l’ID du top horaire, le flash) : elle cale l’élément qui la suit.',
  'marker.hour': 'Heure',
  'marker.minSec': 'Minutes:secondes',
  'marker.timing': 'Calage',
  'marker.timing.hard': 'Fixe',
  'marker.timing.soft': 'Souple',
  'marker.timing.not_before': 'Pas avant',
  'marker.help.hard': 'Part à l’heure : ce qui est à l’antenne s’efface en fondu dessous.',
  'marker.help.soft':
    'L’élément à l’antenne finit d’abord, au plus tard le délai après l’heure (sinon il est coupé) ; les éléments en file après l’heure sont sautés.',
  'marker.help.not_before':
    'Jamais avant l’heure : la musique d’avant s’allonge, ou la playlist de secours attend. Jamais coupé.',
  'marker.cap': 'Délai max (secondes)',
  'marker.label': 'Libellé',
  'marker.labelPlaceholder': 'Top horaire, Flash…',
  'marker.save': 'Enregistrer le repère',
  'marker.error.time': 'Saisissez des minutes et secondes dans l’heure, par ex. 30:00.',
  'marker.error.past': 'Cette heure est passée.',
  'marker.error.cap': 'Le délai va de 0 à 600 secondes.',
  'toast.markerAdded': 'Repère ajouté',
  'toast.markerSaved': 'Repère enregistré',

  'state.on_air': 'À l’antenne',
  'state.queued': 'Dans la file du moteur',
  'state.queuedHint':
    'Sans doute déjà envoyé : une modification arrive à l’antenne à la prochaine replanification du feeder.',
  'state.aired': 'Diffusé',

  'outcome.complete': 'Complet',
  'outcome.cut': 'Coupé',
  'outcome.skipped': 'Sauté',
  'outcome.interrupted': 'Interrompu',
  drift: '{drift} par rapport au prévu',

  'badge.locked': 'Verrouillé',
  'badge.relaxed': 'Règle assouplie',
  'relaxed.rule': 'Assouplie : {rule}',
  'badge.overrun': 'Dépassement {duration}',
  'badge.gap': 'Trou {duration}',
  'badge.missing': 'Média manquant',
  'badge.show': 'Émission',
  'badge.manual': 'Manuel',

  'passedOver.title': 'Écarté',
  'passedOver.not_cached': 'Écarté : absent du cache de diffusion',
  'passedOver.unresolvable': 'Écarté : le moteur a refusé le fichier',
  'passedOver.no_media_file': 'Écarté : pas de fichier de diffusion',
  'passedOver.dropped': 'Écarté pour tenir un horaire',
  'passedOver.expired': 'Écarté : hors de ses dates de début et de fin',

  untitled: 'Sans titre',
  'segment.parts': '{count} parties',

  'action.menu': 'Actions pour {title}',
  'action.preview': 'Écouter',
  'action.previewTransition': 'Écouter l’enchaînement avec l’élément suivant',
  'action.editSegue': 'Modifier l’enchaînement avec l’élément suivant',
  'action.insertBefore': 'Insérer avant…',
  'action.insertAfter': 'Insérer après…',
  'action.replace': 'Remplacer…',
  'action.moveUp': 'Monter',
  'action.moveDown': 'Descendre',
  'action.lock': 'Verrouiller',
  'action.unlock': 'Déverrouiller',
  'action.delete': 'Supprimer',
  'action.frozen': 'Déjà diffusé ou à l’antenne : lecture seule.',
  'action.lockedHint': 'Déverrouillez l’élément pour le modifier.',
  'action.dragHint': 'Glisser pour déplacer',

  'toast.inserted': 'Élément inséré',
  'toast.replaced': 'Élément remplacé',
  'toast.moved': 'Élément déplacé',
  'toast.locked': 'Élément verrouillé',
  'toast.unlocked': 'Élément déverrouillé',
  'toast.deleted': 'Élément supprimé',
  'toast.onAir': 'Le feeder replanifie la file du moteur avec ce changement.',

  'delete.title': 'Supprimer cet élément ?',
  'delete.description': '« {title} » quitte le conducteur ; les éléments suivants remontent.',
  'delete.confirm': 'Supprimer',

  'picker.insertTitle': 'Insérer un élément',
  'picker.replaceTitle': 'Remplacer « {title} »',
  'picker.search': 'Chercher un titre, un artiste, un album',
  'picker.kind': 'Type',
  'picker.fits': 'Tient dans le créneau ({duration})',
  'picker.tolerance': 'Tolérance',
  'picker.delta': '{delta} par rapport au créneau',
  'picker.noResults': 'Aucun résultat.',
  'picker.rulesHint':
    'La liste de la médiathèque ne vérifie pas les règles de rotation : vérifiez la séparation avant de choisir.',
  'picker.choose': 'Choisir',
  'picker.listen': 'Écouter {title}',

  'picker.rulesSource':
    'Candidats du moteur de règles pour ce créneau : son choix d’abord, puis ceux qui respectent toutes les règles.',
  'picker.source': 'Suggestions',
  'picker.source.rules': 'Règles',
  'picker.source.library': 'Médiathèque',
  'picker.category': 'Catégorie',
  'picker.relaxed': 'Pour remplir ce créneau, le moteur de règles a assoupli :',
  'picker.bestPick': 'Choix des règles',
  'picker.eligible': 'Respecte toutes les règles',
  'picker.pickFailed': 'Le moteur de règles n’a rien proposé : choisissez dans la médiathèque.',

  'rule.song_rest': 'Repos du titre',
  'rule.max_plays': 'Passages max par jour et par semaine',
  'rule.search_depth': 'Profondeur de recherche',
  'rule.artist_separation': 'Séparation des artistes',
  'rule.title_separation': 'Séparation des titres',
  'rule.album_separation': 'Séparation des albums',
  'rule.same_hour_yesterday': 'Pas à la même heure que la veille',
  'rule.tag_run': 'Tag à la suite',
  'rule.segue_ban': 'Enchaînement interdit',
  'rule.max_tag_per_hour': 'Tag max par heure',
  'rule.flow': 'Fluidité tempo et énergie',

  'preview.playing': 'Écoute : {title}',
  'preview.transition': 'Enchaînement : {from} → {to}',
  'preview.stop': 'Arrêter',
  'preview.failed': 'Impossible de lire ce son.',
  'preview.noAudio':
    'Pas encore de fichier audio pour cet élément : importez-le dans la médiathèque.',

  'error.log_item_locked': 'Cet élément est verrouillé : déverrouillez-le d’abord.',
  'error.segment_part': 'Modifiez l’îlot dont cet élément fait partie.',
  'error.log_item_aired': 'Cet élément est déjà passé ou à l’antenne : il ne peut plus changer.',
  'error.edit_conflict': 'Le conducteur a changé entre-temps. Il est rechargé : réessayez.',
  'error.invalid_placement': 'Un élément ne peut pas aller là.',
  forbidden: 'Vous ne pouvez pas voir le conducteur de cette station.',
};

const messages: Record<Locale, Record<TimelineMessageKey, string>> = { en, fr };

export type TimelineT = (
  key: TimelineMessageKey,
  params?: Record<string, string | number>,
) => string;

/** `t` for the timeline's strings, in the app's current locale. */
export function useTimelineT(): TimelineT {
  const { locale } = useI18n();
  return useCallback(
    (key: TimelineMessageKey, params?: Record<string, string | number>) =>
      // A key built at runtime (`rule.<kind>` from a newer api) may be missing: it shows as is.
      (messages[locale][key] ?? key).replace(/\{(\w+)\}/g, (match, name: string) =>
        params && name in params ? String(params[name]) : match,
      ),
    [locale],
  );
}

/** A rotation rule kind (#38) in words; a kind this build doesn't know shows as it is. */
export function ruleLabel(t: TimelineT, kind: string): string {
  const key = `rule.${kind}` as TimelineMessageKey;
  return t(key);
}
