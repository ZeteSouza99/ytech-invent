import ExcelJS from 'exceljs';
import { formatCnpj, organizationKindLabel } from './company';
import { normalizeCode, type Catalog, type Inventory, type Product, type User } from './model';

export type WorkbookAttachment = { filename: string; mimeType: string; content: Uint8Array };

export interface WorkbookService {
  catalog: Catalog;
  export(inventory: Inventory, user: User, options?: { partial?: boolean }): Promise<{ attachments: WorkbookAttachment[]; warnings: string[] }>;
}

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const FIRST_PRODUCT_ROW = 4;
const PRODUCT_HEADERS = new Map([
  [1, 'B1_COD'], [2, 'B1_XPART'], [3, 'B1_DESC'], [4, 'B1_TIPO'],
  [5, 'B1_UM'], [6, 'B1_LOCPAD'], [7, 'B1_GRUPO'], [8, 'B1_RASTRO'],
  [9, 'B1_LOCALIZ'], [10, 'B1_POSIPI'], [11, 'B1_ORIGEM'], [12, 'B1_CODISS'],
  [29, 'B1_EMIN'], [30, 'B1_ESTSEG'], [31, 'B1_LE'],
]);
const REQUIRED_COLUMNS = [1, 3, 4, 5, 6, 10, 11];
const REVIEW_WARNING = 'Revisão obrigatória antes de importar o SB1: os valores originais, inclusive campos vazios, foram mantidos. Consulte a aba Pendências.';

interface CatalogRow {
  number: number;
  product: Product;
}

// Hermes does not provide structuredClone; workbook models only contain plain data and dates.
function clone<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return new Date(value.getTime()) as T;
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
  throw new Error(`Modelo inválido: fórmula no campo ${cell.address}; use um valor literal revisado no catálogo.`);
}

function requireSheet(workbook: ExcelJS.Workbook, name: string): ExcelJS.Worksheet {
  const sheet = workbook.getWorksheet(name);
  if (!sheet) throw new Error(`Modelo inválido: aba "${name}" ausente.`);
  return sheet;
}

function validateHeaders(sheet: ExcelJS.Worksheet, headers: Map<number, string>): void {
  for (const [column, expected] of headers) {
    const cell = sheet.getCell(2, column);
    const actual = cellText(cell).trim().replace(/\s*\(obrigatório\)\s*$/i, '').trim();
    if (actual !== expected || !cellText(sheet.getCell(3, column)).trim()) {
      throw new Error(`Modelo inválido: cabeçalho ${sheet.name}!${cell.address}; esperado ${expected} e instrução na linha 3.`);
    }
  }
}

function validateProduct(row: ExcelJS.Row, groups: Set<string>): string[] {
  const issues: string[] = [];
  for (const column of REQUIRED_COLUMNS) {
    if (!cellText(row.getCell(column)).trim()) {
      issues.push(`${PRODUCT_HEADERS.get(column)} obrigatório vazio (linha ${row.number}); valor original mantido.`);
    }
  }
  if (cellText(row.getCell(3)).length > 80) {
    issues.push(`B1_DESC excede 80 caracteres (linha ${row.number}); descrição original mantida.`);
  }
  const ncm = cellText(row.getCell(10));
  if (ncm.trim() && !/^\d{1,8}$/.test(ncm)) {
    issues.push(`B1_POSIPI deve conter apenas números, com até 8 dígitos (linha ${row.number}); NCM original mantido.`);
  }
  const warehouse = cellText(row.getCell(6));
  if (warehouse.trim() && !/^\d{2}$/.test(warehouse)) {
    issues.push(`B1_LOCPAD deve ser um código de armazém de 2 dígitos (linha ${row.number}); código original mantido.`);
  }
  const group = cellText(row.getCell(7));
  if (group.trim()) {
    if (!/^\d{4}$/.test(group)) {
      issues.push(`B1_GRUPO deve ter 4 dígitos (linha ${row.number}); código original mantido.`);
    }
    if (!groups.has(group)) {
      issues.push(`B1_GRUPO não corresponde exatamente a um código da aba Grupos (linha ${row.number}); não houve conversão nem preenchimento.`);
    }
  }
  return issues;
}

function addReportSheet(workbook: ExcelJS.Workbook, name: string, headers: string[]): ExcelJS.Worksheet {
  const sheet = workbook.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
  sheet.addRow(headers);
  sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF17365D' } };
  sheet.columns.forEach((column, index) => {
    column.width = index === headers.length - 1 ? 75 : 26;
    column.numFmt = '@';
  });
  return sheet;
}

function finishReportSheet(sheet: ExcelJS.Worksheet): void {
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: sheet.rowCount, column: sheet.columnCount } };
  sheet.eachRow((row, number) => {
    if (number > 1) row.alignment = { vertical: 'top', wrapText: true };
  });
}

