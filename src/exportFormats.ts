import { z } from 'zod';
import { formatCnpj } from '../shared/company';
import { inventorySchema, MAX_PAYLOAD_BYTES, utf8ByteLength, type Inventory } from '../shared/model';

export type ExportEntry = { inventory: Inventory; partial: boolean };
export type ExportFormat = 'xlsx' | 'pdf' | 'csv' | 'json';

export function inventoriesJson(entries: ExportEntry[]): string {
  const text = JSON.stringify({ application: 'YtechInvent', schemaVersion: 1, exportedAt: new Date().toISOString(), inventories: entries });
  parseInventoryBackup(text);
  return text;
}

export function parseInventoryBackup(text: string): ExportEntry[] {
  if (utf8ByteLength(text) > 32 * 1024 * 1024) throw new Error('O arquivo de backup excede 32 MB.');
  const schema = z.object({
    application: z.literal('YtechInvent'), schemaVersion: z.literal(1), exportedAt: z.iso.datetime(),
    inventories: z.array(z.object({ inventory: inventorySchema, partial: z.boolean() }).strict()).min(1).max(1000),
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

export function inventoriesCsv(entries: ExportEntry[]): string {
  const rows: unknown[][] = [[
    'inventoryId', 'creationDate', 'inventoryType', 'companyName', 'companyCnpj', 'title',
    'partial', 'partNumber', 'serialNumber', 'patrimonyNumber', 'location', 'quantity', 'capturedAt',
  ]];
  for (const { inventory: inv, partial } of entries) {
    for (const item of inv.items) rows.push([
      inv.id, inv.startedAt, inv.organization?.kind ?? '', inv.organization?.name ?? '',
      inv.organization ? formatCnpj(inv.organization.cnpj) : '', inv.title, partial ? 'SIM' : 'NÃO',
      item.pn, item.ns, item.patrimony ?? '', item.location, item.quantity, item.capturedAt,
    ]);
  }
  return '\ufeff' + rows.map(row => row.map(csvCell).join(',')).join('\r\n');
}

function html(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}

export function inventoriesHtml(entries: ExportEntry[]): string {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><style>
    @page { size: A4; margin: 18mm 12mm; }
    body { font-family: sans-serif; color: #16324f; font-size: 11px; }
    h1 { color: #2457db; font-size: 23px; } h2 { font-size: 17px; }
    section + section { break-before: page; } p { margin: 5px 0; overflow-wrap: anywhere; }
    table { width: 100%; border-collapse: collapse; table-layout: fixed; margin-top: 18px; }
    thead { display: table-header-group; } tr { break-inside: avoid; }
    th, td { text-align: left; border: 1px solid #d4dfed; padding: 7px; overflow-wrap: anywhere; }
    th { background: #edf3ff; } .partial { color: #945400; font-weight: bold; }
  </style></head><body>${entries.map(({ inventory: inv, partial }) => `<section>
    <h1>Ytech Soluções · Inventário</h1><h2>${html(inv.title)}</h2>
    <p class="${partial ? 'partial' : ''}">${partial ? 'PARCIAL — coleta ainda aberta' : 'Coleta concluída'}</p>
    <p><b>Tipo:</b> ${inv.organization ? (inv.organization.kind === 'internal' ? 'Interno' : 'Externo') : 'Não informado'}</p>
    <p><b>Empresa inventariada:</b> ${html(inv.organization?.name ?? 'Não informada')}</p>
    <p><b>CNPJ:</b> ${html(inv.organization ? formatCnpj(inv.organization.cnpj) : 'Não informado')}</p>
    <p><b>Localização inicial:</b> ${html(inv.location)}</p>
    <p><b>Início:</b> ${html(new Date(inv.startedAt).toLocaleString('pt-BR'))}</p>
    <p><b>${partial ? 'Cópia parcial' : 'Conclusão'}:</b> ${html(new Date(inv.completedAt).toLocaleString('pt-BR'))}</p>
    <p><b>ID:</b> ${html(inv.id)} · <b>Unidades:</b> ${inv.items.length}</p>
    <table><thead><tr><th>Part number</th><th>Número de série</th><th>Patrimônio</th><th>Localização</th></tr></thead><tbody>
    ${inv.items.map(item => `<tr><td>${html(item.pn)}</td><td>${html(item.ns)}</td><td>${html(item.patrimony)}</td><td>${html(item.location)}</td></tr>`).join('')}
    </tbody></table><p>Exportação para conferência. Consulte as pendências na planilha antes de importar no TOTVS.</p>
  </section>`).join('')}</body></html>`;
}
