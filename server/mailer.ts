import nodemailer from 'nodemailer';
import { DEFAULT_RECIPIENT, type Inventory, type User } from '../shared/model.ts';
import type { ServerConfig } from './config.ts';

export type Attachment = { filename: string; content: Buffer };
export type MailRequest = { inventory: Inventory; user: User; attachments: Attachment[] };
export type MailResult = 'sent' | 'failed' | 'uncertain';
export type Mailer = (request: MailRequest) => Promise<MailResult>;

export function classifySmtpError(error: unknown): 'failed' | 'uncertain' {
  if (!error || typeof error !== 'object') return 'uncertain';
  const { command, code, responseCode } = error as { command?: unknown; code?: unknown; responseCode?: unknown };
  // Uma resposta negativa explícita é segura; desconexão durante/após DATA é ambígua.
  if (typeof responseCode === 'number' && responseCode >= 400 && responseCode <= 599) return 'failed';
  if (typeof command === 'string' &&
      /^(CONN|EHLO|HELO|STARTTLS|AUTH(?: .*)?|MAIL FROM|RCPT TO)$/i.test(command)) return 'failed';
  if (typeof code === 'string' &&
      ['EAUTH', 'ENOAUTH', 'ECONFIG', 'EDNS', 'ETLS', 'EENVELOPE'].includes(code)) return 'failed';
  return 'uncertain';
}

export function createSmtpMailer(config: ServerConfig['smtp']): { send: Mailer; close: () => void } {
  const transport = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    requireTLS: !config.secure,
    auth: { user: config.user, pass: config.password },
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 60000,
    disableFileAccess: true,
    disableUrlAccess: true,
    logger: false,
    debug: false,
  });
  return {
    async send({ inventory, user, attachments }) {
      try {
        const result = await transport.sendMail({
          from: config.from,
          to: DEFAULT_RECIPIENT,
          envelope: { from: config.from, to: [DEFAULT_RECIPIENT] },
          replyTo: { name: user.name, address: user.email },
          subject: `Inventário Ytech: ${inventory.title}`,
          text: [
            `Inventário: ${inventory.title}`,
            `ID: ${inventory.id}`,
            `Responsável: ${user.name} <${user.email}>`,
            `Local: ${inventory.location}`,
            `Itens: ${inventory.items.length}`,
            `Conclusão: ${inventory.completedAt}`,
            '',
            'Relatórios anexos. A aceitação pelo SMTP não confirma a entrega ou leitura.',
          ].join('\n'),
          attachments,
          messageId: `<inventory-${inventory.id}@ytechsolucoes.com>`,
        });
        const accepted = result.accepted.some(address => address.toLowerCase() === DEFAULT_RECIPIENT);
        if (accepted) return 'sent';
        return result.rejected.some(address => address.toLowerCase() === DEFAULT_RECIPIENT)
          ? 'failed' : 'uncertain';
      } catch (error) {
        return classifySmtpError(error);
      }
    },
    close: () => transport.close(),
  };
}
