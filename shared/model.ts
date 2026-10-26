import { z } from 'zod';
import { organizationSchema } from './company';

export const COMPANY_DOMAIN = 'ytechsolucoes.com';
export const RECIPIENT = 'lorena@ytechsolucoes.com';
export const MAX_ITEMS = 10000;
export const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;

export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes++;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && text.charCodeAt(index + 1) >= 0xdc00 && text.charCodeAt(index + 1) <= 0xdfff) {
      bytes += 4;
      index++;
    } else bytes += 3;
  }
  return bytes;
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export function normalizeCode(value: string): string {
  return value.trim().toUpperCase();
}

export const codeSchema = z.string().trim().min(1).max(80)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/, 'Use apenas letras, números, ponto, hífen, barra ou sublinhado.')
  .transform(normalizeCode);
export const partNumberSchema = z.string().trim().min(1).max(120)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/() =+-]*$/, 'PN inválido. Preserve espaços, parênteses e sinais impressos, sem caracteres de controle.')
  .transform(normalizeCode);
export const inventoryTextSchema = z.string().trim().min(1).max(120)
  .refine(value => [...value].every(character => character.charCodeAt(0) > 31 && character.charCodeAt(0) !== 127), 'O texto contém caracteres de controle.');
export const userSchema = z.object({
  sub: z.string().min(1).max(255),
  email: z.email().max(254),
  name: z.string().min(1).max(200),
}).strict();
export type User = z.infer<typeof userSchema>;

export const productSchema = z.object({
  pn: z.string().min(1).max(120),
  code: z.string().max(120),
  description: z.string().max(2000),
  issues: z.array(z.string().max(500)),
}).strict();
export type Product = z.infer<typeof productSchema>;

export const catalogSchema = z.object({
  version: z.string().min(1).max(128),
  products: z.array(productSchema).max(100000),
  locations: z.array(z.string().max(120)).max(10000),
  warnings: z.array(z.string().max(500)).max(100000),
}).strict();
export type Catalog = z.infer<typeof catalogSchema>;
export const bootstrapSchema = z.object({ user: userSchema, catalog: catalogSchema }).strict();

export const itemSchema = z.object({
  id: z.uuid(),
  pn: partNumberSchema,
  ns: codeSchema,
  location: inventoryTextSchema,
  quantity: z.literal(1),
  capturedAt: z.iso.datetime(),
  source: z.enum(['barcode', 'manual', 'ocr']),
  rawPn: z.string().max(2048),
  rawNs: z.string().max(2048),
  confirmed: z.literal(true),
  patrimony: codeSchema.optional(),
}).strict().refine(item => item.pn !== item.ns, { message: 'PN e NS não podem ser iguais.', path: ['ns'] });
export type InventoryItem = z.infer<typeof itemSchema>;

export const inventorySchema = z.object({
  id: z.uuid(),
  title: inventoryTextSchema,
  location: inventoryTextSchema,
  startedAt: z.iso.datetime(),
  completedAt: z.iso.datetime(),
  catalogVersion: z.string().min(1).max(128),
  organization: organizationSchema.optional(),
  items: z.array(itemSchema).min(1, 'Leia pelo menos um item.').max(MAX_ITEMS),
}).strict().superRefine((inventory, context) => {
  if (utf8ByteLength(JSON.stringify(inventory)) > MAX_PAYLOAD_BYTES) {
    context.addIssue({ code: 'custom', message: 'Inventário excede o limite de 8 MB. Divida a coleta antes de concluir.' });
  }
  const serials = new Set<string>();
  const ids = new Set<string>();
  inventory.items.forEach((item, index) => {
    if (serials.has(item.ns)) context.addIssue({ code: 'custom', path: ['items', index, 'ns'], message: `NS duplicado: ${item.ns}` });
    if (ids.has(item.id)) context.addIssue({ code: 'custom', path: ['items', index, 'id'], message: 'Identificador de item duplicado.' });
    serials.add(item.ns);
    ids.add(item.id);
    if (Date.parse(item.capturedAt) < Date.parse(inventory.startedAt) || Date.parse(item.capturedAt) > Date.parse(inventory.completedAt)) {
      context.addIssue({ code: 'custom', path: ['items', index, 'capturedAt'], message: 'A leitura deve estar dentro do período do inventário.' });
    }
  });
  if (Date.parse(inventory.completedAt) < Date.parse(inventory.startedAt)) {
    context.addIssue({ code: 'custom', path: ['completedAt'], message: 'Data de conclusão anterior ao início.' });
  }
});
export type Inventory = z.infer<typeof inventorySchema>;

export const receiptSchema = z.object({
  id: z.uuid(),
  status: z.enum(['accepted', 'sending', 'sent', 'failed', 'uncertain']),
  message: z.string().max(2000),
  updatedAt: z.iso.datetime(),
  warnings: z.array(z.string().max(500)).max(100000),
}).strict();
export type Receipt = z.infer<typeof receiptSchema>;

export function errorMessage(error: unknown): string {
  if (error instanceof z.ZodError) return error.issues.map(issue => issue.message).join('\n');
  if (error instanceof Error) return error.message;
  return 'Falha inesperada. Tente novamente; seus dados salvos permanecem no aparelho.';
}
