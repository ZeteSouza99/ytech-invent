import ExcelJS from 'exceljs';
import { normalizeCode, type Catalog, type Product } from './model';
import { describeFrom, quantityByPn, REPORT_COLUMNS, reportFilename, reportRows, spreadsheetDateTime, type ReportEntry } from './report';

export type WorkbookAttachment = { filename: string; mimeType: string; content: Uint8Array };

export interface WorkbookService {
  catalog: Catalog;
  // One simple spreadsheet: every unit of the given inventories and the quantity of each part number.
  spreadsheet(entries: readonly ReportEntry[]): Promise<WorkbookAttachment>;
}

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
// The catalog file is the SB1 product list: titles in row 1, field names in row 2, instructions in row 3.
const FIRST_PRODUCT_ROW = 4;
const PRODUCT_HEADERS = new Map([[1, 'B1_COD'], [2, 'B1_XPART'], [3, 'B1_DESC']]);
const TEXT = '@';
const HEADER_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF17365D' } };

// Hermes does not provide structuredClone; catalog data only contains plain values.
function clone<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(entry => clone(entry)) as T;
  const copy: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) copy[key] = clone(entry);
  return copy as T;
}

function cellText(cell: ExcelJS.Cell): string {
  const value = cell.value;
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') {
    // The explicit mask is part of the identifier; never guess missing zeros.
    if (Number.isInteger(value) && value >= 0 && /^0+$/.test(cell.numFmt)) {
      return String(value).padStart(cell.numFmt.length, '0');
    }
    return String(value);
  }
  if (typeof value === 'boolean') return String(value);
  if (value instanceof Date) return value.toISOString();
  if ('richText' in value) return value.richText.map(part => part.text).join('');
  if ('text' in value) return value.text;
  if ('error' in value) return value.error;
  throw new Error(`Catálogo inválido: fórmula no campo ${cell.address}; use um valor literal.`);
}

function validateHeaders(sheet: ExcelJS.Worksheet): void {
  for (const [column, expected] of PRODUCT_HEADERS) {
    const cell = sheet.getCell(2, column);
    const actual = cellText(cell).trim().replace(/\s*\(obrigatório\)\s*$/i, '').trim();
    if (actual !== expected) throw new Error(`Modelo inválido: cabeçalho ${sheet.name}!${cell.address}; esperado ${expected}.`);
  }
}

function toBytes(data: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

async function loadTemplate(template: Uint8Array): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(template.slice().buffer);
  } catch {
    throw new Error('Modelo inválido: o arquivo não é um XLSX legível.');
  }
  return workbook;
}

function styleHeader(sheet: ExcelJS.Worksheet): void {
  const header = sheet.getRow(1);
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.fill = HEADER_FILL;
  header.alignment = { vertical: 'middle' };
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(1, sheet.rowCount), column: sheet.columnCount } };
}

async function buildSpreadsheet(entries: readonly ReportEntry[], products: readonly Product[]): Promise<WorkbookAttachment> {
  const describe = describeFrom(products);
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Ytech Invent';

  const units = workbook.addWorksheet('Inventário', { views: [{ state: 'frozen', ySplit: 1 }] });
  const widths = [26, 20, 28, 24, 44, 22, 12, 18, 22, 18];
  // Text format keeps leading zeros and stops Excel from turning codes into numbers or formulas.
  const formats = [TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, '0', TEXT, TEXT, 'dd/mm/yyyy hh:mm'];
  units.columns = REPORT_COLUMNS.map((header, index) => ({ header, width: widths[index], style: { numFmt: formats[index] } }));
  for (const row of reportRows(entries, describe)) {
    // Empty cells stay empty instead of holding an empty text.
    units.addRow([
      row.company || null, row.cnpj || null, row.inventory, row.pn, row.description || null, row.ns, row.quantity,
      row.patrimony || null, row.location, spreadsheetDateTime(row.capturedAt),
    ]);
  }
  styleHeader(units);

  const summary = workbook.addWorksheet('Resumo', { views: [{ state: 'frozen', ySplit: 1 }] });
  summary.columns = [
    { header: 'Inventário', width: 28, style: { numFmt: TEXT } },
    { header: 'Empresa', width: 26, style: { numFmt: TEXT } },
    { header: 'PN', width: 24, style: { numFmt: TEXT } },
    { header: 'Descrição', width: 44, style: { numFmt: TEXT } },
    { header: 'Quantidade', width: 12, style: { numFmt: '0' } },
  ];
  let total = 0;
  for (const row of quantityByPn(entries, describe)) {
    summary.addRow([row.inventory, row.company || null, row.pn, row.description || null, row.quantity]);
    total += row.quantity;
  }
  styleHeader(summary);
  summary.addRow(['Total', null, null, null, total]).font = { bold: true };

  return { filename: reportFilename(entries, 'xlsx'), mimeType: XLSX_MIME, content: toBytes(await workbook.xlsx.writeBuffer()) };
}

// Reads the SB1 product list used to recognize part numbers and fill in their descriptions.
export async function createWorkbookService(templateBytes: Uint8Array, version: string): Promise<WorkbookService> {
  if (!version.trim()) throw new Error('Versão do catálogo ausente.');
  const workbook = await loadTemplate(templateBytes);
  const products = workbook.getWorksheet('Produtos');
  if (!products) throw new Error('Modelo inválido: aba "Produtos" ausente.');
  validateHeaders(products);

  const rowsByPn = new Map<string, { number: number; code: string; description: string }[]>();
  products.eachRow((row, number) => {
    if (number < FIRST_PRODUCT_ROW) return;
    const pn = normalizeCode(cellText(row.getCell(2)));
    if (!pn) return;
    const code = cellText(row.getCell(1)).trim();
    const description = cellText(row.getCell(3)).trim();
    if (pn.length > 120 || code.length > 120 || description.length > 2000) {
      throw new Error(`Modelo inválido: identificador ou descrição excede os limites do catálogo na linha ${number}.`);
    }
    rowsByPn.set(pn, [...(rowsByPn.get(pn) ?? []), { number, code, description }]);
  });
  if (rowsByPn.size === 0) throw new Error('Modelo inválido: nenhum produto com B1_XPART foi encontrado a partir da linha 4.');

  const warnings: string[] = [];
  const catalogProducts: Product[] = [];
  for (const [pn, rows] of rowsByPn) {
    const descriptions = new Set(rows.map(row => row.description));
    if (descriptions.size > 1) {
      // Different products under the same part number: no description is better than a wrong one.
      warnings.push(`PN ${pn} aparece com descrições diferentes nas linhas ${rows.map(row => row.number).join(', ').slice(0, 200)} do catálogo; ficará sem descrição.`);
      catalogProducts.push({ pn, code: '', description: '' });
    } else {
      catalogProducts.push({ pn, code: rows[0]!.code, description: rows[0]!.description });
    }
  }

  const locations = new Set<string>();
  workbook.getWorksheet('Endereço')?.eachRow((row, number) => {
    const description = cellText(row.getCell(3)).trim();
    if (number >= FIRST_PRODUCT_ROW && description) locations.add(description);
  });

  const catalog: Catalog = { version, products: catalogProducts, locations: [...locations], warnings };
  const privateProducts = clone(catalogProducts);
  return {
    catalog: clone(catalog),
    spreadsheet: entries => buildSpreadsheet(entries, privateProducts),
  };
}
