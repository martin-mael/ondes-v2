import { useCallback } from 'react';
import { useI18n } from '../../app/i18n/i18n.tsx';
import type { Locale } from '../../app/i18n/messages.ts';

// Strings of the alerts page and the dashboard's health panels (#71), English and French.
// `fr` must have every key.

const en = {
  title: 'Alerts',
  description: 'Problems on air and ahead. An alert closes once its cause is gone.',
  'filter.status': 'Status',
  'filter.type': 'Type',
  'filter.allTypes': 'All types',
  'status.open': 'Open',
  'status.resolved': 'Resolved',
  'status.all': 'All',
  'severity.critical': 'Critical',
  'severity.warning': 'Warning',
  'severity.info': 'Info',
  empty: 'No alerts here.',
  emptyOpen: 'All clear: nothing needs attention.',
  more: 'Show older alerts',
  acknowledge: 'Acknowledge',
  acknowledged: 'Acknowledged',
  acknowledgedAt: 'Acknowledged {time}',
  resolve: 'Resolve',
  resolvedToast: 'Alert resolved',
  acknowledgedToast: 'Alert acknowledged',
  raisedAt: 'Raised {time}',
  lastSeenAt: 'last seen {time}',
  resolvedAt: 'Resolved {time}',
  occurrences: '{count} times',
  'error.alert_resolved': 'This alert is already resolved.',

  // Types (known ones; others show their raw type).
  'type.engine.silence': 'Silence on air',
  'type.engine.down': 'Engine not responding',
  'type.engine.restart_storm': 'Engine crash loop',
  'type.engine.restarted': 'Engine restarts',
  'type.engine.safety_mode': 'Safety mode',
  'type.engine.safety_empty': 'Safety playlist empty',
  'type.engine.emergency_missing': 'No emergency file',
  'type.stream.source_missing': 'Stream without source',
  'type.stream.config_invalid': 'Stream settings invalid',
  'type.stream.icecast_unreachable': 'Icecast unreachable',
  'type.cache.item_missing': 'Uncached item',
  'type.cache.horizon_degraded': 'Cache incomplete',
  'type.cache.budget_exceeded': 'Cache budget exceeded',
  'type.cache.source_missing': 'File missing in storage',
  'type.cache.checksum_mismatch': 'Corrupted file',
  'type.cache.disk_low': 'Cache disk low',
  'type.cache.sync_failing': 'Cache sync failing',
  'type.feeder.items_skipped': 'Items skipped',
  'type.feeder.log_empty': 'Log empty',
  'type.show.episode_missing': 'Missing episode',
  'type.island.render_failed': 'Failed render',
  'type.log.generation_issues': 'Log generation issues',
  'type.live.slot_missed': 'Live slot missed',

  // `details.i18n` of failed renders and engine restarts (#71).
  islandRenderFailed:
    'A voice-track transition couldn’t be rendered ({error}). It will air {when} as a plain crossfade with the voice laid over.',
  islandRenderFailedNoTime:
    'A voice-track transition couldn’t be rendered ({error}). It will air as a plain crossfade with the voice laid over.',
  engineRestarted:
    'The station engine crashed and restarted ({restarts} restarts in the last {minutes} min). The stream may have dropped for a few seconds.',
  engineRecreated:
    'The station engine stopped and was recreated ({restarts} restarts in the last {minutes} min). The stream may have dropped for a few seconds.',

  // `details.i18n` of log generation alerts (#101).
  'logRegen.issues': 'Log for {date}: {total} generation issues',

  // `details.i18n` of missing-episode alerts (#47).
  'episodeMissing.ahead': '{show} airs {when} and its episode has no audio yet. {next}',
  'episodeMissing.fallback': '{show} airs {when} without its episode: {fallback} instead.',
  'episodeMissing.noFallback': '{show} airs {when} without its episode, and {reason}.',
  'episodeMissing.title': 'Missing episode: {show}',
  'episodeMissing.next.latest_episode':
    'If it’s still missing an hour before, the latest episode airs again.',
  'episodeMissing.next.episode':
    'If it’s still missing an hour before, the episode chosen in the show settings airs again.',
  'episodeMissing.next.clock_music':
    'If it’s still missing an hour before, music from the clock airs.',
  'episodeMissing.next.none':
    'If it’s still missing an hour before, nothing is planned: the safety playlist plays.',
  'episodeMissing.fallback.latest_episode': 'the latest episode airs again',
  'episodeMissing.fallback.episode': 'the episode chosen in the show settings airs again',
  'episodeMissing.fallback.clock_music': 'music from the clock airs',
  'episodeMissing.reason.no_log_item': 'the log has no item for it',
  'episodeMissing.reason.no_fallback': 'no fallback can air',

  // Dashboard panels.
  'engine.title': 'Engine',
  'engine.up': 'Running',
  'engine.down': 'Not responding',
  'engine.unknown': 'Starting…',
  'engine.stopped': 'Stopped',
  'engine.unmonitored': 'Not monitored',
  'engine.storm': 'Crash loop: restarts stopped',
  'engine.restartPending': 'A settings change waits for a restart',
  'engine.restarts': '{count} restarts in the last {minutes} min',
  'engine.noRestarts': 'No restart lately',
  'engine.unavailable': 'Engine status unavailable.',

  'live.title': 'Live sources',
  'live.none': 'No DJ connected.',
  'live.disabled': 'The live input is off for this station.',
  'live.unreachable': 'The engine isn’t answering: live sources unknown.',
  'live.input': 'Input {input}',
  'live.onAir': 'On air',
  'live.ready': 'Ready',
  'live.buffering': 'Buffering',
  'live.unknownDj': 'Unknown DJ',
  'live.preListen': 'Pre-listen',
  'live.stopListen': 'Stop',
  'live.preListenUnavailable': 'Pre-listen isn’t available for this input.',

  'listeners.title': 'Listeners',
  'listeners.now': 'now',
  'listeners.none': 'No listener data: the stats poller isn’t running, or Icecast can’t be read.',
  'listeners.fallback': 'on fallback',
  'listeners.graph': 'Last 24 hours',
  'listeners.total': 'Total',
  'listeners.noData': 'No data',

  'alerts.title': 'Open alerts',
  'alerts.all': 'All alerts',
  'alerts.more': '{count} more',
} as const;

