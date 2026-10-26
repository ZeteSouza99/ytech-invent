import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Inventory, InventoryItem, User } from '../shared/model.ts';
import { createWorkbookService, type WorkbookService } from '../server/workbook.ts';

const user: User = { sub: 'verified-server-subject', email: 'operador@ytechsolucoes.com', name: 'Operador verificado' };
const fixtureDirectory = resolve('tests', `.workbook-fixtures-${randomUUID()}`);
let originalPath: string;
let originalBytes: Buffer;
let originalWorkbook: ExcelJS.Workbook;
let originalService: WorkbookService;

function item(pn: string, ns: string, location = 'MZ01-E01-N01', overrides: Partial<InventoryItem> = {}): InventoryItem {
  return {
    id: randomUUID(), pn, ns, location, quantity: 1, capturedAt: '2026-10-02T14:00:00.000Z',
    source: 'barcode', rawPn: pn, rawNs: ns, confirmed: true, ...overrides,
  };
}

function inventory(service: WorkbookService, items: InventoryItem[]): Inventory {
  return {
    id: randomUUID(), title: 'Conferência', location: 'MZ01-E01-N01',
    startedAt: '2026-10-02T13:00:00.000Z', completedAt: '2026-10-02T15:00:00.000Z',
    catalogVersion: service.catalog.version, items,
  };
}

async function load(bytes: Buffer): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Uint8Array.from(bytes).buffer);
  return workbook;
}

async function exported(service: WorkbookService, items: InventoryItem[]) {
  const result = await service.export(inventory(service, items), user);
  expect(result.attachments.map(attachment => attachment.filename)).toEqual(['SB1_Produtos.xlsx', 'Inventario_Ytech.xlsx']);
  expect(result.attachments.every(attachment => Buffer.isBuffer(attachment.content))).toBe(true);
  return {
    ...result,
    sb1: await load(result.attachments[0]!.content),
    report: await load(result.attachments[1]!.content),
  };
}

function rowSnapshot(row: ExcelJS.Row, columns = 31) {
  return {
    height: row.height,
    hidden: row.hidden,
    outlineLevel: row.outlineLevel,
    cells: Array.from({ length: columns }, (_, index) => {
      const cell = row.getCell(index + 1);
      return { value: cell.value, style: cell.style, note: cell.note, dataValidation: cell.dataValidation };
    }),
  };
}

function sheetSnapshot(sheet: ExcelJS.Worksheet) {
  return {
    merges: sheet.model.merges,
    columns: sheet.columns.map(column => ({ width: column.width, hidden: column.hidden, style: column.style })),
    rows: Array.from({ length: sheet.rowCount }, (_, index) => rowSnapshot(sheet.getRow(index + 1), sheet.columnCount)),
  };
}

async function fixture(rows: Array<{ pn: ExcelJS.CellValue; code?: ExcelJS.CellValue; description?: string }>): Promise<{
  path: string; service: WorkbookService; workbook: ExcelJS.Workbook;
}> {
  const workbook = await load(originalBytes);
  const products = workbook.getWorksheet('Produtos')!;
  for (let number = products.rowCount; number >= 4; number -= 1) products.spliceRows(number, 1);
  for (const [index, entry] of rows.entries()) {
    const row = products.addRow([
      entry.code ?? `COD${index}`, entry.pn, entry.description ?? `Produto ${index}`,
      'PA', 'UND', '01', '0001', 'N', 'S', '01234567', 0,
    ]);
    row.getCell(2).numFmt = '@';
    row.getCell(29).value = 5;
    row.getCell(30).value = 10;
    row.getCell(31).value = 15;
    row.height = 29 + index;
    row.getCell(3).font = { name: 'Arial', size: 12, bold: true };
    row.getCell(29).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF92D050' } };
    row.getCell(31).numFmt = '0.00';
    row.getCell(31).border = { bottom: { style: 'thin', color: { argb: 'FFFF0000' } } };
  }
  workbook.getWorksheet('Grupos')!.getCell('A4').value = '0001';
  const path = join(fixtureDirectory, `${randomUUID()}.xlsx`);
  const bytes = Buffer.from(await workbook.xlsx.writeBuffer());
  await writeFile(path, bytes);
  return { path, service: await createWorkbookService(path), workbook: await load(bytes) };
}

