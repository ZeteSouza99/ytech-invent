import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { YTECH_CNPJ, YTECH_NAME } from '../shared/company.ts';
import type { Inventory, InventoryItem } from '../shared/model.ts';
import { formatDateTime, REPORT_COLUMNS, reportFilename } from '../shared/report.ts';
import { createWorkbookService as createSharedService, type WorkbookService } from '../shared/workbook.ts';
import { createWorkbookService } from '../server/workbook.ts';

const fixtureDirectory = resolve('tests', `.workbook-fixtures-${randomUUID()}`);
const templatePath = resolve('assets', 'catalog', 'sb1-produtos.xlsx');
let templateBytes: Buffer;
let service: WorkbookService;

function item(pn: string, ns: string, overrides: Partial<InventoryItem> = {}): InventoryItem {
  return {
    id: randomUUID(), pn, ns, location: 'MZ01-E01-N01', quantity: 1, capturedAt: '2026-10-02T14:00:00.000Z',
    source: 'barcode', rawPn: pn, rawNs: ns, confirmed: true, ...overrides,
  };
}

function inventory(items: InventoryItem[], overrides: Partial<Inventory> = {}): Inventory {
  return {
    id: randomUUID(), title: 'Cliente Alfa · loja 3', location: 'MZ01-E01-N01',
    startedAt: '2026-10-02T13:00:00.000Z', completedAt: '2026-10-02T15:00:00.000Z', catalogVersion: 'v1',
    organization: { kind: 'external', name: 'Cliente Alfa', cnpj: YTECH_CNPJ }, items, ...overrides,
  };
}

async function load(content: Uint8Array): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(content.slice().buffer);
  return workbook;
}

function values(sheet: ExcelJS.Worksheet, number: number): unknown[] {
  return Array.from({ length: sheet.columnCount }, (_, index) => sheet.getRow(number).getCell(index + 1).value);
}

async function catalogFile(rows: Array<{ pn: ExcelJS.CellValue; code?: string; description?: string }>, change?: (workbook: ExcelJS.Workbook) => void) {
  const workbook = await load(templateBytes);
  const products = workbook.getWorksheet('Produtos')!;
  for (let number = products.rowCount; number >= 4; number -= 1) products.spliceRows(number, 1);
  for (const [index, entry] of rows.entries()) {
    products.addRow([entry.code ?? `COD${index}`, entry.pn, entry.description ?? `Produto ${index}`]);
  }
  change?.(workbook);
  const path = join(fixtureDirectory, `${randomUUID()}.xlsx`);
  await writeFile(path, Buffer.from(await workbook.xlsx.writeBuffer()));
  return path;
}

beforeAll(async () => {
  templateBytes = await readFile(templatePath);
  service = await createSharedService(new Uint8Array(templateBytes), 'v1');
  await mkdir(fixtureDirectory, { recursive: true });
});

afterAll(async () => {
  await rm(fixtureDirectory, { recursive: true, force: true });
});

