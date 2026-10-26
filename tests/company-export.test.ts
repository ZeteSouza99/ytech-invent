import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { formatCnpj, isValidCnpj, organizationSchema, YTECH_CNPJ, YTECH_NAME } from '../shared/company';
import { inventoryMailText } from '../shared/mime';
import type { Inventory } from '../shared/model';
import { inventoriesCsv, inventoriesHtml, inventoriesJson, parseInventoryBackup } from '../src/exportFormats';

function inventory(): Inventory {
  return {
    id: randomUUID(), title: 'Coleta', location: 'Sala A', catalogVersion: 'v1',
    startedAt: '2026-01-01T00:00:00.000Z', completedAt: '2026-01-02T00:00:00.000Z',
    organization: { kind: 'internal', name: YTECH_NAME, cnpj: YTECH_CNPJ },
    items: [{ id: randomUUID(), pn: 'PN-1', ns: '00123', patrimony: '0004', location: 'Sala A',
      capturedAt: '2026-01-01T01:00:00.000Z', source: 'manual', rawPn: 'PN-1', rawNs: '00123', quantity: 1, confirmed: true }],
  };
}

describe('empresa e exportações', () => {
  it('valida o CNPJ fornecido e aceita o formato alfanumérico sem descartar letras', () => {
    expect(isValidCnpj(YTECH_CNPJ)).toBe(true);
    expect(formatCnpj(YTECH_CNPJ)).toBe('09.310.663/0001-87');
    expect(isValidCnpj('12.ABC.345/01DE-35')).toBe(true);
    for (const invalid of ['09310663000188', '00000000000000', '11111111111111', '09310663000187!', '09310663']) {
      expect(isValidCnpj(invalid)).toBe(false);
    }
    expect(organizationSchema.parse({ kind: 'external', name: 'Cliente', cnpj: '09.310.663/0001-87' }).cnpj).toBe(YTECH_CNPJ);
    expect(organizationSchema.safeParse({ kind: 'external', name: '', cnpj: YTECH_CNPJ }).success).toBe(false);
  });
  it('preserva empresa, séries com zeros e patrimônio no backup, rejeitando versões desconhecidas', () => {
    const entries = [{ inventory: inventory(), partial: true }];
    expect(parseInventoryBackup(inventoriesJson(entries))).toEqual(entries);
    expect(() => parseInventoryBackup('{"schemaVersion":2,"inventories":[]}')).toThrow();
    const malformed = JSON.parse(inventoriesJson(entries));
    malformed.inventories[0].inventory.organization.cnpj = '00000000000000';
    expect(() => parseInventoryBackup(JSON.stringify(malformed))).toThrow();
  });
  it('escapa CSV e neutraliza fórmulas sem perder os valores no backup', () => {
    const inv = inventory();
    inv.title = '=HYPERLINK("url")';
    inv.items[0]!.location = 'Sala, "A"';
    const csv = inventoriesCsv([{ inventory: inv, partial: true }]);
    expect(csv).toContain('"\'=HYPERLINK(""url"")"');
    expect(csv).toContain('"Sala, ""A"""');
    expect(csv).toContain('"00123","0004"');
    expect(csv).toContain('09.310.663/0001-87');
  });
  it('escapa conteúdo de HTML e repete cabeçalhos na impressão do PDF', () => {
    const inv = inventory();
    inv.title = '<script>alert("teste")</script>';
    const output = inventoriesHtml([{ inventory: inv, partial: true }]);
    expect(output).not.toContain('<script>');
    expect(output).toContain('&lt;script&gt;');
    expect(output).toContain('<thead>');
    expect(output).toContain('PARCIAL');
    expect(output).toContain('09.310.663/0001-87');
    expect(output).toContain('0004');
  });
  it('inclui a empresa e seu CNPJ no corpo do e-mail', () => {
    const body = inventoryMailText(inventory(), { sub: '1', name: 'Pessoa', email: 'pessoa@ytechsolucoes.com' }, []);
    expect(body).toContain('Tipo: Interno');
    expect(body).toContain(YTECH_NAME);
    expect(body).toContain('09.310.663/0001-87');
  });
});
