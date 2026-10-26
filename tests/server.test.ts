import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, rmdirSync, unlinkSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import type { TokenPayload } from 'google-auth-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_PAYLOAD_BYTES, RECIPIENT, receiptSchema, type Inventory, type User } from '../shared/model.ts';
import { createApp, type WorkbookService } from '../server/app.ts';
import { readConfig } from '../server/config.ts';
import { classifySmtpError, createSmtpMailer, type Mailer } from '../server/mailer.ts';
import { InventoryStore } from '../server/store.ts';
import { createWorkbookService } from '../server/workbook.ts';
import nodemailer from 'nodemailer';

const clientId = 'test-client';
const user: User = { sub: 'owner-1', email: 'operador@ytechsolucoes.com', name: 'Operador' };
const claims: TokenPayload = {
  sub: user.sub, email: user.email, name: user.name, email_verified: true,
  hd: 'ytechsolucoes.com', aud: clientId, iss: 'https://accounts.google.com',
  iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600,
};
const directories: string[] = [];
const cleanups: (() => Promise<void>)[] = [];

function inventory(): Inventory {
  return {
    id: randomUUID(), title: 'Coleta da sala', location: 'Sala 1',
    startedAt: '2026-01-01T10:00:00.000Z', completedAt: '2026-01-01T11:00:00.000Z',
    catalogVersion: 'current',
    items: [{
      id: randomUUID(), pn: 'PN-123', ns: 'SN-001', location: 'Sala 1', quantity: 1,
      capturedAt: '2026-01-01T10:30:00.000Z', source: 'barcode', rawPn: 'PN-123', rawNs: 'SN-001',
      confirmed: true,
    }],
  };
}

async function runtime(options: { path?: string; mailer?: Mailer; workbook?: WorkbookService; limit?: number } = {}) {
  let path = options.path;
  if (!path) {
    const directory = join(process.cwd(), 'tests', `.server-runtime-${randomUUID()}`);
    mkdirSync(directory);
    directories.push(directory);
    path = join(directory, 'inventories.sqlite');
  }
  const store = new InventoryStore(path);
  const mailer = options.mailer ?? vi.fn<Mailer>().mockResolvedValue('sent');
  const workbook = options.workbook ?? {
    catalog: { version: 'current', products: [], locations: [], warnings: [] },
    export: vi.fn<WorkbookService['export']>().mockResolvedValue({
      attachments: [{ filename: 'inventario.xlsx', content: Buffer.from('test-only') }],
      warnings: ['PN não cadastrado no catálogo.'],
    }),
  };
  const verifyToken = vi.fn(async (token: string): Promise<TokenPayload | undefined> => {
    if (token === 'bad') throw new Error('PRIVATE-TOKEN-ERROR');
    if (token === 'other') return { ...claims, sub: 'owner-2', email: 'outro@ytechsolucoes.com' };
    if (token === 'outside') return { ...claims, hd: 'gmail.com', email: 'outside@gmail.com' };
    if (token === 'suffix') return { ...claims, email: 'outside@ytechsolucoes.com.attacker.test' };
    return claims;
  });
  const app = createApp({ clientId, store, mailer, workbook, verifyToken, rateLimitMax: options.limit ?? 1000 });
  const server = await new Promise<Server>((resolve, reject) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    listening.once('error', reject);
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
    store.close();
  };
  cleanups.push(close);
  const request = (route: string, body?: unknown, token: string | null = 'valid', method?: string) =>
    fetch(`${url}${route}`, {
      method: method ?? (body === undefined ? 'GET' : 'POST'),
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  return { path, store, mailer, workbook, verifyToken, url, request, close };
}

afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  for (const directory of directories.splice(0)) {
    for (const name of ['inventories.sqlite', 'inventories.sqlite-wal', 'inventories.sqlite-shm']) {
      const file = join(directory, name);
      if (existsSync(file)) unlinkSync(file);
    }
    rmdirSync(directory);
  }
  vi.restoreAllMocks();
});