describe('catálogo de produtos', () => {
  it('lê PN, código e descrição do modelo original e usa o SHA-256 dos bytes como versão', async () => {
    const server = await createWorkbookService(templatePath);
    expect(server.catalog.version).toBe(createHash('sha256').update(templateBytes).digest('hex'));
    expect(server.catalog.products.find(product => product.pn === 'EC300K-1SA2AA6')).toEqual({
      pn: 'EC300K-1SA2AA6', code: '835884',
      description: 'COLETOR DE DADOS EC30 LAN, GMS, LEITOR 2D SE2100, 4GB/32GB, 1-PACK',
    });
    expect(server.catalog.products.some(product => product.pn === 'BR03600BK11045')).toBe(true);
    expect(server.catalog.locations).toContain('MZ01-E01-N01');
    // Field rules of the TOTVS import no longer apply: the catalog only feeds recognition and descriptions.
    expect(server.catalog.warnings.join('\n')).not.toMatch(/B1_LOCPAD|B1_POSIPI|B1_GRUPO/);
  });

  it('PN repetido com descrições diferentes fica sem descrição e gera aviso; descrições iguais são mantidas', async () => {
    const path = await catalogFile([
      { pn: 'DUP', description: 'Um' }, { pn: ' dup ', description: 'Outro' },
      { pn: 'SAME', description: 'Igual' }, { pn: 'SAME', description: 'Igual' }, { pn: 'OK', description: 'Produto OK' },
    ]);
    const { catalog } = await createWorkbookService(path);
    expect(catalog.products.find(product => product.pn === 'DUP')).toMatchObject({ description: '' });
    expect(catalog.products.find(product => product.pn === 'SAME')).toMatchObject({ description: 'Igual' });
    expect(catalog.products.filter(product => product.pn === 'SAME')).toHaveLength(1);
    expect(catalog.warnings).toHaveLength(1);
    expect(catalog.warnings[0]).toContain('PN DUP');
  });

  it('lê zeros de uma máscara numérica explícita e aceita catálogo sem a aba de endereços', async () => {
    const path = await catalogFile([{ pn: 12 }], workbook => {
      workbook.getWorksheet('Produtos')!.getCell('B4').numFmt = '000000';
      workbook.removeWorksheet(workbook.getWorksheet('Endereço')!.id);
      workbook.removeWorksheet(workbook.getWorksheet('Grupos')!.id);
    });
    const { catalog } = await createWorkbookService(path);
    expect(catalog.products[0]!.pn).toBe('000012');
    expect(catalog.locations).toEqual([]);
  });

  it('falha explicitamente para arquivo ausente, corrompido, sem a aba Produtos ou com cabeçalho trocado', async () => {
    await expect(createWorkbookService(join(fixtureDirectory, 'missing.xlsx'))).rejects.toThrow('Não foi possível ler');
    const invalidPath = join(fixtureDirectory, 'invalid.xlsx');
    await writeFile(invalidPath, 'not an XLSX');
    await expect(createWorkbookService(invalidPath)).rejects.toThrow('não é um XLSX legível');
    const wrongHeader = await catalogFile([{ pn: 'VALID' }], workbook => { workbook.getWorksheet('Produtos')!.getCell('B2').value = 'B1_ERRADO'; });
    await expect(createWorkbookService(wrongHeader)).rejects.toThrow('cabeçalho Produtos!B2');
    const noProducts = await catalogFile([{ pn: 'VALID' }], workbook => { workbook.getWorksheet('Produtos')!.name = 'Itens'; });
    await expect(createWorkbookService(noProducts)).rejects.toThrow('aba "Produtos" ausente');
    const empty = await catalogFile([]);
    await expect(createWorkbookService(empty)).rejects.toThrow('nenhum produto');
  });
});