export type AlertMessageKey = keyof typeof en;

const fr: Record<AlertMessageKey, string> = {
  title: 'Alertes',
  description:
    'Les problèmes à l’antenne et à venir. Une alerte se ferme quand sa cause disparaît.',
  'filter.status': 'Statut',
  'filter.type': 'Type',
  'filter.allTypes': 'Tous les types',
  'status.open': 'Ouvertes',
  'status.resolved': 'Résolues',
  'status.all': 'Toutes',
  'severity.critical': 'Critique',
  'severity.warning': 'Attention',
  'severity.info': 'Info',
  empty: 'Aucune alerte ici.',
  emptyOpen: 'Tout va bien : rien ne demande d’attention.',
  more: 'Afficher les alertes plus anciennes',
  acknowledge: 'Prendre en charge',
  acknowledged: 'Prise en charge',
  acknowledgedAt: 'Prise en charge {time}',
  resolve: 'Résoudre',
  resolvedToast: 'Alerte résolue',
  acknowledgedToast: 'Alerte prise en charge',
  raisedAt: 'Levée {time}',
  lastSeenAt: 'vue pour la dernière fois {time}',
  resolvedAt: 'Résolue {time}',
  occurrences: '{count} fois',
  'error.alert_resolved': 'Cette alerte est déjà résolue.',

  'type.engine.silence': 'Silence à l’antenne',
  'type.engine.down': 'Le moteur ne répond pas',
  'type.engine.restart_storm': 'Moteur en boucle de plantages',
  'type.engine.restarted': 'Redémarrages du moteur',
  'type.engine.safety_mode': 'Mode secours',
  'type.engine.safety_empty': 'Playlist de secours vide',
  'type.engine.emergency_missing': 'Pas de fichier d’urgence',
  'type.stream.source_missing': 'Flux sans source',
  'type.stream.config_invalid': 'Réglages de flux invalides',
  'type.stream.icecast_unreachable': 'Icecast injoignable',
  'type.cache.item_missing': 'Élément hors cache',
  'type.cache.horizon_degraded': 'Cache incomplet',
  'type.cache.budget_exceeded': 'Budget du cache dépassé',
  'type.cache.source_missing': 'Fichier absent du stockage',
  'type.cache.checksum_mismatch': 'Fichier corrompu',
  'type.cache.disk_low': 'Disque du cache presque plein',
  'type.cache.sync_failing': 'Synchronisation du cache en échec',
  'type.feeder.items_skipped': 'Éléments sautés',
  'type.feeder.log_empty': 'Conducteur vide',
  'type.show.episode_missing': 'Épisode manquant',
  'type.island.render_failed': 'Rendu en échec',
  'type.log.generation_issues': 'Problèmes de génération du conducteur',
  'type.live.slot_missed': 'Créneau direct manqué',

  'logRegen.issues': 'Conducteur du {date} : {total} problèmes de génération',

  islandRenderFailed:
    'Une transition avec voix n’a pas pu être rendue ({error}). Elle passera {when} en simple fondu enchaîné, la voix par-dessus.',
  islandRenderFailedNoTime:
    'Une transition avec voix n’a pas pu être rendue ({error}). Elle passera en simple fondu enchaîné, la voix par-dessus.',
  engineRestarted:
    'Le moteur de la station a planté et redémarré ({restarts} redémarrages ces {minutes} dernières min). Le flux a pu couper quelques secondes.',
  engineRecreated:
    'Le moteur de la station s’est arrêté et a été recréé ({restarts} redémarrages ces {minutes} dernières min). Le flux a pu couper quelques secondes.',

  'episodeMissing.ahead': '{show} passe {when} et son épisode n’a pas encore d’audio. {next}',
  'episodeMissing.fallback': '{show} passe {when} sans son épisode : {fallback} à la place.',
  'episodeMissing.noFallback': '{show} passe {when} sans son épisode, et {reason}.',
  'episodeMissing.title': 'Épisode manquant : {show}',
  'episodeMissing.next.latest_episode':
    'S’il manque encore une heure avant, le dernier épisode est rediffusé.',
  'episodeMissing.next.episode':
    'S’il manque encore une heure avant, l’épisode choisi dans les réglages de l’émission est rediffusé.',
  'episodeMissing.next.clock_music':
    'S’il manque encore une heure avant, la musique de l’horloge passe.',
  'episodeMissing.next.none':
    'S’il manque encore une heure avant, rien n’est prévu : la playlist de secours passe.',
  'episodeMissing.fallback.latest_episode': 'le dernier épisode est rediffusé',
  'episodeMissing.fallback.episode':
    'l’épisode choisi dans les réglages de l’émission est rediffusé',
  'episodeMissing.fallback.clock_music': 'la musique de l’horloge passe',
  'episodeMissing.reason.no_log_item': 'le conducteur n’a pas d’élément pour lui',
  'episodeMissing.reason.no_fallback': 'aucun remplacement ne peut passer',

  'engine.title': 'Moteur',
  'engine.up': 'En marche',
  'engine.down': 'Ne répond pas',
  'engine.unknown': 'Démarrage…',
  'engine.stopped': 'Arrêté',
  'engine.unmonitored': 'Non surveillé',
  'engine.storm': 'Boucle de plantages : redémarrages arrêtés',
  'engine.restartPending': 'Un changement de réglages attend un redémarrage',
  'engine.restarts': '{count} redémarrages ces {minutes} dernières min',
  'engine.noRestarts': 'Aucun redémarrage récent',
  'engine.unavailable': 'État du moteur indisponible.',

  'live.title': 'Sources en direct',
  'live.none': 'Aucun animateur connecté.',
  'live.disabled': 'L’entrée direct est désactivée pour cette station.',
  'live.unreachable': 'Le moteur ne répond pas : sources en direct inconnues.',
  'live.input': 'Entrée {input}',
  'live.onAir': 'À l’antenne',
  'live.ready': 'Prête',
  'live.buffering': 'Mise en mémoire',
  'live.unknownDj': 'Animateur inconnu',
  'live.preListen': 'Pré-écoute',
  'live.stopListen': 'Arrêter',
  'live.preListenUnavailable': 'La pré-écoute n’est pas disponible pour cette entrée.',

  'listeners.title': 'Auditeurs',
  'listeners.now': 'maintenant',
  'listeners.none':
    'Pas de données d’audience : le relevé n’est pas lancé, ou Icecast ne peut pas être lu.',
  'listeners.fallback': 'sur le flux de repli',
  'listeners.graph': 'Dernières 24 heures',
  'listeners.total': 'Total',
  'listeners.noData': 'Pas de données',

  'alerts.title': 'Alertes ouvertes',
  'alerts.all': 'Toutes les alertes',
  'alerts.more': '{count} de plus',
};

const messages: Record<Locale, Record<AlertMessageKey, string>> = { en, fr };

export type AlertT = (key: AlertMessageKey, params?: Record<string, string | number>) => string;

/** `t` for the alerts strings, in the app's current locale. */
export function useAlertT(): AlertT {
  const { locale } = useI18n();
  return useCallback(
    (key: AlertMessageKey, params?: Record<string, string | number>) =>
      messages[locale][key].replace(/\{(\w+)\}/g, (match, name: string) =>
        params && name in params ? String(params[name]) : match,
      ),
    [locale],
  );
}

/** Whether `key` is one of these strings (for keys built from api data). */
export const isAlertMessageKey = (key: string): key is AlertMessageKey => Object.hasOwn(en, key);
