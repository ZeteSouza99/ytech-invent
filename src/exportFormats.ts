import { z } from 'zod';
import { formatCnpj, organizationKindLabel } from '../shared/company';
import { inventorySchema, MAX_BACKUP_BYTES, MAX_BACKUP_INVENTORIES, MAX_PAYLOAD_BYTES, utf8ByteLength } from '../shared/model';
import { formatDateTime, quantityByPn, REPORT_COLUMNS, reportRows, type Describe, type ReportEntry } from '../shared/report';

export type ExportEntry = ReportEntry;
export type ExportFormat = 'xlsx' | 'pdf' | 'csv' | 'json';

// Excel in Portuguese (Brazil) splits CSV columns on ';' when the file is opened directly.
const CSV_SEPARATOR = ';';

export function inventoriesJson(entries: ExportEntry[]): string {
  const text = JSON.stringify({ application: 'YtechInvent', schemaVersion: 1, exportedAt: new Date().toISOString(), inventories: entries });
  parseInventoryBackup(text);
  return text;
}

export function parseInventoryBackup(text: string): ExportEntry[] {
  if (utf8ByteLength(text) > MAX_BACKUP_BYTES) throw new Error('O arquivo de backup excede 32 MB.');
  const schema = z.object({
    application: z.literal('YtechInvent'), schemaVersion: z.literal(1), exportedAt: z.iso.datetime(),
    inventories: z.array(z.object({ inventory: inventorySchema, partial: z.boolean() }).strict()).min(1).max(MAX_BACKUP_INVENTORIES),
  }).strict();
  const result = schema.parse(JSON.parse(text));
  if (result.inventories.some(entry => utf8ByteLength(JSON.stringify(entry.inventory)) > MAX_PAYLOAD_BYTES)) {
    throw new Error('Um inventário do arquivo excede 8 MB.');
  }
  return result.inventories;
}

function csvCell(value: unknown): string {
  let text = String(value ?? '');
  // Quoting alone does not prevent spreadsheet formula execution.
  if (/^[\s]*[=+@-]|^[\t\r\n]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export function inventoriesCsv(entries: ExportEntry[], describe: Describe): string {
  const rows: unknown[][] = [[...REPORT_COLUMNS], ...reportRows(entries, describe).map(row => [
    row.company, row.cnpj, row.inventory, row.pn, row.description, row.ns, row.quantity,
    row.patrimony, row.location, formatDateTime(row.capturedAt),
  ])];
  return '\ufeff' + rows.map(row => row.map(csvCell).join(CSV_SEPARATOR)).join('\r\n');
}

function html(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}

export function inventoriesHtml(entries: ExportEntry[], describe: Describe): string {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><style>
    @page { size: A4; margin: 14mm 10mm; }
    body { font-family: sans-serif; color: #16324f; font-size: 10px; }
    h1 { color: #2457db; font-size: 20px; margin: 0 0 4px; } h2 { font-size: 15px; margin: 0 0 8px; } h3 { font-size: 13px; margin: 18px 0 0; }
    section + section { break-before: page; } p { margin: 3px 0; overflow-wrap: anywhere; }
    table { width: 100%; border-collapse: collapse; table-layout: fixed; margin-top: 10px; }
    thead { display: table-header-group; } tr { break-inside: avoid; }
    th, td { text-align: left; border: 1px solid #d4dfed; padding: 4px 5px; overflow-wrap: anywhere; vertical-align: top; }
    th { background: #edf3ff; } .number { text-align: right; } .total td { font-weight: bold; background: #f6f9ff; }
    .partial { color: #945400; font-weight: bold; }
  </style></head><body>${entries.map(entry => {
    const { inventory: inv, partial } = entry;
    const rows = reportRows([entry], describe);
    const quantities = quantityByPn([entry], describe);
    return `<section>
    <h1>Ytech Soluções · Inventário</h1><h2>${html(inv.title)}</h2>
    <p class="${partial ? 'partial' : ''}">${partial ? 'PARCIAL — coleta ainda aberta' : 'Coleta concluída'}</p>
    <p><b>Tipo:</b> ${organizationKindLabel(inv.organization)} · <b>Empresa:</b> ${html(inv.organization?.name ?? 'Não informada')} · <b>CNPJ:</b> ${html(inv.organization ? formatCnpj(inv.organization.cnpj) : 'Não informado')}</p>
    <p><b>Localização inicial:</b> ${html(inv.location)}</p>
    <p><b>Início:</b> ${formatDateTime(inv.startedAt)} · <b>${partial ? 'Cópia parcial' : 'Conclusão'}:</b> ${formatDateTime(inv.completedAt)}</p>
    <p><b>Unidades:</b> ${inv.items.length} · <b>PN distintos:</b> ${quantities.length} · <b>ID:</b> ${html(inv.id)}</p>
    <table><colgroup><col style="width:5%"><col style="width:18%"><col style="width:25%"><col style="width:17%"><col style="width:6%"><col style="width:12%"><col style="width:17%"></colgroup>
    <thead><tr><th>Nº</th><th>PN</th><th>Descrição</th><th>NS</th><th class="number">Qtd</th><th>Patrimônio</th><th>Localização</th></tr></thead><tbody>
    ${rows.map((row, index) => `<tr class="u"><td>${index + 1}</td><td>${html(row.pn)}</td><td>${html(row.description)}</td><td>${html(row.ns)}</td><td class="number">${row.quantity}</td><td>${html(row.patrimony)}</td><td>${html(row.location)}</td></tr>`).join('')}
    </tbody></table>
    <h3>Quantidade por PN</h3>
    <table><colgroup><col style="width:30%"><col style="width:56%"><col style="width:14%"></colgroup>
    <thead><tr><th>PN</th><th>Descrição</th><th class="number">Quantidade</th></tr></thead><tbody>
    ${quantities.map(row => `<tr><td>${html(row.pn)}</td><td>${html(row.description)}</td><td class="number">${row.quantity}</td></tr>`).join('')}
    <tr class="total"><td colspan="2">Total</td><td class="number">${rows.reduce((sum, row) => sum + row.quantity, 0)}</td></tr>
    </tbody></table>
  </section>`;
  }).join('')}</body></html>`;
}