describe('planilha simples', () => {
  it('uma linha por unidade com todas as colunas, na ordem da leitura, e quantidade por PN com total', async () => {
    const data = inventory([
      item('EC300K-1SA2AA6', '000002', { capturedAt: '2026-10-02T14:05:00.000Z', patrimony: 'PAT-7', location: 'MZ01-E01-N02' }),
      item('EC300K-1SA2AA6', '000001'),
      item('FORA-DO-CATALOGO', '000003', { capturedAt: '2026-10-02T14:10:00.000Z' }),
    ]);
    const file = await service.spreadsheet([{ inventory: data, partial: false }]);
    expect(file.filename).toBe(`Inventario_${YTECH_CNPJ}.xlsx`);
    expect(file.mimeType).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    const workbook = await load(file.content);
    expect(workbook.worksheets.map(sheet => sheet.name)).toEqual(['Inventário', 'Resumo']);
    const units = workbook.getWorksheet('Inventário')!;
    expect(values(units, 1)).toEqual([...REPORT_COLUMNS]);
    expect(units.rowCount).toBe(4);
    const description = 'COLETOR DE DADOS EC30 LAN, GMS, LEITOR 2D SE2100, 4GB/32GB, 1-PACK';
    expect(values(units, 2).slice(0, 9)).toEqual(['Cliente Alfa', '09.310.663/0001-87', 'Cliente Alfa · loja 3', 'EC300K-1SA2AA6', description, '000001', 1, null, 'MZ01-E01-N01']);
    expect(values(units, 3).slice(3, 9)).toEqual(['EC300K-1SA2AA6', description, '000002', 1, 'PAT-7', 'MZ01-E01-N02']);
    expect(values(units, 4).slice(3, 7)).toEqual(['FORA-DO-CATALOGO', null, '000003', 1]);
    const read = units.getCell('J2');
    expect(read.numFmt).toBe('dd/mm/yyyy hh:mm');
    const shown = read.value as Date;
    const pad = (value: number) => String(value).padStart(2, '0');
    expect(`${pad(shown.getUTCDate())}/${pad(shown.getUTCMonth() + 1)}/${shown.getUTCFullYear()} ${pad(shown.getUTCHours())}:${pad(shown.getUTCMinutes())}`)
      .toBe(formatDateTime('2026-10-02T14:00:00.000Z'));
    expect(units.autoFilter).toBeTruthy();

    const summary = workbook.getWorksheet('Resumo')!;
    expect(values(summary, 1)).toEqual(['Inventário', 'Empresa', 'PN', 'Descrição', 'Quantidade']);
    expect(values(summary, 2)).toEqual(['Cliente Alfa · loja 3', 'Cliente Alfa', 'EC300K-1SA2AA6', description, 2]);
    expect(values(summary, 3)).toEqual(['Cliente Alfa · loja 3', 'Cliente Alfa', 'FORA-DO-CATALOGO', null, 1]);
    expect(values(summary, 4)).toEqual(['Total', null, null, null, 3]);
  });

  it('mantém zeros à esquerda e textos iniciados por = como texto, nunca como número ou fórmula', async () => {
    const data = inventory([item('=1+1', '000099', { patrimony: '0004' })]);
    const units = (await load((await service.spreadsheet([{ inventory: data, partial: false }])).content)).getWorksheet('Inventário')!;
    for (const address of ['D2', 'F2', 'H2']) {
      expect(units.getCell(address).type, address).toBe(ExcelJS.ValueType.String);
      expect(units.getCell(address).numFmt, address).toBe('@');
    }
    expect([units.getCell('D2').value, units.getCell('F2').value, units.getCell('H2').value]).toEqual(['=1+1', '000099', '0004']);
  });

  it('reúne vários inventários na mesma planilha, identificando cada um, e marca cópia parcial no nome', async () => {
    const first = inventory([item('EC300K-1SA2AA6', 'A1'), item('EC300K-1SA2AA6', 'A2')]);
    const second = inventory([item('EC300K-1SA2AA6', 'B1')], {
      title: 'Estoque Ytech', organization: { kind: 'internal', name: YTECH_NAME, cnpj: YTECH_CNPJ },
    });
    const file = await service.spreadsheet([{ inventory: first, partial: false }, { inventory: second, partial: true }]);
    expect(file.filename).toBe('Inventario_PARCIAL_todos.xlsx');
    const workbook = await load(file.content);
    const units = workbook.getWorksheet('Inventário')!;
    expect(units.rowCount).toBe(4);
    expect(units.getCell('C4').value).toBe('Estoque Ytech');
    expect(units.getCell('A4').value).toBe(YTECH_NAME);
    const summary = workbook.getWorksheet('Resumo')!;
    expect([2, 3].map(number => [summary.getCell(number, 1).value, summary.getCell(number, 5).value])).toEqual([['Cliente Alfa · loja 3', 2], ['Estoque Ytech', 1]]);
    expect(summary.getCell('E4').value).toBe(3);
    expect(reportFilename([{ inventory: second, partial: false }], 'pdf')).toBe(`Inventario_${YTECH_CNPJ}.pdf`);
    const withoutCompany = inventory([item('X-1', 'N1')], { organization: undefined });
    expect(reportFilename([{ inventory: withoutCompany, partial: false }], 'csv')).toBe(`Inventario_${withoutCompany.id}.csv`);
  });

  it('o servidor envia a mesma planilha simples como anexo', async () => {
    const server = await createWorkbookService(templatePath);
    const data = inventory([item('EC300K-1SA2AA6', '000001')]);
    const result = await server.export(data, { sub: '1', email: 'a@ytechsolucoes.com', name: 'A' });
    expect(result.warnings).toEqual([]);
    expect(result.attachments.map(file => file.filename)).toEqual([`Inventario_${YTECH_CNPJ}.xlsx`]);
    expect(Buffer.isBuffer(result.attachments[0]!.content)).toBe(true);
    expect((await load(result.attachments[0]!.content)).getWorksheet('Inventário')!.getCell('F2').value).toBe('000001');
  });

  it('não altera o arquivo do catálogo nem é afetada por mudanças no catálogo público', async () => {
    const path = await catalogFile([{ pn: 'ONE', description: 'Produto um' }]);
    const bytes = await readFile(path);
    const own = await createSharedService(new Uint8Array(bytes), 'v1');
    own.catalog.products[0]!.description = 'ALTERADO';
    const units = (await load((await own.spreadsheet([{ inventory: inventory([item('ONE', '1')]), partial: false }])).content)).getWorksheet('Inventário')!;
    expect(units.getCell('E2').value).toBe('Produto um');
    expect(await readFile(path)).toEqual(bytes);
  });
});
