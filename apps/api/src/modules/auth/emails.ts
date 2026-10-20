import { defineTemplate } from '../../plugins/mail.ts';

// Auth emails. Links point at the web app (#9), which posts the token back to the api.

export const verifyEmailTemplate = defineTemplate<{ name: string; link: string }>({
  subject: () => 'Confirm your email address',
  text: ({ name, link }) =>
    `Hello ${name},

Confirm your email address to finish creating your Ondes account:

${link}

The link expires in 48 hours. If you didn't sign up, ignore this email.`,
});

export const resetPasswordTemplate = defineTemplate<{ name: string; link: string }>({
  subject: () => 'Reset your password',
  text: ({ name, link }) =>
    `Hello ${name},

Someone asked to reset the password of your Ondes account. To choose a new one:

${link}

The link expires in 1 hour and works once. If it wasn't you, ignore this email: your password
stays the same.`,
});

export const invitationTemplate = defineTemplate<{
  inviter: string;
  orgName: string;
  /** Station name for station roles. */
  stationName: string | null;
  role: string;
  link: string;
  expiresAt: Date;
}>({
  subject: ({ orgName }) => `You're invited to ${orgName} on Ondes`,
  text: ({ inviter, orgName, stationName, role, link, expiresAt }) =>
    `${inviter} invited you to join ${orgName}${stationName ? ` (${stationName})` : ''} as ${role.replace('_', ' ')}.

Accept the invitation:

${link}

It expires on ${expiresAt.toUTCString()}.`,
});
