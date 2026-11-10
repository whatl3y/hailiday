import nodemailer from 'nodemailer';
import type { AppConfig } from '../config/index.js';
import type { DbOrTx } from '../db/client.js';
import { newId, randomToken } from '../ids/index.js';
import type { Logger } from '../logger/index.js';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
  /** Short label for logs and metrics (`magic_link`, `operator_reauth`, `preview`). */
  tag?: string;
}

export interface SentEmail {
  messageId: string;
  provider: 'smtp' | 'fixture';
}

export interface EmailSender {
  readonly kind: 'smtp' | 'fixture';
  send(message: EmailMessage): Promise<SentEmail>;
  close(): Promise<void>;
}

/** A message recorded by the fixture sender. */
export interface RecordedEmail extends EmailMessage {
  messageId: string;
  from: string;
  sentAt: Date;
}

/** Fixture sender: records messages in memory (and in `fixture_emails` when a database is given). */
export interface FixtureEmailSender extends EmailSender {
  readonly kind: 'fixture';
  readonly outbox: readonly RecordedEmail[];
  /** The most recent message to an address. */
  lastTo(address: string): RecordedEmail | undefined;
  clear(): void;
}

function maskAddress(address: string): string {
  const domain = address.split('@')[1] ?? 'unknown';
  return `***@${domain}`;
}

function messageId(config: AppConfig): string {
  const host = new URL(config.publicBaseUrl).hostname || 'holiday.local';
  return `<${randomToken(12)}@${host}>`;
}

export function createFixtureEmailSender(
  config: AppConfig,
  options: { logger?: Logger; db?: DbOrTx } = {},
): FixtureEmailSender {
  const outbox: RecordedEmail[] = [];
  return {
    kind: 'fixture',
    outbox,
    async send(message) {
      const recorded: RecordedEmail = {
        ...message,
        messageId: messageId(config),
        from: config.email.from,
        sentAt: new Date(),
      };
      outbox.push(recorded);
      if (options.db) {
        await options.db
          .insertInto('fixtureEmails')
          .values({
            id: newId(),
            toAddress: message.to.trim().toLowerCase(),
            fromAddress: config.email.from,
            subject: message.subject,
            textBody: message.text,
            htmlBody: message.html ?? null,
            tag: message.tag ?? null,
            messageId: recorded.messageId,
          })
          .execute();
      }
      options.logger?.info(
        {
          recipient: maskAddress(message.to),
          subject: message.subject,
          tag: message.tag ?? null,
          fixture: true,
          // The body (with its sign-in link) is printed only in local development, where the
          // fixture sender stands in for a mailbox.
          ...(config.appEnv === 'development' ? { fixtureBody: message.text } : {}),
        },
        'fixture email recorded',
      );
      return { messageId: recorded.messageId, provider: 'fixture' };
    },
    lastTo(address) {
      const normalized = address.trim().toLowerCase();
      for (let i = outbox.length - 1; i >= 0; i -= 1) {
        const entry = outbox[i];
        if (entry && entry.to.trim().toLowerCase() === normalized) return entry;
      }
      return undefined;
    },
    clear() {
      outbox.length = 0;
    },
    async close() {},
  };
}

export function createSmtpEmailSender(
  config: AppConfig,
  options: { logger?: Logger } = {},
): EmailSender {
  const transport = nodemailer.createTransport(config.email.smtpUrl);
  return {
    kind: 'smtp',
    async send(message) {
      const info = await transport.sendMail({
        from: config.email.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
        messageId: messageId(config),
        headers: message.tag ? { 'X-Holiday-Tag': message.tag } : undefined,
      });
      options.logger?.info(
        { recipient: maskAddress(message.to), tag: message.tag ?? null },
        'email sent',
      );
      return { messageId: String(info.messageId), provider: 'smtp' };
    },
    async close() {
      transport.close();
    },
  };
}

/**
 * The configured sender: SMTP (Mailpit locally, a provider in staging and production) or fixture.
 * The fixture sender is refused outside development and test: it delivers nothing and stores
 * every message, sign-in links included, in plain text.
 */
export function createEmailSender(
  config: AppConfig,
  options: { logger?: Logger; db?: DbOrTx } = {},
): EmailSender {
  if (config.email.provider === 'smtp') return createSmtpEmailSender(config, options);
  if (!config.isLocal) {
    throw new Error(
      `EMAIL_PROVIDER=fixture is refused when APP_ENV=${config.appEnv}: the fixture sender ` +
        'delivers nothing and stores sign-in links in plain text. Set EMAIL_PROVIDER=smtp.',
    );
  }
  return createFixtureEmailSender(config, options);
}
