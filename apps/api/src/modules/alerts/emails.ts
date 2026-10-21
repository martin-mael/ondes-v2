import type { Alert } from '@ondes/shared';
import { defineTemplate } from '../../plugins/mail.ts';

// Alert emails: sent to the station's alert managers when an alert becomes critical.

export const criticalAlertTemplate = defineTemplate<{
  name: string;
  stationName: string;
  alert: Pick<Alert, 'title' | 'message' | 'raisedAt' | 'type'>;
  escalated: boolean;
  link: string;
}>({
  subject: ({ stationName, alert }) => `[${stationName}] ${alert.title}`,
  text: ({ name, stationName, alert, escalated, link }) =>
    `Hello ${name},

${escalated ? 'An alert on' : 'Critical alert on'} ${stationName}${escalated ? ' is now critical' : ''}: ${alert.title}
${alert.message ? `\n${alert.message}\n` : ''}
Raised at ${alert.raisedAt.toISOString()} (${alert.type}).

See it and acknowledge it:

${link}

You get this email because you manage alerts for ${stationName}.`,
});
