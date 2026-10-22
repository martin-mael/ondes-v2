import { defineTemplate } from '../../../plugins/mail.ts';

// Missing-episode email (#47): to the show's hosts and the station's programmers, at T−48h and
// T−6h. Times are the station's, never the server's or UTC.

export const missingEpisodeTemplate = defineTemplate<{
  name: string;
  stationName: string;
  showName: string;
  /** The occurrence's start on the station's clock, already formatted. */
  airsAt: string;
  /** "in 48 hours" / "in 6 hours". */
  lead: string;
  /** What airs instead if the audio still isn't there an hour before. */
  fallback: string;
  link: string;
}>({
  subject: ({ stationName, showName, airsAt }) =>
    `[${stationName}] ${showName}: episode missing for ${airsAt}`,
  text: ({ name, stationName, showName, airsAt, lead, fallback, link }) =>
    `Hello ${name},

${showName} airs on ${stationName} ${lead}, ${airsAt}, and its episode has no audio yet.

If the audio still isn't there an hour before, ${fallback}.

Upload the episode here:

${link}

You get this email because you host ${showName} or program ${stationName}.`,
});

/** "Sunday 15 November 2026, 20:00" on the station's clock. */
export function formatStationTime(at: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? '';
  return `${get('weekday')} ${get('day')} ${get('month')} ${get('year')}, ${get('hour')}:${get('minute')}`;
}