describe('API HTTP com SQLite e dependências externas injetadas', () => {
  it('oferece health público honesto e bootstrap protegido', async () => {
    const app = await runtime();
    const health = await app.request('/health', undefined, null);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ status: 'ready', smtp: 'not_probed' });
    expect(app.verifyToken).not.toHaveBeenCalled();
    expect((await app.request('/bootstrap', undefined, null)).status).toBe(401);
    const invalid = await app.request('/bootstrap', undefined, 'bad');
    expect(invalid.status).toBe(401);
    expect(await invalid.text()).not.toContain('PRIVATE-TOKEN-ERROR');
    expect((await app.request('/bootstrap', undefined, 'outside')).status).toBe(403);
    expect((await app.request('/bootstrap', undefined, 'suffix')).status).toBe(403);
    const bootstrap = await app.request('/bootstrap');
    expect(bootstrap.headers.get('cache-control')).toBe('no-store');
    expect(await bootstrap.json()).toEqual({ user, catalog: app.workbook.catalog });
  });

  it('valida corpo, UUID, propriedades desconhecidas, leituras e limite de 8MB', async () => {
    const app = await runtime();
    const data = inventory();
    expect((await app.request('/inventories', { ...data, recipient: 'attacker@example.com' })).status).toBe(400);
    expect((await app.request('/inventories', { ...data, user, from: 'attacker@example.com' })).status).toBe(400);
    expect((await app.request('/inventories', { ...data, items: [] })).status).toBe(400);
    expect((await app.request('/inventories', { ...data, items: [data.items[0], data.items[0]] })).status).toBe(400);
    expect((await app.request('/inventories', { ...data, items: Array(10001).fill(data.items[0]) })).status).toBe(400);
    expect((await app.request('/inventories/not-a-uuid')).status).toBe(400);
    const malformed = await fetch(`${app.url}/inventories`, {
      method: 'POST', headers: { Authorization: 'Bearer valid', 'Content-Type': 'application/json' }, body: '{"id":',
    });
    expect(malformed.status).toBe(400);
    expect((await app.request('/inventories', { title: 'x'.repeat(MAX_PAYLOAD_BYTES) })).status).toBe(413);
    expect(app.mailer).not.toHaveBeenCalled();
  });

  it('aplica teto inclusivo de bytes UTF-8 compartilhado antes de validar o inventário', async () => {
    const app = await runtime();
    const textBytes = MAX_PAYLOAD_BYTES - Buffer.byteLength(JSON.stringify({ title: '' }), 'utf8');
    const body = JSON.stringify({ title: 'é'.repeat(Math.floor(textBytes / 2)) + 'x'.repeat(textBytes % 2) });
    expect(Buffer.byteLength(body, 'utf8')).toBe(MAX_PAYLOAD_BYTES);
    const options = { method: 'POST', headers: { Authorization: 'Bearer valid', 'Content-Type': 'application/json' } };
    const atLimit = await fetch(`${app.url}/inventories`, { ...options, body });
    expect(atLimit.status).toBe(400);
    expect(await atLimit.json()).toEqual({ error: 'Inventário inválido. Revise os campos e as leituras.' });
    const aboveLimit = await fetch(`${app.url}/inventories`, { ...options, body: `${body} ` });
    expect(aboveLimit.status).toBe(413);
    expect(await aboveLimit.json()).toEqual({ error: 'Inventário excede o limite de 8 MB.' });
    expect(app.mailer).not.toHaveBeenCalled();
  });

  it('persiste antes de enviar, inclui anexos e retorna o mesmo recibo sem duplicar email', async () => {
    const mailer = vi.fn<Mailer>(async request => {
      expect(app.store.get(request.inventory.id, user.sub).receipt.status).toBe('sending');
      return 'sent';
    });
    const app = await runtime({ mailer });
    const data = inventory();
    const first = await app.request('/inventories', data);
    expect(first.status).toBe(200);
    const receipt = receiptSchema.parse(await first.json());
    expect(receipt.status).toBe('sent');
    expect(receipt.message).toContain('não confirma entrega ou leitura');
    expect(receipt.warnings).toContain('PN não cadastrado no catálogo.');
    expect(mailer).toHaveBeenCalledExactlyOnceWith({
      inventory: data, user, attachments: [{ filename: 'inventario.xlsx', content: Buffer.from('test-only') }],
    });
    expect(await (await app.request('/inventories', data)).json()).toEqual(receipt);
    expect(await (await app.request('/inventories', { ...data, id: data.id.toUpperCase() })).json()).toEqual(receipt);
    expect(await (await app.request(`/inventories/${data.id}`)).json()).toEqual(receipt);
    expect(await (await app.request(`/inventories/${data.id.toUpperCase()}`)).json()).toEqual(receipt);
    expect(mailer).toHaveBeenCalledTimes(1);
    expect((await app.request('/inventories', { ...data, title: 'Outro título' })).status).toBe(409);
  });

  it('não revela recibos nem conflitos de UUID pertencentes a outra conta', async () => {
    const app = await runtime();
    const data = inventory();
    await app.request('/inventories', data);
    expect((await app.request(`/inventories/${data.id}`, undefined, 'other')).status).toBe(404);
    expect((await app.request('/inventories', data, 'other')).status).toBe(404);
    expect((await app.request('/inventories', { ...data, title: 'Alterado' }, 'other')).status).toBe(404);
    expect((await app.request(`/inventories/${data.id}/retry`, {}, 'other')).status).toBe(404);
    expect(app.mailer).toHaveBeenCalledTimes(1);
  });

  it('claim SQL impede duplicação em POSTs concorrentes enquanto SMTP está pendente', async () => {
    let release!: (result: 'sent') => void;
    let signal!: () => void;
    const entered = new Promise<void>(resolve => { signal = resolve; });
    const mailer = vi.fn<Mailer>(() => {
      signal();
      return new Promise(resolve => { release = resolve; });
    });
    const app = await runtime({ mailer });
    const data = inventory();
    const first = app.request('/inventories', data);
    await entered;
    const repeated = await Promise.all(Array.from({ length: 5 }, () => app.request('/inventories', data)));
    for (const response of repeated) {
      expect(response.status).toBe(202);
      expect(await response.json()).toMatchObject({ status: 'sending' });
    }
    release('sent');
    expect(await (await first).json()).toMatchObject({ status: 'sent' });
    expect(mailer).toHaveBeenCalledTimes(1);
  });

  it('repetir POST não reenvia failed; somente retry explícito pode enviar novamente', async () => {
    const mailer = vi.fn<Mailer>().mockResolvedValueOnce('failed').mockResolvedValue('sent');
    const app = await runtime({ mailer });
    const data = inventory();
    expect(await (await app.request('/inventories', data)).json()).toMatchObject({ status: 'failed' });
    expect(await (await app.request('/inventories', data)).json()).toMatchObject({ status: 'failed' });
    expect(mailer).toHaveBeenCalledTimes(1);
    expect((await app.request(`/inventories/${data.id}/retry`, { recipient: 'outside@example.com' })).status).toBe(400);
    expect(await (await app.request(`/inventories/${data.id}/retry`, {})).json()).toMatchObject({ status: 'sent' });
    expect(mailer).toHaveBeenCalledTimes(2);
    expect((await app.request(`/inventories/${data.id}/retry`, {})).status).toBe(409);
  });

  it('permite somente um retry concorrente de uma falha segura', async () => {
    let release!: (result: 'sent') => void;
    let signal!: () => void;
    const entered = new Promise<void>(resolve => { signal = resolve; });
    const mailer = vi.fn<Mailer>().mockResolvedValueOnce('failed').mockImplementation(() => {
      signal();
      return new Promise(resolve => { release = resolve; });
    });
    const app = await runtime({ mailer });
    const data = inventory();
    await app.request('/inventories', data);
    const first = app.request(`/inventories/${data.id}/retry`, {});
    await entered;
    expect((await app.request(`/inventories/${data.id}/retry`, {})).status).toBe(409);
    release('sent');
    expect(await (await first).json()).toMatchObject({ status: 'sent' });
    expect(mailer).toHaveBeenCalledTimes(2);
  });

  it.each(['returned', 'thrown'])('bloqueia reenvio incerto (%s) sem expor erro de transporte', async mode => {
    const mailer = mode === 'returned'
      ? vi.fn<Mailer>().mockResolvedValue('uncertain')
      : vi.fn<Mailer>().mockRejectedValue(new Error('PRIVATE-SMTP-PASSWORD'));
    const app = await runtime({ mailer });
    const data = inventory();
    const response = await app.request('/inventories', data);
    const receipt = receiptSchema.parse(await response.json());
    expect(receipt.status).toBe('uncertain');
    expect(JSON.stringify(receipt)).not.toContain('PRIVATE-SMTP-PASSWORD');
    expect(await (await app.request('/inventories', data)).json()).toEqual(receipt);
    expect((await app.request(`/inventories/${data.id}/retry`, {})).status).toBe(409);
    expect(mailer).toHaveBeenCalledTimes(1);
  });

  it('mantém sent/failed após reinício e recupera sending como uncertain, nunca envia ao iniciar', async () => {
    const app = await runtime();
    const sent = inventory();
    await app.request('/inventories', sent);
    const interrupted = inventory();
    app.store.accept(interrupted, user);
    app.store.claim(interrupted.id, user.sub);
    app.store.annotateSending(interrupted.id, ['Advertência preservada após queda.']);
    const failed = inventory();
    app.store.accept(failed, user);
    app.store.claim(failed.id, user.sub);
    app.store.settle(failed.id, 'failed', []);
    const accepted = inventory();
    app.store.accept(accepted, user);
    await app.close();
    const restarted = await runtime({ path: app.path });
    expect(restarted.mailer).not.toHaveBeenCalled();
    expect(await (await restarted.request(`/inventories/${sent.id}`)).json()).toMatchObject({ status: 'sent' });
    expect(await (await restarted.request('/inventories', sent)).json()).toMatchObject({ status: 'sent' });
    expect(await (await restarted.request('/inventories', interrupted)).json()).toMatchObject({ status: 'uncertain' });
    expect(restarted.store.get(interrupted.id, user.sub).receipt.warnings).toEqual(['Advertência preservada após queda.']);
    expect((await restarted.request(`/inventories/${interrupted.id}/retry`, {})).status).toBe(409);
    expect(await (await restarted.request('/inventories', failed)).json()).toMatchObject({ status: 'failed' });
    expect(restarted.mailer).not.toHaveBeenCalled();
    expect(await (await restarted.request('/inventories', accepted)).json()).toMatchObject({ status: 'sent' });
    expect(restarted.mailer).toHaveBeenCalledTimes(1);
  });

  it('reavalia catálogo novo preservando dados offline e relatando advertência', async () => {
    const app = await runtime();
    const data = { ...inventory(), catalogVersion: 'old-version' };
    const receipt = await (await app.request('/inventories', data)).json();
    expect(receipt).toMatchObject({ status: 'sent' });
    expect(receipt.warnings.join(' ')).toContain('catálogo mudou');
    expect(app.workbook.export).toHaveBeenCalledWith(data, user);
    expect(app.store.get(data.id, user.sub).inventory).toEqual(data);
  });

  it('integra exportador real e catálogo antigo sem bloquear a fila offline', async () => {
    const template = readdirSync(process.cwd()).find(name => /\.xlsx$/i.test(name) && !name.startsWith('~$'));
    expect(template).toBeDefined();
    const workbook = await createWorkbookService(join(process.cwd(), template!));
    const app = await runtime({ workbook });
    const data = { ...inventory(), catalogVersion: 'offline-before-template-update' };
    const receipt = receiptSchema.parse(await (await app.request('/inventories', data)).json());
    expect(receipt.status).toBe('sent');
    expect(receipt.warnings.join(' ')).toContain('catálogo mudou');
    expect(app.mailer).toHaveBeenCalledWith(expect.objectContaining({
      inventory: data,
      user,
      attachments: [
        expect.objectContaining({ filename: 'SB1_Produtos.xlsx', content: expect.any(Buffer) }),
        expect.objectContaining({ filename: 'Inventario_Ytech.xlsx', content: expect.any(Buffer) }),
      ],
    }));
    expect(app.store.get(data.id, user.sub).inventory).toEqual(data);
  });

  it('erro de exportação é seguro para retry e não chama SMTP', async () => {
    const workbook: WorkbookService = {
      catalog: { version: 'current', products: [], locations: [], warnings: [] },
      export: vi.fn<WorkbookService['export']>().mockRejectedValue(new Error('PRIVATE-FILE-PATH')),
    };
    const app = await runtime({ workbook });
    const data = inventory();
    const response = await app.request('/inventories', data);
    expect(await response.json()).toMatchObject({ status: 'failed' });
    expect(app.mailer).not.toHaveBeenCalled();
    vi.mocked(workbook.export).mockResolvedValue({ attachments: [], warnings: [] });
    expect(await (await app.request(`/inventories/${data.id}/retry`, {})).json()).toMatchObject({ status: 'sent' });
  });

  it('aplica rate limit sem bloquear o health público', async () => {
    const app = await runtime({ limit: 1 });
    expect((await app.request('/bootstrap')).status).toBe(200);
    expect((await app.request('/bootstrap')).status).toBe(429);
    expect((await app.request('/health', undefined, null)).status).toBe(200);
  });
});

