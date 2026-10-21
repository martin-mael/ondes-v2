import type { RotationRuleKind, RuleViolation } from '@ondes/shared';
import { useI18n } from '../../../app/i18n/i18n.tsx';
import type { Locale } from '../../../app/i18n/messages.ts';

// Rotation rules strings (#38), English and French. `fr` must have `en`'s keys.

const en = {
  title: 'Rotation rules',
  description:
    'Separation and rotation rules applied to every song the scheduler picks. Rules higher in the list matter more.',
  ladder:
    'When no song satisfies every rule, the lowest enabled rule that may be relaxed is dropped first, then the next one up. Each relaxation is recorded on the log item.',
  'ladder.order': 'Relaxation order',
  'ladder.none': 'No rule can be relaxed.',
  forbidden: "You don't have access to this station's rotation rules.",
  defaults: 'This station uses the default rules.',
  save: 'Save',
  saved: 'Rules saved.',
  reset: 'Undo changes',
  invalid: 'Some rules are incomplete.',
  empty: 'No rule: the scheduler only follows each category’s rotation order.',
  add: 'Add a rule',
  'add.kind': 'Rule to add',
  'rule.enabled': 'Enabled',
  'rule.breakable': 'May be relaxed',
  'rule.up': 'Move up',
  'rule.down': 'Move down',
  'rule.remove': 'Remove',
  'rule.priority': 'Priority {priority}',
  'rule.soft': 'Soft goal: reorders songs, never blocks one.',

  'kind.song_rest': 'Song rest',
  'kind.max_plays': 'Max plays per day and week',
  'kind.search_depth': 'Search depth',
  'kind.artist_separation': 'Artist separation',
  'kind.title_separation': 'Title separation',
  'kind.album_separation': 'Album separation',
  'kind.same_hour_yesterday': 'Not the same hour as yesterday',
  'kind.tag_run': 'Tag run limit',
  'kind.segue_ban': 'Segue ban',
  'kind.max_tag_per_hour': 'Max tag per hour',
  'kind.flow': 'Tempo and energy flow',

  'help.song_rest': 'Uses each category’s rest time.',
  'help.max_plays':
    'Uses each category’s daily and weekly caps (station-local days, Monday weeks).',
  'help.search_depth': 'Uses each category’s search depth.',
  'help.same_hour_yesterday': 'A song doesn’t play in the same time window as the day before.',

  'field.value': 'Separation',
  'field.unit': 'Unit',
  'unit.minutes': 'minutes',
  'unit.items': 'songs',
  'field.includeFeatured': 'Count featured artists',
  'field.window': 'Window',
  'window.option': '{minutes} min',
  'field.tagKey': 'Tag',
  'field.tagValue': 'Value',
  'field.maxRun': 'Max in a row',
  'field.from': 'After',
  'field.to': 'Never play',
  'field.max': 'Max per hour',
  'field.maxBpmStep': 'Max BPM step',
  'field.maxEnergyStep': 'Max energy step (0–1)',
  'field.none': 'Off',

  'try.title': 'Try a pick',
  'try.description':
    'Runs the rules above (saved or not) on a category, against what aired and what is planned.',
  'try.category': 'Category',
  'try.at': 'Time',
  'try.run': 'Pick',
  'try.noCategory': 'Create a category first.',
  'try.picked': 'Picked: {title}',
  'try.nothing':
    'No song can fill this slot: every candidate breaks a rule that may not be relaxed.',
  'try.noCandidates': 'This category has no song to schedule at that time.',
  'try.clean': 'Every rule is satisfied.',
  'try.relaxed': 'Relaxed: {rule}',
  'try.relaxedWhy':
    'No song satisfied every rule, so this lower-priority rule was relaxed. The pick breaks it:',
  'try.candidates': 'Candidates in rotation order',
  'try.eligible': 'Eligible',

  'v.song_rest': 'Played {minutes} min away; rest is {limit} min.',
  'v.max_plays.day': 'Already {plays} plays today (max {limit}).',
  'v.max_plays.week': 'Already {plays} plays this week (max {limit}).',
  'v.search_depth': 'Position {position} is past the search depth ({limit}).',
  'v.artist_separation.minutes': 'Same artist {minutes} min away (needs {limit}).',
  'v.artist_separation.items': 'Same artist {items} songs away (needs {limit}).',
  'v.title_separation.minutes': 'Same title {minutes} min away (needs {limit}).',
  'v.title_separation.items': 'Same title {items} songs away (needs {limit}).',
  'v.album_separation.minutes': 'Same album {minutes} min away (needs {limit}).',
  'v.album_separation.items': 'Same album {items} songs away (needs {limit}).',
  'v.same_hour_yesterday': 'Played in the same {window} min window yesterday.',
  'v.tag_run': 'Would make {run} × {tag} in a row (max {limit}).',
  'v.segue_ban': '{to} right after {from}.',
  'v.max_tag_per_hour': '{plays} × {tag} already this hour (max {limit}).',
  'v.flow.bpm': 'BPM step of {step} (goal ≤ {limit}).',
  'v.flow.energy': 'Energy step of {step} (goal ≤ {limit}).',
};

