import { formatCnpj } from './company';
import type { Inventory } from './model';

export type ReportEntry = { inventory: Inventory; partial: boolean };
export type Describe = (pn: string) => string;

// The same columns in the Excel sheet, the CSV and the PDF, in this order.
export const REPORT_COLUMNS = ['Empresa', 'CNPJ', 'Inventário', 'PN', 'Descrição', 'NS', 'Quantidade', 'Patrimônio', 'Localização', 'Data da leitura'] as const;

export type ReportRow = {
  company: string; cnpj: string; inventory: string; pn: string; description: string; ns: string;
  quantity: number; patrimony: string; location: string; capturedAt: string;
};
export type QuantityRow = { inventory: string; company: string; pn: string; description: string; quantity: number };

export function describeFrom(products: readonly { pn: string; description: string }[] | undefined): Describe {
  const descriptions = new Map(products?.map(product => [product.pn, product.description]) ?? []);
  return pn => descriptions.get(pn) ?? '';
}

// One row per unit, in the order the units were counted.
export function reportRows(entries: readonly ReportEntry[], describe: Describe): ReportRow[] {
  return entries.flatMap(({ inventory }) => {
    const company = inventory.organization?.name ?? '';
    const cnpj = inventory.organization ? formatCnpj(inventory.organization.cnpj) : '';
    return [...inventory.items]
      .sort((left, right) => Date.parse(left.capturedAt) - Date.parse(right.capturedAt))
      .map(item => ({
        company, cnpj, inventory: inventory.title, pn: item.pn, description: describe(item.pn), ns: item.ns,
        quantity: item.quantity, patrimony: item.patrimony ?? '', location: item.location, capturedAt: item.capturedAt,
      }));
  });
}

// Quantity of each part number in each inventory, in part number order.
export function quantityByPn(entries: readonly ReportEntry[], describe: Describe): QuantityRow[] {
  return entries.flatMap(({ inventory }) => {
    const counts = new Map<string, number>();
    for (const item of inventory.items) counts.set(item.pn, (counts.get(item.pn) ?? 0) + item.quantity);
    return [...counts.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([pn, quantity]) => ({ inventory: inventory.title, company: inventory.organization?.name ?? '', pn, description: describe(pn), quantity }));
  });
}

export function reportFilename(entries: readonly ReportEntry[], extension: string): string {
  const prefix = entries.some(entry => entry.partial) ? 'Inventario_PARCIAL' : 'Inventario';
  const target = entries.length === 1 ? entries[0]!.inventory.organization?.cnpj ?? entries[0]!.inventory.id : 'todos';
  return `${prefix}_${target}.${extension}`;
}

const pad = (value: number) => String(value).padStart(2, '0');

// Reports are read in the time zone of the device that produced them.
export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// Excel stores dates without a time zone; keeping the local wall-clock time in the UTC fields shows the same time as the PDF.
export function spreadsheetDateTime(iso: string): Date {
  const date = new Date(iso);
  return new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate(), date.getHours(), date.getMinutes(), date.getSeconds()));
}