describe('adaptador SMTP sem qualquer conexão real', () => {
  it.each([
    [{ code: 'ETIMEDOUT', command: 'DATA' }, 'uncertain'],
    [{ code: 'ESOCKET' }, 'uncertain'],
    [{ code: 'ECONNECTION' }, 'uncertain'],
    [{ code: 'EAUTH', command: 'AUTH PLAIN' }, 'failed'],
    [{ code: 'ETIMEDOUT', command: 'CONN' }, 'failed'],
    [{ code: 'EENVELOPE', command: 'RCPT TO', responseCode: 550 }, 'failed'],
    [{ command: 'DATA', responseCode: 451 }, 'failed'],
    [new Error('unknown'), 'uncertain'],
  ])('classifica erros de SMTP sem supor segurança após DATA', (error, expected) => {
    expect(classifySmtpError(error)).toBe(expected);
  });

  it('fixa envelope/recipient/from, replyTo verificado e exige TLS', async () => {
    const sendMail = vi.fn().mockResolvedValue({ accepted: [RECIPIENT], rejected: [] });
    const close = vi.fn();
    const transport = vi.spyOn(nodemailer, 'createTransport')
      .mockReturnValue({ sendMail, close } as unknown as ReturnType<typeof nodemailer.createTransport>);
    const smtp = createSmtpMailer({
      host: 'smtp.example.test', port: 587, secure: false,
      user: 'smtp-user', password: 'test-only', from: 'inventario@ytechsolucoes.com',
    });
    const request = { inventory: inventory(), user, attachments: [{ filename: 'report.csv', content: Buffer.from('test') }] };
    expect(await smtp.send(request)).toBe('sent');
    expect(transport).toHaveBeenCalledWith(expect.objectContaining({
      secure: false, requireTLS: true, disableFileAccess: true, disableUrlAccess: true,
    }));
    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({
      from: 'inventario@ytechsolucoes.com', to: RECIPIENT,
      envelope: { from: 'inventario@ytechsolucoes.com', to: [RECIPIENT] },
      replyTo: { name: user.name, address: user.email }, attachments: request.attachments,
    }));
    sendMail.mockResolvedValueOnce({ accepted: [], rejected: [RECIPIENT] });
    expect(await smtp.send(request)).toBe('failed');
    sendMail.mockResolvedValueOnce({ accepted: [], rejected: [] });
    expect(await smtp.send(request)).toBe('uncertain');
    sendMail.mockRejectedValueOnce({ code: 'ETIMEDOUT', command: 'DATA' });
    expect(await smtp.send(request)).toBe('uncertain');
    smtp.close();
    expect(close).toHaveBeenCalledOnce();
  });
});