export type RulesMessageKey = keyof typeof en;

const fr: Record<RulesMessageKey, string> = {
  title: 'Règles de rotation',
  description:
    'Règles de séparation et de rotation appliquées à chaque titre choisi par le programmateur. Les règles en haut de la liste comptent davantage.',
  ladder:
    'Quand aucun titre ne respecte toutes les règles, la règle active la plus basse qui peut être assouplie est levée en premier, puis la suivante. Chaque assouplissement est noté sur l’élément du conducteur.',
  'ladder.order': 'Ordre d’assouplissement',
  'ladder.none': 'Aucune règle ne peut être assouplie.',
  forbidden: 'Vous n’avez pas accès aux règles de rotation de cette station.',
  defaults: 'Cette station utilise les règles par défaut.',
  save: 'Enregistrer',
  saved: 'Règles enregistrées.',
  reset: 'Annuler les modifications',
  invalid: 'Certaines règles sont incomplètes.',
  empty: 'Aucune règle : le programmateur suit seulement l’ordre de rotation de chaque catégorie.',
  add: 'Ajouter une règle',
  'add.kind': 'Règle à ajouter',
  'rule.enabled': 'Active',
  'rule.breakable': 'Peut être assouplie',
  'rule.up': 'Monter',
  'rule.down': 'Descendre',
  'rule.remove': 'Supprimer',
  'rule.priority': 'Priorité {priority}',
  'rule.soft': 'Objectif souple : réordonne les titres, n’en bloque aucun.',

  'kind.song_rest': 'Repos du titre',
  'kind.max_plays': 'Passages max par jour et par semaine',
  'kind.search_depth': 'Profondeur de recherche',
  'kind.artist_separation': 'Séparation des artistes',
  'kind.title_separation': 'Séparation des titres',
  'kind.album_separation': 'Séparation des albums',
  'kind.same_hour_yesterday': 'Pas à la même heure que la veille',
  'kind.tag_run': 'Tag à la suite',
  'kind.segue_ban': 'Enchaînement interdit',
  'kind.max_tag_per_hour': 'Tag max par heure',
  'kind.flow': 'Fluidité tempo et énergie',

  'help.song_rest': 'Utilise le temps de repos de chaque catégorie.',
  'help.max_plays':
    'Utilise les plafonds quotidien et hebdomadaire de chaque catégorie (jours de la station, semaines du lundi).',
  'help.search_depth': 'Utilise la profondeur de recherche de chaque catégorie.',
  'help.same_hour_yesterday': 'Un titre ne repasse pas dans la même plage horaire que la veille.',

  'field.value': 'Séparation',
  'field.unit': 'Unité',
  'unit.minutes': 'minutes',
  'unit.items': 'titres',
  'field.includeFeatured': 'Compter les artistes invités',
  'field.window': 'Plage',
  'window.option': '{minutes} min',
  'field.tagKey': 'Tag',
  'field.tagValue': 'Valeur',
  'field.maxRun': 'Max à la suite',
  'field.from': 'Après',
  'field.to': 'Ne jamais passer',
  'field.max': 'Max par heure',
  'field.maxBpmStep': 'Écart de BPM max',
  'field.maxEnergyStep': 'Écart d’énergie max (0–1)',
  'field.none': 'Désactivé',

  'try.title': 'Essayer un choix',
  'try.description':
    'Applique les règles ci-dessus (enregistrées ou non) à une catégorie, selon ce qui est passé et ce qui est prévu.',
  'try.category': 'Catégorie',
  'try.at': 'Heure',
  'try.run': 'Choisir',
  'try.noCategory': 'Créez d’abord une catégorie.',
  'try.picked': 'Choisi : {title}',
  'try.nothing':
    'Aucun titre ne peut remplir ce créneau : chaque candidat enfreint une règle qui ne peut pas être assouplie.',
  'try.noCandidates': 'Cette catégorie n’a aucun titre programmable à cette heure.',
  'try.clean': 'Toutes les règles sont respectées.',
  'try.relaxed': 'Assouplie : {rule}',
  'try.relaxedWhy':
    'Aucun titre ne respectait toutes les règles : cette règle moins prioritaire a été assouplie. Le titre choisi l’enfreint :',
  'try.candidates': 'Candidats dans l’ordre de rotation',
  'try.eligible': 'Éligible',

  'v.song_rest': 'Passé à {minutes} min ; repos de {limit} min.',
  'v.max_plays.day': 'Déjà {plays} passages aujourd’hui (max {limit}).',
  'v.max_plays.week': 'Déjà {plays} passages cette semaine (max {limit}).',
  'v.search_depth': 'Position {position} au-delà de la profondeur de recherche ({limit}).',
  'v.artist_separation.minutes': 'Même artiste à {minutes} min (il en faut {limit}).',
  'v.artist_separation.items': 'Même artiste à {items} titres (il en faut {limit}).',
  'v.title_separation.minutes': 'Même titre à {minutes} min (il en faut {limit}).',
  'v.title_separation.items': 'Même titre à {items} titres (il en faut {limit}).',
  'v.album_separation.minutes': 'Même album à {minutes} min (il en faut {limit}).',
  'v.album_separation.items': 'Même album à {items} titres (il en faut {limit}).',
  'v.same_hour_yesterday': 'Passé dans la même plage de {window} min hier.',
  'v.tag_run': 'Ferait {run} × {tag} à la suite (max {limit}).',
  'v.segue_ban': '{to} juste après {from}.',
  'v.max_tag_per_hour': 'Déjà {plays} × {tag} cette heure-ci (max {limit}).',
  'v.flow.bpm': 'Écart de BPM de {step} (objectif ≤ {limit}).',
  'v.flow.energy': 'Écart d’énergie de {step} (objectif ≤ {limit}).',
};

