import { defineTemplate } from '../../plugins/mail.ts';

// Team onboarding emails (#113). Single invitations (one per bulk row too) use #6's template.

const roleName = (role: string) => role.replace('_', ' ');

export const domainVerificationTemplate = defineTemplate<{
  orgName: string;
  domain: string;
  inviter: string;
  link: string;
}>({
  subject: ({ domain }) => `Confirm that ${domain} belongs to your organization`,
  text: ({ orgName, domain, inviter, link }) =>
    `${inviter} asked to link the domain ${domain} to ${orgName} on Ondes. Once confirmed, people
with an @${domain} address can join ${orgName} (automatically or on request, as set up).

If you manage ${domain} and agree, confirm here:

${link}

The link expires in 48 hours. If you don't know what this is about, ignore this email.`,
});

export const joinRequestTemplate = defineTemplate<{
  orgName: string;
  name: string;
  email: string;
  link: string;
}>({
  subject: ({ orgName, name }) => `${name} asks to join ${orgName}`,
  text: ({ orgName, name, email, link }) =>
    `${name} (${email}) asked to join ${orgName} on Ondes.

Approve or refuse the request:

${link}`,
});

export const joinRequestDecisionTemplate = defineTemplate<{
  name: string;
  orgName: string;
  approved: boolean;
  role: string | null;
}>({
  subject: ({ orgName, approved }) =>
    approved ? `You've joined ${orgName}` : `Your request to join ${orgName}`,
  text: ({ name, orgName, approved, role }) =>
    approved
      ? `Hello ${name},

Your request to join ${orgName} on Ondes was approved${role ? `: you're now ${roleName(role)}` : ''}.`
      : `Hello ${name},

Your request to join ${orgName} on Ondes was refused. Contact the organization if you think it's a mistake.`,
});

export const autoJoinedTemplate = defineTemplate<{ name: string; orgName: string; role: string }>({
  subject: ({ orgName }) => `You've joined ${orgName}`,
  text: ({ name, orgName, role }) =>
    `Hello ${name},

Your email address lets you into ${orgName} on Ondes: you're now ${roleName(role)}.`,
});
