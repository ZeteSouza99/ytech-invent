import { describe, expect, it } from 'vitest';
import { codeSchema, errorMessage, inventorySchema, itemSchema, partNumberSchema, utf8ByteLength } from '../shared/model';
import { organizationKindLabel } from '../shared/company';

describe('valores aceitos para PN e NS', () => {
  it('preserva zeros à esquerda e os caracteres dos PNs especiais do catálogo original', () => {
    expect(codeSchema.parse('0012')).toBe('0012');
    for (const pn of [
      'TC200J-1KC111A6 BR', 'MC32N0-GI4HCHEIA BR', 'DS2208-SR7U2100SGW B',
      'HMC3200-LI(H)', 'CZ IP6 888191', 'BH CAPA TC22-TC27G',
      'WB CAPA ZQ630 CINTO', 'PN=PD-9001GR-ENT_SC', 'WB CAPA MC93G',
    ]) {
      expect(partNumberSchema.parse(pn)).toBe(pn);
    }
  });

  it('rejeita fórmulas, caracteres de controle e espaços em NS', () => {
    expect(partNumberSchema.safeParse('=HYPERLINK("bad")').success).toBe(false);
    expect(partNumberSchema.safeParse('ABC\tDEF').success).toBe(false);
    expect(codeSchema.safeParse('ABC\u0000DEF').success).toBe(false);
    expect(codeSchema.safeParse('=HYPERLINK("bad")').success).toBe(false);
    expect(codeSchema.safeParse('NS COM ESPAÇO').success).toBe(false);
  });

  it('mede bytes UTF-8, não caracteres, inclusive Unicode e pares substitutos', () => {
    for (const value of ['ASCII', 'Ação', '漢字', '😀', '\ud800', JSON.stringify({ location: 'São Paulo 😀', raw: '\u001d' })]) {
      expect(utf8ByteLength(value)).toBe(Buffer.byteLength(value, 'utf8'));
    }
  });
});

describe('contrato de inventário', () => {
  const item = {
    id: 'e9060f30-0c9f-4dac-8b2e-d7f7e514b412', pn: 'MS4717-LU000R', ns: '00123',
    location: 'MZ01-E01-N01', quantity: 1, capturedAt: '2026-10-02T12:01:00.000Z',
    source: 'manual', rawPn: 'MS4717-LU000R', rawNs: '00123', confirmed: true,
  };
  const inventory = {
    id: '8ec145e5-dda0-4341-936a-0c3c2d058f00', title: 'Estoque', location: item.location,
    startedAt: '2026-10-02T12:00:00.000Z', completedAt: '2026-10-02T12:02:00.000Z', catalogVersion: 'v1', items: [item],
  };
  it('exige confirmação, um NS por unidade e bloqueia repetidos', () => {
    expect(inventorySchema.safeParse(inventory).success).toBe(true);
    expect(inventorySchema.safeParse({ ...inventory, items: [item, { ...item, id: '0efc0bc8-f757-47b5-8bff-74cb218266ef' }] }).success).toBe(false);
    expect(inventorySchema.safeParse({ ...inventory, items: [{ ...item, confirmed: false }] }).success).toBe(false);
    expect(inventorySchema.safeParse({ ...inventory, items: [{ ...item, quantity: 2 }] }).success).toBe(false);
    expect(inventorySchema.safeParse({ ...inventory, items: [{ ...item, capturedAt: '2026-10-01T12:00:00.000Z' }] }).success).toBe(false);
  });

  it('explica em português o que corrigir, inclusive nas mensagens padrão de validação', () => {
    const blankPn = itemSchema.safeParse({ ...item, pn: '   ' });
    expect(blankPn.success).toBe(false);
    expect(errorMessage(blankPn.error)).not.toMatch(/Too small|expected/i);
    expect(errorMessage(blankPn.error)).toContain('Pequeno demais');
    const outside = inventorySchema.safeParse({ ...inventory, items: [{ ...item, capturedAt: '2026-10-01T12:00:00.000Z' }] });
    expect(errorMessage(outside.error)).toContain('NS 00123');
    expect(errorMessage(outside.error)).toContain('relógio');
  });
});

describe('identificação da empresa', () => {
  it('descreve o tipo de inventário em um único lugar', () => {
    expect(organizationKindLabel({ kind: 'internal' })).toBe('Interno');
    expect(organizationKindLabel({ kind: 'external' })).toBe('Externo');
    expect(organizationKindLabel(undefined)).toBe('Não informado');
  });
});
