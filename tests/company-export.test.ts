import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { formatCnpj, isValidCnpj, organizationSchema, YTECH_CNPJ, YTECH_NAME } from '../shared/company';
import { inventoryMailText } from '../shared/mime';
import type { Inventory } from '../shared/model';
import { describeFrom, formatDateTime, REPORT_COLUMNS } from '../shared/report';
import { inventoriesCsv, inventoriesHtml, inventoriesJson, parseInventoryBackup } from '../src/exportFormats';

const describe1 = describeFrom([{ pn: 'PN-1', description: 'Coletor <modelo> "X"' }]);

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
  it('CSV simples com ponto e vírgula, uma linha por unidade, campos escapados e fórmulas neutralizadas', () => {
    const inv = inventory();
    inv.title = '=HYPERLINK("url")';
    inv.items[0]!.location = 'Sala; "A"';
    const csv = inventoriesCsv([{ inventory: inv, partial: true }], describe1);
    expect(csv.startsWith('\ufeff')).toBe(true);
    const [header, row, ...rest] = csv.slice(1).split('\r\n');
    expect(rest).toEqual([]);
    expect(header).toBe(REPORT_COLUMNS.map(column => `"${column}"`).join(';'));
    expect(row).toBe([
      YTECH_NAME, '09.310.663/0001-87', '\'=HYPERLINK(""url"")', 'PN-1', 'Coletor <modelo> ""X""', '00123', '1', '0004',
      'Sala; ""A""', formatDateTime('2026-01-01T01:00:00.000Z'),
    ].map(value => `"${value}"`).join(';'));
  });
  it('PDF com descrição, quantidade por PN e total, escapando o conteúdo e repetindo o cabeçalho das tabelas', () => {
    const inv = inventory();
    inv.title = '<script>alert("teste")</script>';
    inv.items.push({ ...inv.items[0]!, id: randomUUID(), ns: '00124', patrimony: undefined });
    const output = inventoriesHtml([{ inventory: inv, partial: true }], describe1);
    expect(output).not.toContain('<script>');
    expect(output).toContain('&lt;script&gt;');
    expect(output).toContain('Coletor &lt;modelo&gt; &quot;X&quot;');
    expect(output).toContain('<thead>');
    expect(output).toContain('PARCIAL');
    expect(output).toContain('09.310.663/0001-87');
    expect(output).toContain('0004');
    expect(output.match(/<tr class="u">/g)).toHaveLength(2);
    expect(output).toContain('Quantidade por PN');
    expect(output).toMatch(/<td>PN-1<\/td><td>Coletor &lt;modelo&gt; &quot;X&quot;<\/td><td class="number">2<\/td>/);
    expect(output).toMatch(/Total<\/td><td class="number">2</);
    expect(output).not.toMatch(/TOTVS|SB1|pendênc/i);
  });
  it('inclui a empresa, o CNPJ e a quantidade por PN no corpo do e-mail', () => {
    const body = inventoryMailText(inventory(), { sub: '1', name: 'Pessoa', email: 'pessoa@ytechsolucoes.com' });
    expect(body).toContain('Tipo: Interno');
    expect(body).toContain(YTECH_NAME);
    expect(body).toContain('09.310.663/0001-87');
    expect(body).toContain('Unidades: 1');
    expect(body).toContain('- PN-1: 1');
  });
});