const messages: Record<Locale, Record<RulesMessageKey, string>> = { en, fr };

export type RulesT = (key: RulesMessageKey, params?: Record<string, string | number>) => string;

/** The rules dictionary in the current locale, `{name}` placeholders included. */
export function useRulesT(): RulesT {
  const { locale } = useI18n();
  return (key, params) => {
    const template = messages[locale][key];
    if (!params) return template;
    return template.replace(/\{(\w+)\}/g, (match, name: string) =>
      name in params ? String(params[name]) : match,
    );
  };
}

/** A rule kind's name; unknown kinds (from a newer api) as they are. */
export function kindLabel(t: RulesT, kind: string): string {
  const key = `kind.${kind}`;
  return key in en ? t(key as RulesMessageKey) : kind;
}

/** A violation in words, from its kind and values (the api's `detail` is English only). */
export function violationText(t: RulesT, v: RuleViolation): string {
  const kind = v.kind as RotationRuleKind;
  const variant =
    kind === 'max_plays'
      ? `.${v.values.window}`
      : kind === 'flow'
        ? `.${v.values.measure}`
        : kind.endsWith('_separation')
          ? 'minutes' in v.values
            ? '.minutes'
            : '.items'
          : '';
  const key = `v.${kind}${variant}`;
  return key in en ? t(key as RulesMessageKey, v.values) : v.detail;
}