beforeAll(async () => {
  const filenames = (await readdir(resolve('.'))).filter(name => name.endsWith('.xlsx'));
  expect(filenames).toHaveLength(1);
  originalPath = resolve(filenames[0]!);
  originalBytes = await readFile(originalPath);
  originalWorkbook = await load(originalBytes);
  originalService = await createWorkbookService(originalPath);
  await mkdir(fixtureDirectory, { recursive: true });
});

afterAll(async () => {
  await rm(fixtureDirectory, { recursive: true, force: true });
});

describe('catálogo do XLSX original', () => {
  it('usa SHA256 dos bytes e preserva o catálogo completo, inclusive as últimas linhas', () => {
    expect(originalService.catalog.version).toBe(createHash('sha256').update(originalBytes).digest('hex'));
    expect(originalService.catalog.products.find(product => product.pn === 'EC300K-1SA2AA6')).toMatchObject({
      code: '835884',
      description: 'COLETOR DE DADOS EC30 LAN, GMS, LEITOR 2D SE2100, 4GB/32GB, 1-PACK',
    });
    expect(originalService.catalog.products.some(product => product.pn === 'BR03600BK11045')).toBe(true);
    expect(originalService.catalog.locations).toEqual([
      'MZ01-E01-N01', 'MZ01-E01-N02', 'MZ01-E01-N03', 'MZ01-E02-N01', 'MZ01-E02-N02',
      'MZ01-E02-N03', 'MZ01-E03-N01', 'MZ01-E03-N02', 'MZ01-E03-N03',
    ]);
    expect(originalService.catalog.warnings.some(warning => warning.includes('B1_LOCPAD obrigatório vazio'))).toBe(true);
    expect(originalService.catalog.warnings.some(warning => warning.includes('não corresponde exatamente'))).toBe(true);
  });

  it('mantém cabeçalhos, merge, estilos, colunas e abas auxiliares; exporta um produto por PN', async () => {
    const result = await exported(originalService, [
      item('EC300K-1SA2AA6', '000001'), item('EC300K-1SA2AA6', '000002'), item('BR03600BK11045', '000003'),
    ]);
    expect(result.sb1.worksheets.map(sheet => sheet.name)).toEqual(['Produtos', 'Grupos', 'Endereço']);
    const source = originalWorkbook.getWorksheet('Produtos')!;
    const sheet = result.sb1.getWorksheet('Produtos')!;
    expect(sheet.actualRowCount).toBe(5);
    expect(sheet.model.merges).toEqual(source.model.merges);
    expect(sheet.columns.map(column => column.width)).toEqual(source.columns.map(column => column.width));
    for (const number of [1, 2, 3]) expect(rowSnapshot(sheet.getRow(number))).toEqual(rowSnapshot(source.getRow(number)));
    expect(rowSnapshot(sheet.getRow(4))).toEqual(rowSnapshot(source.getRow(4)));
    expect(rowSnapshot(sheet.getRow(5))).toEqual(rowSnapshot(source.getRow(254)));
    expect(sheet.getCell('F4').value).toBeNull();
    expect(sheet.getCell('G4').value).toBe('001');
    expect(['AC4', 'AD4', 'AE4'].map(address => sheet.getCell(address).value)).toEqual([5, 10, 15]);
    for (const name of ['Grupos', 'Endereço']) {
      expect(sheetSnapshot(result.sb1.getWorksheet(name)!)).toEqual(sheetSnapshot(originalWorkbook.getWorksheet(name)!));
    }
    expect(await readFile(originalPath)).toEqual(originalBytes);
    expect(result.warnings.some(warning => warning.includes('Revisão obrigatória'))).toBe(true);
  });

  it('registra uma unidade por serial e agrega a quantidade real por PN e localização', async () => {
    const result = await exported(originalService, [
      item('EC300K-1SA2AA6', '000001'),
      item('EC300K-1SA2AA6', '000002', 'MZ01-E01-N01', { source: 'ocr', rawPn: 'PN: EC300K-1SA2AA6', rawNs: 'NS: 000002' }),
      item('EC300K-1SA2AA6', '000003', 'MZ01-E01-N02'),
    ]);
    const details = result.report.getWorksheet('Inventário')!;
    expect(details.actualRowCount).toBe(4);
    expect([2, 3, 4].map(number => details.getCell(number, 3).value)).toEqual([1, 1, 1]);
    expect(details.getCell('B2').value).toBe('000001');
    expect(details.getCell('G2').value).toBe(user.email);
    expect(details.getCell('H2').value).toBe('2026-10-02T14:00:00.000Z');
    expect(details.getCell('I3').value).toBe('ocr');
    expect(details.getCell('J3').value).toBe('PN: EC300K-1SA2AA6');
    expect(details.getCell('K3').value).toBe('NS: 000002');
    expect(details.getCell('L2').text).toContain('B1_LOCPAD');
    expect(details.getCell('L2').fill).toMatchObject({ fgColor: { argb: 'FFFFE699' } });
    const summary = result.report.getWorksheet('Resumo')!;
    expect(summary.actualRowCount).toBe(3);
    expect([summary.getCell('C2').value, summary.getCell('C3').value]).toEqual([2, 1]);
    expect([summary.getCell('B2').value, summary.getCell('B3').value]).toEqual(['MZ01-E01-N01', 'MZ01-E01-N02']);
    expect(result.report.getWorksheet('Pendências')!.actualRowCount).toBeGreaterThan(1);
  });
});

