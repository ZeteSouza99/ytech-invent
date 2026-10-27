import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import ExcelJS from 'exceljs';
import { describe, expect, it, vi } from 'vitest';
import { companyUser } from '../shared/account';
import { GMAIL_SEND_SCOPE, transmitGmail } from '../shared/gmail';
import { buildInventoryMessage, encodeBase64, encodeDisplayName, encodeHeaderText, utf8Encode } from '../shared/mime';
import { RECIPIENT, type Inventory, type User } from '../shared/model';
import { createWorkbookService } from '../shared/workbook';
import { createGmailDelivery } from '../src/delivery';

const user: User = { sub: '1234', email: 'ana.souza@ytechsolucoes.com', name: 'Ana Souza Conceição' };

function inventory(items: Inventory['items'] = []): Inventory {
  return {
    id: randomUUID(), title: 'Depósito São Paulo · outubro', location: 'MZ01-E01-N01',
    startedAt: '2026-10-13T12:00:00.000Z', completedAt: '2026-10-13T13:00:00.000Z', catalogVersion: 'v1',
    items: items.length ? items : [{
      id: randomUUID(), pn: 'EC300K-1SA2AA6', ns: '000123', location: 'MZ01-E01-N01', quantity: 1,
      capturedAt: '2026-10-13T12:30:00.000Z', source: 'barcode', rawPn: 'EC300K-1SA2AA6', rawNs: '000123', confirmed: true,
    }],
  };
}

function decodeHeader(value: string): string {
  // RFC 2047: whitespace between adjacent encoded words is not part of the text.
  return value.replace(/\?=\s+=\?/g, '?==?').replace(/=\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=/g, (_match, data: string) => Buffer.from(data, 'base64').toString('utf8'));
}

function parse(raw: string) {
  const [head, ...rest] = raw.split('\r\n\r\n');
  const headers = new Map<string, string>();
  for (const line of head!.replace(/\r\n /g, ' ').split('\r\n')) {
    const index = line.indexOf(':');
    headers.set(line.slice(0, index), line.slice(index + 2));
  }
  const boundary = /boundary="([^"]+)"/.exec(headers.get('Content-Type') ?? '')![1]!;
  const parts = rest.join('\r\n\r\n').split(`--${boundary}`).slice(1, -1).map(part => {
    const [partHead, body] = part.replace(/^\r\n/, '').split('\r\n\r\n');
    return { head: partHead!, content: Buffer.from(body!.replace(/\r\n/g, ''), 'base64') };
  });
  return { headers, parts, boundary };
}

