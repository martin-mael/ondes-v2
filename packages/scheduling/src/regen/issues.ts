import type { LocalDate } from '@ondes/shared';
import type { GeneratorIssue, GeneratorIssueCode } from '../generator/index.ts';

// The generator's issues as one alert per day (#101, ADR 0030). `episode_missing` is left out:
// the missing-episode check (#47, ADR 0022) raises its own alerts, with lead times and
// fallbacks. `vt_placeholder` is left out too: an unplaced voice track is a hole in the plan
// the timeline already shows, not something to page anyone about.

const ALERTED: ReadonlySet<GeneratorIssueCode> = new Set([
  'no_clock',
  'unknown_clock',
  'unfilled_slot',
  'underfilled_clock',
  'occurrence_dropped',
  'occurrence_overlap',
]);

/** Issues worth an alert. */
export function alertedIssues(issues: readonly GeneratorIssue[]): GeneratorIssue[] {
  return issues.filter((i) => ALERTED.has(i.code));
}

/** Counts per code. */
export function issueCounts(
  issues: readonly { code: GeneratorIssueCode }[],
): Partial<Record<GeneratorIssueCode, number>> {
  const counts: Partial<Record<GeneratorIssueCode, number>> = {};
  for (const issue of issues) counts[issue.code] = (counts[issue.code] ?? 0) + 1;
  return counts;
}

/** The alert's dedupe key for a day: one open alert per station and local date. */
export const generationAlertKey = (localDate: LocalDate) => `log.generation_issues:${localDate}`;
