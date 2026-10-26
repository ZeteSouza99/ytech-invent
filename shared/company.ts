import { z } from 'zod';

export const YTECH_NAME = 'YTECH SOLUÇÕES';
export const YTECH_CNPJ = '09310663000187';

export function normalizeCnpj(value: string): string {
  return value.trim().toUpperCase().replace(/[./-]/g, '');
}

// Receita Federal: módulo 11; valores dos caracteres = ASCII - 48.
// https://www.gov.br/receitafederal/pt-br/centrais-de-conteudo/publicacoes/documentos-tecnicos/cnpj/manual-dv-cnpj.pdf
export function isValidCnpj(value: string): boolean {
  const cnpj = normalizeCnpj(value);
  if (!/^[A-Z0-9]{12}[0-9]{2}$/.test(cnpj) || /^(\d)\1{13}$/.test(cnpj)) return false;
  function digit(base: string): string {
    let sum = 0;
    for (let index = base.length - 1, weight = 2; index >= 0; index--, weight = weight === 9 ? 2 : weight + 1) {
      sum += (base.charCodeAt(index) - 48) * weight;
    }
    const remainder = sum % 11;
    return String(remainder < 2 ? 0 : 11 - remainder);
  }
  const base = cnpj.slice(0, 12);
  const first = digit(base);
  return cnpj === base + first + digit(base + first);
}

export function formatCnpj(value: string): string {
  const cnpj = normalizeCnpj(value);
  return cnpj.length === 14 ? cnpj.replace(/^(.{2})(.{3})(.{3})(.{4})(.{2})$/, '$1.$2.$3/$4-$5') : cnpj;
}

export const cnpjSchema = z.string().max(18).refine(isValidCnpj, 'Informe um CNPJ válido, com os dígitos verificadores corretos.').transform(normalizeCnpj);
export const organizationSchema = z.object({
  kind: z.enum(['internal', 'external']),
  name: z.string().trim().min(1, 'Informe o nome do cliente.').max(120)
    .refine(value => [...value].every(character => character.charCodeAt(0) > 31 && character.charCodeAt(0) !== 127), 'Nome da empresa inválido.'),
  cnpj: cnpjSchema,
}).strict().refine(value => value.kind !== 'internal' || value.name === YTECH_NAME, 'O inventário interno pertence à Ytech Soluções.');
export type Organization = z.infer<typeof organizationSchema>;
