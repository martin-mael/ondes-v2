import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { createTransport } from 'nodemailer';

// Outgoing email (#6): an SMTP transport configured by env, and a tiny template layer.
// Modules define their templates with `defineTemplate` and send them with `app.mailer.send`.

declare module 'fastify' {
  interface FastifyInstance {
    mailer: Mailer;
  }
}

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(message: MailMessage): Promise<void>;
  close?(): void;
}

export interface MailConfig {
  /** `smtp://user:pass@host:port` (or `smtps://`). Dev: Mailpit, `smtp://127.0.0.1:1025`. */
  smtpUrl: string;
  /** `Ondes <no-reply@example.org>`. */
  from: string;
}

/** Reads `SMTP_URL` and `MAIL_FROM`. */
export function mailConfigFromEnv(env: NodeJS.ProcessEnv = process.env): MailConfig {
  const smtpUrl = env.SMTP_URL;
  if (!smtpUrl) throw new Error('SMTP_URL is not set');
  return { smtpUrl, from: env.MAIL_FROM ?? 'Ondes <no-reply@localhost>' };
}

export function createSmtpMailer(config: MailConfig): Mailer {
  const transport = createTransport(config.smtpUrl);
  return {
    async send(message) {
      await transport.sendMail({ from: config.from, ...message });
    },
    close: () => transport.close(),
  };
}

/** Keeps messages in memory instead of sending them. For tests. */
export function createMemoryMailer(): Mailer & { outbox: MailMessage[] } {
  const outbox: MailMessage[] = [];
  return {
    outbox,
    async send(message) {
      outbox.push(message);
    },
  };
}

// --- Templates ---------------------------------------------------------------------------

export interface MailTemplate<V> {
  render(vars: V): { subject: string; text: string };
}

/** A plain-text template. Keep them short: one purpose, one link. */
export function defineTemplate<V>(template: {
  subject: (vars: V) => string;
  text: (vars: V) => string;
}): MailTemplate<V> {
  return {
    render: (vars) => ({ subject: template.subject(vars), text: template.text(vars) }),
  };
}

export function sendTemplate<V>(
  mailer: Mailer,
  to: string,
  template: MailTemplate<V>,
  vars: V,
): Promise<void> {
  return mailer.send({ to, ...template.render(vars) });
}

export type MailPluginOptions = { config: MailConfig } | { mailer: Mailer };

export const mailPlugin = fp(
  async (app: FastifyInstance, options: MailPluginOptions) => {
    const mailer = 'mailer' in options ? options.mailer : createSmtpMailer(options.config);
    app.decorate('mailer', mailer);
    if ('config' in options) app.addHook('onClose', async () => mailer.close?.());
  },
  { name: 'mail' },
);