describe('catálogos e leituras artificiais', () => {
  it('exclui PN desconhecido e PN ambíguo sem escolher a primeira linha', async () => {
    const { service } = await fixture([{ pn: 'DUP', code: 'A' }, { pn: ' dup ', code: 'B' }, { pn: 'OK' }]);
    expect(service.catalog.products.filter(product => product.pn === 'DUP')).toHaveLength(1);
    expect(service.catalog.products.find(product => product.pn === 'DUP')).toMatchObject({ code: '', description: '' });
    expect(service.catalog.products.find(product => product.pn === 'DUP')!.issues.join()).toContain('ambíguo');
    const result = await exported(service, [item('DUP', '001'), item('UNKNOWN', '002'), item('OK', '003')]);
    const sb1 = result.sb1.getWorksheet('Produtos')!;
    expect(sb1.actualRowCount).toBe(4);
    expect(sb1.getCell('B4').value).toBe('OK');
    const details = result.report.getWorksheet('Inventário')!;
    expect(details.getCell('E2').value).toBe('');
    expect(details.getCell('E3').value).toBe('');
    expect(details.getCell('L2').text).toContain('ambíguo');
    expect(details.getCell('L3').text).toContain('desconhecido');
    expect(result.report.getWorksheet('Resumo')!.actualRowCount).toBe(4);
    const issueText = result.report.getWorksheet('Pendências')!.getColumn(4).values.join('\n');
    expect(issueText).toContain('ambíguo');
    expect(issueText).toContain('desconhecido');
  });

  it('gera SB1 somente com cabeçalhos quando nenhum PN pode ser exportado', async () => {
    const { service } = await fixture([{ pn: 'DUP' }, { pn: 'DUP' }]);
    const result = await exported(service, [item('DUP', '001'), item('UNKNOWN', '002')]);
    expect(result.sb1.getWorksheet('Produtos')!.actualRowCount).toBe(3);
    expect(result.sb1.getWorksheet('Produtos')!.model.merges).toEqual(['A1:AE1']);
    expect(result.report.getWorksheet('Inventário')!.actualRowCount).toBe(3);
  });

  it('preserva zeros, textos iniciados com =, campos distantes e estilos da linha selecionada', async () => {
    const { service, workbook } = await fixture([{ pn: 'IGNORED' }, { pn: '000012' }, { pn: '=1+1' }]);
    const result = await exported(service, [
      item('000012', '000099'), item('=1+1', '=2+2', 'MZ01-E01-N01', { rawPn: '=SUM(1,1)', rawNs: '=HYPERLINK("x")' }),
    ]);
    const sb1 = result.sb1.getWorksheet('Produtos')!;
    expect(rowSnapshot(sb1.getRow(4))).toEqual(rowSnapshot(workbook.getWorksheet('Produtos')!.getRow(5)));
    expect(sb1.getCell('B4').value).toBe('000012');
    expect(sb1.getCell('B5').value).toBe('=1+1');
    expect(sb1.getCell('B5').type).toBe(ExcelJS.ValueType.String);
    expect(sb1.getCell('B5').numFmt).toBe('@');
    const details = result.report.getWorksheet('Inventário')!;
    for (const address of ['A2', 'B2', 'A3', 'B3', 'J3', 'K3']) {
      expect(details.getCell(address).type).toBe(ExcelJS.ValueType.String);
      expect(details.getCell(address).numFmt).toBe('@');
    }
    expect(details.getCell('A2').value).toBe('000012');
    expect(details.getCell('B2').value).toBe('000099');
    expect(details.getCell('J3').value).toBe('=SUM(1,1)');
    expect(details.getCell('K3').value).toBe('=HYPERLINK("x")');
    expect(result.warnings).toEqual([]);
  });

  it('lê zeros de uma máscara numérica explícita sem inventar zeros nos demais códigos', async () => {
    const { path, workbook } = await fixture([{ pn: 12 }]);
    workbook.getWorksheet('Produtos')!.getCell('B4').numFmt = '000000';
    await writeFile(path, Buffer.from(await workbook.xlsx.writeBuffer()));
    const service = await createWorkbookService(path);
    expect(service.catalog.products[0]!.pn).toBe('000012');
    const result = await exported(service, [item('000012', '000005')]);
    expect(result.sb1.getWorksheet('Produtos')!.getCell('B4').value).toBe('000012');
    expect(result.sb1.getWorksheet('Produtos')!.getCell('B4').type).toBe(ExcelJS.ValueType.String);
  });

  it('relata todos os obrigatórios ausentes sem preencher nenhum valor e aceita origem zero', async () => {
    const { path, workbook } = await fixture([{ pn: 'EMPTY', code: '' }]);
    const sheet = workbook.getWorksheet('Produtos')!;
    for (const column of [3, 4, 5, 6, 10, 11]) sheet.getCell(4, column).value = null;
    await writeFile(path, Buffer.from(await workbook.xlsx.writeBuffer()));
    const service = await createWorkbookService(path);
    const issues = service.catalog.products[0]!.issues.join('\n');
    for (const name of ['B1_COD', 'B1_DESC', 'B1_TIPO', 'B1_UM', 'B1_LOCPAD', 'B1_POSIPI', 'B1_ORIGEM']) {
      expect(issues).toContain(`${name} obrigatório vazio`);
    }
    const result = await exported(service, [item('EMPTY', '001')]);
    for (const column of [3, 4, 5, 6, 10, 11]) expect(result.sb1.getWorksheet('Produtos')!.getCell(4, column).value).toBeNull();
    const valid = await fixture([{ pn: 'VALID' }]);
    expect(valid.service.catalog.products[0]!.issues).toEqual([]);
  });

  it('valida tamanho da descrição, NCM, armazém, grupos e códigos repetidos sem corrigir', async () => {
    const { path, workbook } = await fixture([{ pn: 'BAD', code: 'SAME', description: 'D'.repeat(81) }, { pn: 'OTHER', code: 'SAME' }]);
    const sheet = workbook.getWorksheet('Produtos')!;
    sheet.getCell('F4').value = 'MZ01';
    sheet.getCell('G4').value = '001';
    sheet.getCell('J4').value = '123.456789';
    await writeFile(path, Buffer.from(await workbook.xlsx.writeBuffer()));
    const service = await createWorkbookService(path);
    const issues = service.catalog.products[0]!.issues.join('\n');
    for (const text of ['80 caracteres', 'até 8 dígitos', 'armazém de 2 dígitos', '4 dígitos', 'não corresponde exatamente', 'B1_COD repetido']) {
      expect(issues).toContain(text);
    }
    const result = await exported(service, [item('BAD', '001', 'LOCAL NOVO')]);
    const out = result.sb1.getWorksheet('Produtos')!;
    for (const address of ['A4', 'C4', 'F4', 'G4', 'J4']) expect(out.getCell(address).value).toEqual(sheet.getCell(address).value);
    expect(result.warnings.join('\n')).toContain('Localização não consta');
  });

  it('isola exportações concorrentes e ignora modificações no catálogo público', async () => {
    const { service, path } = await fixture([{ pn: 'ONE' }, { pn: 'TWO' }]);
    const bytes = await readFile(path);
    service.catalog.products[0]!.code = 'ALTERADO';
    const [first, second] = await Promise.all([exported(service, [item('ONE', '001')]), exported(service, [item('TWO', '002')])]);
    expect(first.sb1.getWorksheet('Produtos')!.getCell('B4').value).toBe('ONE');
    expect(second.sb1.getWorksheet('Produtos')!.getCell('B4').value).toBe('TWO');
    expect(first.report.getWorksheet('Inventário')!.getCell('E2').value).toBe('COD0');
    expect(await readFile(path)).toEqual(bytes);
  });

  it('reavalia uma fila offline de catálogo antigo sem descartar nem alterar as leituras', async () => {
    const { service } = await fixture([{ pn: 'CURRENT', code: 'ATUAL' }]);
    const pending = { ...inventory(service, [item('CURRENT', '0001'), item('REMOVED', '0002')]), catalogVersion: 'versao-anterior' };
    const before = structuredClone(pending);
    const result = await service.export(pending, user);
    expect(pending).toEqual(before);
    expect(result.warnings.join('\n')).toContain('A versão do catálogo mudou');
    expect(result.warnings.join('\n')).toContain('PN REMOVED');
    const sb1 = await load(result.attachments[0]!.content);
    expect(sb1.getWorksheet('Produtos')!.actualRowCount).toBe(4);
    expect(sb1.getWorksheet('Produtos')!.getCell('A4').value).toBe('ATUAL');
    const report = await load(result.attachments[1]!.content);
    expect(report.getWorksheet('Inventário')!.actualRowCount).toBe(3);
    expect(report.getWorksheet('Inventário')!.getCell('A3').value).toBe('REMOVED');
    expect(report.getWorksheet('Inventário')!.getCell('B3').value).toBe('0002');
    expect(report.getWorksheet('Resumo')!.actualRowCount).toBe(3);
    expect(report.getWorksheet('Pendências')!.getColumn(4).values.join('\n')).toContain('A versão do catálogo mudou');
  });

  it('falha explicitamente para arquivo ausente, corrompido, abas ou cabeçalhos inválidos', async () => {
    await expect(createWorkbookService(join(fixtureDirectory, 'missing.xlsx'))).rejects.toThrow('Não foi possível ler');
    const invalidPath = join(fixtureDirectory, 'invalid.xlsx');
    await writeFile(invalidPath, 'not an XLSX');
    await expect(createWorkbookService(invalidPath)).rejects.toThrow('não é um XLSX legível');
    const { path, workbook } = await fixture([{ pn: 'VALID' }]);
    workbook.getWorksheet('Produtos')!.getCell('B2').value = 'B1_ERRADO';
    await writeFile(path, Buffer.from(await workbook.xlsx.writeBuffer()));
    await expect(createWorkbookService(path)).rejects.toThrow('cabeçalho Produtos!B2');
    workbook.getWorksheet('Produtos')!.getCell('B2').value = 'B1_XPART';
    workbook.removeWorksheet('Endereço');
    await writeFile(path, Buffer.from(await workbook.xlsx.writeBuffer()));
    await expect(createWorkbookService(path)).rejects.toThrow('aba "Endereço" ausente');
  });
});