function copyProductRow(source: ExcelJS.Row, target: ExcelJS.Row): void {
  target.model = { ...clone(source.model), number: target.number, cells: [] };
  source.eachCell({ includeEmpty: true }, (cell, column) => {
    const destination = target.getCell(column);
    destination.value = clone(cell.value);
    destination.style = clone(cell.style);
    if (cell.dataValidation) destination.dataValidation = clone(cell.dataValidation);
    if (cell.note) destination.note = clone(cell.note);
  });
  target.getCell(2).value = cellText(source.getCell(2));
  target.getCell(2).numFmt = '@';
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

export async function createWorkbookService(templateBytes: Uint8Array, version: string): Promise<WorkbookService> {
  if (!version.trim()) throw new Error('Versão do catálogo ausente.');
  // Keep a private copy so later changes to the caller's buffer cannot alter exports.
  const template = templateBytes.slice();
  const workbook = await loadTemplate(template);
  const products = requireSheet(workbook, 'Produtos');
  const groupSheet = requireSheet(workbook, 'Grupos');
  const locationSheet = requireSheet(workbook, 'Endereço');
  validateHeaders(products, PRODUCT_HEADERS);
  validateHeaders(groupSheet, new Map([[1, 'BM_GRUPO'], [2, 'BM_GRUPO']]));
  validateHeaders(locationSheet, new Map([[1, 'BE_LOCAL'], [2, 'BE_LOCALIZ'], [3, 'BE_DESCRIC']]));
  if (!products.model.merges.includes('A1:AE1') || !cellText(products.getCell('A1')).trim()) {
    throw new Error('Modelo inválido: título mesclado Produtos!A1:AE1 ausente.');
  }

  const groups = new Set<string>();
  groupSheet.eachRow((row, number) => {
    if (number >= FIRST_PRODUCT_ROW && cellText(row.getCell(1)).trim()) groups.add(cellText(row.getCell(1)));
  });
  const locations = new Set<string>();
  locationSheet.eachRow((row, number) => {
    const description = cellText(row.getCell(3)).trim();
    if (number >= FIRST_PRODUCT_ROW && description) locations.add(description);
  });
  const rowsByPn = new Map<string, CatalogRow[]>();
  const rowsByCode = new Map<string, CatalogRow[]>();
  const warnings: string[] = [];
  products.eachRow((row, number) => {
    if (number < FIRST_PRODUCT_ROW) return;
    const pn = normalizeCode(cellText(row.getCell(2)));
    if (!pn) {
      if (row.hasValues) warnings.push(`Linha ${number} de Produtos sem B1_XPART; não pode ser associada a uma leitura e será excluída do SB1.`);
      return;
    }
    const code = cellText(row.getCell(1));
    const description = cellText(row.getCell(3));
    if (pn.length > 120 || code.length > 120 || description.length > 2000) {
      throw new Error(`Modelo inválido: identificador ou descrição excede os limites do catálogo na linha ${number}.`);
    }
    const entry: CatalogRow = { number, product: { pn, code, description, issues: validateProduct(row, groups) } };
    rowsByPn.set(pn, [...(rowsByPn.get(pn) ?? []), entry]);
    if (code.trim()) rowsByCode.set(code, [...(rowsByCode.get(code) ?? []), entry]);
  });
  if (rowsByPn.size === 0) throw new Error('Modelo inválido: nenhum produto com B1_XPART foi encontrado a partir da linha 4.');
  for (const entries of rowsByCode.values()) {
    if (entries.length > 1) {
      for (const entry of entries) entry.product.issues.push(`B1_COD repetido no catálogo (linha ${entry.number}); revisar o código sem substituição automática.`);
    }
  }

  const catalogProducts: Product[] = [];
  for (const [pn, entries] of rowsByPn) {
    const first = entries[0]!;
    if (entries.length > 1) {
      const lines = entries.map(entry => entry.number).join(', ').slice(0, 200);
      catalogProducts.push({
        pn, code: '', description: '',
        issues: [`Conflito: PN ambíguo em ${entries.length} linhas do catálogo (${lines}); excluído do SB1 até revisão.`],
      });
    } else {
      catalogProducts.push(first.product);
    }
  }
  for (const product of catalogProducts) {
    warnings.push(...product.issues.map(issue => `PN ${product.pn}: ${issue}`));
  }
  const catalog: Catalog = { version, products: catalogProducts, locations: [...locations], warnings };
  const productByPn = new Map(catalogProducts.map(product => [product.pn, clone(product)]));

  return {
    catalog: clone(catalog),
    async export(inventory, user, options = {}) {
      // Every export starts from the same bytes, isolating concurrent calls and preserving the original.
      const sb1 = await loadTemplate(template);
      const sb1Products = requireSheet(sb1, 'Produtos');
      const selectedRows = new Set<number>();
      const exportWarnings = new Set<string>();
      const report = new ExcelJS.Workbook();
      const identification = addReportSheet(report, 'Identificação', ['Campo', 'Valor']);
      const exportedAt = new Date().toISOString();
      [
        ['Inventário', inventory.title], ['ID', inventory.id],
          ['Tipo', organizationKindLabel(inventory.organization)],
          ['Empresa inventariada', inventory.organization?.name ?? 'Não informada'],
          ['CNPJ', inventory.organization ? formatCnpj(inventory.organization.cnpj) : 'Não informado'],
        ['Situação', options.partial ? 'PARCIAL — coleta ainda aberta' : 'Coleta concluída'],
        ['Responsável', user.email], ['Localização inicial', inventory.location],
        ['Início', inventory.startedAt],
        [options.partial ? 'Captura da cópia parcial' : 'Conclusão', inventory.completedAt],
        ['Exportação', exportedAt], ['Catálogo da coleta', inventory.catalogVersion], ['Catálogo da exportação', version],
      ].forEach(row => identification.addRow(row));
      identification.getColumn(2).width = 80;
      const inventorySheet = addReportSheet(report, 'Inventário', [
        'PN', 'NS', 'Quantidade', 'Localização', 'Código', 'Descrição', 'Responsável (email)',
        'Data', 'Origem da leitura', 'Bruto PN', 'Bruto NS', 'Pendências', 'Patrimônio',
      ]);
      const summarySheet = addReportSheet(report, 'Resumo', ['PN', 'Localização', 'Quantidade', 'Código', 'Descrição', 'Pendências']);
      const issuesSheet = addReportSheet(report, 'Pendências', ['PN', 'NS', 'Localização', 'Pendência']);
      if (options.partial) {
        const warning = 'CÓPIA PARCIAL: a coleta ainda está aberta. Esta exportação não conclui o inventário e não confirma envio por e-mail.';
        exportWarnings.add(warning);
        issuesSheet.addRow(['', '', '', warning]);
      }
      if (inventory.catalogVersion !== version) {
        const warning = 'A versão do catálogo mudou desde a coleta. Todas as leituras foram preservadas e reavaliadas contra o catálogo atual; revise as pendências antes de importar.';
        exportWarnings.add(warning);
        issuesSheet.addRow(['', '', '', warning]);
      }
      const summary = new Map<string, { pn: string; location: string; quantity: number; product?: Product; issues: Set<string> }>();
      for (const item of inventory.items) {
        const pn = normalizeCode(item.pn);
        const product = productByPn.get(pn);
        const entries = rowsByPn.get(pn);
        const known = entries?.length === 1;
        const issues = product ? [...product.issues] : ['PN desconhecido no catálogo; excluído do SB1 e pendente de cadastro/revisão.'];
        if (known) selectedRows.add(entries[0]!.number);
        if (!locations.has(item.location)) issues.push('Localização não consta na aba Endereço; mantida como informada para revisão.');
        const row = inventorySheet.addRow([
          item.pn, item.ns, 1, item.location, known ? product!.code : '', known ? product!.description : '',
          user.email, item.capturedAt, item.source, item.rawPn, item.rawNs, issues.join('\n'), item.patrimony ?? '',
        ]);
        row.getCell(3).numFmt = '0';
        if (issues.length) row.getCell(12).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFE699' } };
        for (const issue of issues) {
          exportWarnings.add(`PN ${pn}: ${issue}`);
          issuesSheet.addRow([item.pn, item.ns, item.location, issue]);
        }
        const key = JSON.stringify([pn, item.location]);
        const aggregate = summary.get(key) ?? { pn, location: item.location, quantity: 0, product: known ? product : undefined, issues: new Set<string>() };
        aggregate.quantity += 1;
        issues.forEach(issue => aggregate.issues.add(issue));
        summary.set(key, aggregate);
      }
      for (const aggregate of summary.values()) {
        const row = summarySheet.addRow([
          aggregate.pn, aggregate.location, aggregate.quantity, aggregate.product?.code ?? '',
          aggregate.product?.description ?? '', [...aggregate.issues].join('\n'),
        ]);
        row.getCell(3).numFmt = '0';
      }
      if (exportWarnings.size) {
        exportWarnings.add(REVIEW_WARNING);
        issuesSheet.addRow(['', '', '', REVIEW_WARNING]);
      }
      // spliceRows does not carry hidden/outline/validations when shifting rows.
      // Remove from the end and copy complete records in the original catalog order.
      for (let number = sb1Products.rowCount; number >= FIRST_PRODUCT_ROW; number -= 1) sb1Products.spliceRows(number, 1);
      for (const number of [...selectedRows].sort((left, right) => left - right)) {
        copyProductRow(products.getRow(number), sb1Products.addRow([]));
      }
      if (sb1Products.autoFilter) sb1Products.autoFilter = `A3:AE${Math.max(3, selectedRows.size + 3)}`;
      [identification, inventorySheet, summarySheet, issuesSheet].forEach(finishReportSheet);
      const sb1Bytes = toBytes(await sb1.xlsx.writeBuffer());
      const reportBytes = toBytes(await report.xlsx.writeBuffer());
      return {
        attachments: [
          { filename: 'SB1_Produtos.xlsx', mimeType: XLSX_MIME, content: sb1Bytes },
          { filename: 'Inventario_Ytech.xlsx', mimeType: XLSX_MIME, content: reportBytes },
        ],
        warnings: [...exportWarnings],
      };
    },
  };
}
