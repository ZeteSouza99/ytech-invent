import { RECIPIENT, type Inventory, type User } from './model';
import { formatCnpj } from './company';

export type MailAttachment = { filename: string; mimeType: string; content: Uint8Array };

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function utf8Encode(text: string): Uint8Array {
  const bytes: number[] = [];
  for (const character of text) {
    let code = character.codePointAt(0)!;
    // Lone surrogates cannot be encoded; use the replacement character like TextEncoder.
    if (code >= 0xd800 && code <= 0xdfff) code = 0xfffd;
    if (code < 0x80) bytes.push(code);
    else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    else if (code < 0x10000) bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    else bytes.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
  }
  return Uint8Array.from(bytes);
}

export function encodeBase64(bytes: Uint8Array): string {
  let output = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index]!;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    output += BASE64[first >> 2];
    output += BASE64[((first & 3) << 4) | ((second ?? 0) >> 4)];
    output += second === undefined ? '=' : BASE64[((second & 15) << 2) | ((third ?? 0) >> 6)];
    output += third === undefined ? '=' : BASE64[third & 63];
  }
  return output;
}

function wrapBase64(bytes: Uint8Array): string {
  return (encodeBase64(bytes).match(/.{1,76}/g) ?? []).join('\r\n');
}

function assertHeaderValue(value: string, name: string): void {
  if (/[\r\n]/.test(value)) throw new Error(`Cabeçalho ${name} inválido: contém quebra de linha.`);
}

// RFC 2047 encoded words, split on character boundaries so no word exceeds the 75-character limit.
export function encodeHeaderText(text: string): string {
  assertHeaderValue(text, 'de texto');
  if (/^[\x20-\x7e]*$/.test(text)) return text;
  const words: string[] = [];
  let chunk = '';
  for (const character of text) {
    if (utf8Encode(chunk + character).length > 45) {
      words.push(chunk);
      chunk = '';
    }
    chunk += character;
  }
  if (chunk) words.push(chunk);
  return words.map(word => `=?UTF-8?B?${encodeBase64(utf8Encode(word))}?=`).join('\r\n ');
}

function safeFilename(filename: string): string {
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(filename)) throw new Error(`Nome de anexo inválido: ${filename}`);
  return filename;
}

export function inventoryMailText(inventory: Inventory, user: User, warnings: string[], attachments?: MailAttachment[]): string {
  const descriptions = (attachments ?? [
    { filename: 'SB1_Produtos.xlsx' }, { filename: 'Inventario_Ytech.xlsx' },
  ]).map(file => {
    const description = file.filename.endsWith('.pdf')
      ? 'relatório completo com empresa, CNPJ, PN, números de série, patrimônio e localização de todas as unidades.'
      : file.filename === 'SB1_Produtos.xlsx'
        ? 'modelo de importação SB1, somente com produtos conhecidos do catálogo. Revise antes de importar.'
        : file.filename === 'Inventario_Ytech.xlsx'
          ? 'todas as unidades na aba Inventário; totais na aba Resumo e pendências nas demais abas.'
          : 'arquivo do inventário.';
    return `- ${file.filename}: ${description}`;
  });
  return [
    `Inventário: ${inventory.title}`,
    `ID: ${inventory.id}`,
    `Tipo: ${inventory.organization ? (inventory.organization.kind === 'internal' ? 'Interno' : 'Externo') : 'Não informado'}`,
    `Empresa inventariada: ${inventory.organization?.name ?? 'Não informada'}`,
    `CNPJ: ${inventory.organization ? formatCnpj(inventory.organization.cnpj) : 'Não informado'}`,
    `Responsável: ${user.name} <${user.email}>`,
    `Local: ${inventory.location}`,
    `Itens: ${inventory.items.length}`,
    `Início: ${inventory.startedAt}`,
    `Conclusão: ${inventory.completedAt}`,
    `Pendências para revisão: ${warnings.length}`,
    '',
    'Anexos:',
    ...descriptions,
    '',
    'Enviado pelo aplicativo Ytech Invent a partir da conta do responsável.',
  ].join('\n');
}

export function buildInventoryMessage(input: {
  inventory: Inventory; user: User; warnings: string[]; attachments: MailAttachment[];
}): string {
  const { inventory, user, warnings, attachments } = input;
  if (!/^[^\s@<>"]+@[^\s@<>"]+$/.test(user.email)) throw new Error('E-mail do responsável inválido.');
  const senderName = [...user.name].map(character => (character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127 ? ' ' : character))
    .join('').replace(/ {2,}/g, ' ').trim() || user.email;
  const boundary = `ytech-${inventory.id}`;
  const lines = [
    `From: ${encodeHeaderText(senderName)} <${user.email}>`,
    `To: ${RECIPIENT}`,
    `Subject: ${encodeHeaderText(`Inventário Ytech: ${inventory.title}`)}`,
    `Message-ID: <inventory-${inventory.id}@ytechsolucoes.com>`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    wrapBase64(utf8Encode(inventoryMailText(inventory, user, warnings, attachments))),
  ];
  for (const attachment of attachments) {
    const filename = safeFilename(attachment.filename);
    assertHeaderValue(attachment.mimeType, 'Content-Type');
    lines.push(
      `--${boundary}`,
      `Content-Type: ${attachment.mimeType}; name="${filename}"`,
      `Content-Disposition: attachment; filename="${filename}"`,
      'Content-Transfer-Encoding: base64',
      '',
      wrapBase64(attachment.content),
    );
  }
  lines.push(`--${boundary}--`, '');
  return lines.join('\r\n');
}