describe('configuração explícita', () => {
  const environment = {
    GOOGLE_WEB_CLIENT_ID: 'configured-client', SMTP_HOST: 'smtp.example.test', SMTP_PORT: '587',
    SMTP_SECURE: 'false', SMTP_USER: 'user', SMTP_PASSWORD: 'test-password',
    SMTP_FROM: 'inventario@ytechsolucoes.com', TEMPLATE_PATH: 'template.xlsx',
  };
  it('exige campos e booleano/portas válidos sem revelar valores secretos', () => {
    expect(() => readConfig({})).toThrow('GOOGLE_WEB_CLIENT_ID');
    expect(() => readConfig({ ...environment, SMTP_SECURE: 'yes' })).toThrow('SMTP_SECURE');
    expect(() => readConfig({ ...environment, SMTP_PORT: '99999' })).toThrow('SMTP_PORT');
    expect(() => readConfig({ ...environment, SMTP_FROM: 'Display <inventario@ytechsolucoes.com>' })).toThrow('SMTP_FROM');
    const config = readConfig(environment);
    expect(config).toMatchObject({ host: '127.0.0.1', port: 3000, smtp: { secure: false, port: 587 } });
    try {
      readConfig({ ...environment, SMTP_PORT: 'test-password' });
    } catch (error) {
      expect((error as Error).message).not.toContain('test-password');
    }
  });
});