describe('codificação do e-mail', () => {
  it('o envio automático leva o PDF completo e a planilha simples, preservando todas as unidades', async () => {
    const service = await createWorkbookService(new Uint8Array(await readFile('assets/catalog/sb1-produtos.xlsx')), 'v1');
    const sample = inventory();
    sample.items.push({ ...sample.items[0]!, id: randomUUID(), pn: 'FORA-DO-CATALOGO', ns: '000456', patrimony: 'PAT-001' });
    const pdfBytes = utf8Encode('%PDF-1.7\nfixture-do-renderizador-nativo');
    const reportPdf = vi.fn(async () => ({ filename: 'Inventario.pdf', mimeType: 'application/pdf', content: pdfBytes }));
    const delivery = createGmailDelivery({ workbook: async () => service, reportPdf, user: () => user, accessToken: async () => 'token' });
    const { raw, warnings } = await delivery.prepare(user.sub, sample);
    expect(warnings).toEqual([]);
    expect(reportPdf).toHaveBeenCalledExactlyOnceWith(sample, service.catalog);
    const { parts, headers } = parse(raw);
    expect(headers.get('To')).toBe(RECIPIENT);
    expect(parts).toHaveLength(3);
    const body = parts[0]!.content.toString('utf8');
    expect(body).toContain('- Inventario.pdf: relatório');
    expect(body).toContain(`- Inventario_${sample.id}.xlsx: planilha com todas as unidades`);
    expect(body).toContain('Unidades: 2');
    expect(body).toContain('- EC300K-1SA2AA6: 1');
    expect(body).toContain('- FORA-DO-CATALOGO: 1');
    expect(body).not.toMatch(/SB1|TOTVS|Pendências/);
    expect(parts[1]!.head).toContain('Content-Type: application/pdf');
    expect(Uint8Array.from(parts[1]!.content)).toEqual(pdfBytes);
    expect(parts[2]!.head).toContain(`filename="Inventario_${sample.id}.xlsx"`);
    const report = new ExcelJS.Workbook();
    await report.xlsx.load(Uint8Array.from(parts[2]!.content).buffer);
    const rows = report.getWorksheet('Inventário')!;
    expect(rows.rowCount).toBe(3);
    expect(rows.getCell('F2').value).toBe('000123');
    expect(rows.getCell('F3').value).toBe('000456');
    expect(rows.getCell('H3').value).toBe('PAT-001');
    expect(report.getWorksheet('Resumo')!.getCell('E4').value).toBe(2);
  });

  it('interrompe a preparação se o PDF falhar, sem produzir e-mail incompleto', async () => {
    const service = await createWorkbookService(new Uint8Array(await readFile('assets/catalog/sb1-produtos.xlsx')), 'v1');
    const delivery = createGmailDelivery({
      workbook: async () => service, user: () => user, accessToken: async () => 'token',
      reportPdf: async () => { throw new Error('Falha ao gerar PDF'); },
    });
    await expect(delivery.prepare(user.sub, inventory())).rejects.toThrow('Falha ao gerar PDF');
  });

  it.each([
    { mimeType: 'application/pdf', content: new Uint8Array() },
    { mimeType: 'text/plain', content: utf8Encode('Inválido') },
  ])('não prepara envio com PDF vazio ou tipo incorreto: $mimeType', async pdf => {
    const service = await createWorkbookService(new Uint8Array(await readFile('assets/catalog/sb1-produtos.xlsx')), 'v1');
    const delivery = createGmailDelivery({
      workbook: async () => service, user: () => user, accessToken: async () => 'token',
      reportPdf: async () => ({ filename: 'Inventario.pdf', ...pdf }),
    });
    await expect(delivery.prepare(user.sub, inventory())).rejects.toThrow('relatório PDF completo');
  });

  it('cópia parcial é identificada no nome da planilha', async () => {
    const service = await createWorkbookService(new Uint8Array(await readFile('assets/catalog/sb1-produtos.xlsx')), 'v1');
    const data = inventory();
    const file = await service.spreadsheet([{ inventory: data, partial: true }]);
    expect(file.filename).toBe(`Inventario_PARCIAL_${data.id}.xlsx`);
  });
  it('codifica UTF-8 e Base64 exatamente como o Node', () => {
    for (const text of ['', 'a', 'Inventário', '漢字', '😀 ok', '\ud800x']) {
      expect(Buffer.from(utf8Encode(text))).toEqual(Buffer.from(text, 'utf8'));
    }
    for (let length = 0; length < 70; length++) {
      const bytes = Uint8Array.from({ length }, (_, index) => (index * 37 + length) % 256);
      expect(encodeBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'));
    }
  });

  it('divide cabeçalhos acentuados em palavras RFC 2047 de até 75 caracteres', () => {
    const text = `Inventário Ytech: ${'Depósito ção 😀 '.repeat(8)}`;
    const encoded = encodeHeaderText(text);
    expect(encoded.split('\r\n ').every(word => word.length <= 75)).toBe(true);
    expect(decodeHeader(encoded)).toBe(text);
    expect(encodeHeaderText('ASCII simples')).toBe('ASCII simples');
    expect(() => encodeHeaderText('A\r\nBcc: invasor@example.com')).toThrow('quebra de linha');
  });

  it('coloca entre aspas o nome do remetente com vírgula ou outros sinais de endereço', () => {
    expect(encodeDisplayName('Ana Souza')).toBe('Ana Souza');
    expect(encodeDisplayName('Silva, Joao')).toBe('"Silva, Joao"');
    expect(encodeDisplayName('J. "Jota" Silva')).toBe('"J. \\"Jota\\" Silva"');
    expect(decodeHeader(encodeDisplayName('Silva, João'))).toBe('Silva, João');
    expect(() => encodeDisplayName('Ana\r\nBcc: x@example.com')).toThrow('quebra de linha');
  });

  it('monta remetente, destinatário fixo, corpo e anexos sem perder bytes', () => {
    const content = Uint8Array.from({ length: 3000 }, (_, index) => index % 256);
    const sample = inventory();
    const raw = buildInventoryMessage({
      inventory: sample, user: { ...user, name: 'Ana\r\nBcc: x@example.com' },
      attachments: [{ filename: 'Inventario.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', content }],
    });
    expect(raw.split('\r\n').every(line => line.length <= 998)).toBe(true);
    expect(raw).not.toMatch(/(^|[^\r])\n/);
    const { headers, parts } = parse(raw);
    // The display name keeps the injected text harmless: no new header, and quoted so ':' and '@' are not address syntax.
    expect(decodeHeader(headers.get('From')!)).toBe(`"Ana Bcc: x@example.com" <${user.email}>`);
    expect(headers.has('Bcc')).toBe(false);
    expect(headers.get('To')).toBe(RECIPIENT);
    expect(decodeHeader(headers.get('Subject')!)).toBe(`Inventário Ytech: ${sample.title}`);
    expect(headers.get('Message-ID')).toBe(`<inventory-${sample.id}@ytechsolucoes.com>`);
    const body = parts[0]!.content.toString('utf8');
    expect(body).toContain(`ID: ${sample.id}`);
    expect(body).toContain('Responsável: Ana');
    expect(body).toContain('Quantidade por PN:\n- EC300K-1SA2AA6: 1');
    expect(parts[1]!.head).toContain('filename="Inventario.xlsx"');
    expect(Uint8Array.from(parts[1]!.content)).toEqual(content);
    expect(() => buildInventoryMessage({ inventory: sample, user, attachments: [{ filename: '../x.xlsx', mimeType: 'a/b', content }] }))
      .toThrow('Nome de anexo inválido');
  });

  it('leva a planilha real no e-mail e ela abre no Excel', async () => {
    const template = new Uint8Array(await readFile('assets/catalog/sb1-produtos.xlsx'));
    const service = await createWorkbookService(template, 'v1');
    const sample = inventory();
    const spreadsheet = await service.spreadsheet([{ inventory: sample, partial: false }]);
    expect(spreadsheet.content instanceof Uint8Array && !Buffer.isBuffer(spreadsheet.content)).toBe(true);
    const { parts } = parse(buildInventoryMessage({ inventory: sample, user, attachments: [spreadsheet] }));
    expect(parts).toHaveLength(2);
    const report = new ExcelJS.Workbook();
    await report.xlsx.load(Uint8Array.from(parts[1]!.content).buffer);
    expect(report.getWorksheet('Inventário')!.getCell('D2').value).toBe('EC300K-1SA2AA6');
    expect(report.getWorksheet('Inventário')!.getCell('F2').value).toBe('000123');
  });

  // The original spreadsheet is not versioned (*.xlsx in .gitignore); the comparison runs where it is kept, not in CI.
  it.skipIf(process.env.CI === 'true')('o modelo embutido é idêntico à planilha original da pasta', async () => {
    const { readdir } = await import('node:fs/promises');
    const original = (await readdir('.')).filter(name => name.endsWith('.xlsx') && !name.startsWith('~$'));
    expect(original).toHaveLength(1);
    expect(await readFile('assets/catalog/sb1-produtos.xlsx')).toEqual(await readFile(original[0]!));
  });
});

describe('envio pela Gmail API', () => {
  function respond(status: number, body: unknown) {
    return vi.fn(async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }));
  }

  it('envia a mensagem bruta pelo endpoint de upload com o token do usuário', async () => {
    const fetchImpl = respond(200, { id: 'abc123' });
    await expect(transmitGmail('RAW', 'token-1', fetchImpl)).resolves.toEqual({ status: 'sent', messageId: 'abc123' });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=media');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ Authorization: 'Bearer token-1', 'Content-Type': 'message/rfc822' });
    expect(init.body).toBe('RAW');
    expect(GMAIL_SEND_SCOPE).toBe('https://www.googleapis.com/auth/gmail.send');
  });

  it('classifica respostas sem considerar enviado o que não foi confirmado', async () => {
    expect((await transmitGmail('RAW', 't', respond(401, { error: { message: 'Invalid Credentials' } }))).status).toBe('unauthorized');
    const forbidden = await transmitGmail('RAW', 't', respond(403, { error: { message: 'Gmail API has not been used' } }));
    expect(forbidden).toMatchObject({ status: 'failed' });
    expect(forbidden.status === 'failed' && forbidden.message).toContain('Gmail API');
    expect((await transmitGmail('RAW', 't', respond(500, 'erro'))).status).toBe('uncertain');
    expect((await transmitGmail('RAW', 't', respond(408, 'timeout'))).status).toBe('uncertain');
    expect((await transmitGmail('RAW', 't', respond(429, 'limite'))).status).toBe('failed');
    expect((await transmitGmail('RAW', 't', respond(200, {}))).status).toBe('uncertain');
    expect((await transmitGmail('RAW', 't', respond(200, 'não é json'))).status).toBe('uncertain');
    expect((await transmitGmail('RAW', 't', vi.fn(async () => { throw new TypeError('Network request failed'); }))).status).toBe('uncertain');
  });
});

describe('conta Google da empresa', () => {
  it('aceita somente o domínio exato e normaliza o e-mail', () => {
    expect(companyUser({ id: '1', email: 'Ana@YtechSolucoes.com', name: null })).toEqual({ sub: '1', email: 'ana@ytechsolucoes.com', name: 'ana@ytechsolucoes.com' });
    for (const email of ['ana@gmail.com', 'ana@ytechsolucoes.com.br', 'ana@sub.ytechsolucoes.com', 'ytechsolucoes.com', 'ana@evil-ytechsolucoes.com']) {
      expect(() => companyUser({ id: '1', email, name: 'Ana' })).toThrow('@ytechsolucoes.com');
    }
  });
});
