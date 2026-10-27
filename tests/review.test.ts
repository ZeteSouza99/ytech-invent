import { describe, expect, it } from 'vitest';
import { inventoryReview } from '../src/review';
import type { Catalog, InventoryItem } from '../shared/model';

describe('revisão antes de concluir', () => {
  it('conta unidades, PNs distintos, localizações, PN fora do catálogo e digitação manual', () => {
    const catalog: Catalog = {
      version: 'v1', locations: ['A'], warnings: [], products: [{ pn: 'KNOWN', code: '1', description: 'Produto' }],
    };
    const items = [
      { pn: 'KNOWN', location: 'A', source: 'barcode' },
      { pn: 'KNOWN', location: 'A', source: 'manual' },
      { pn: 'NEW', location: 'B', source: 'manual' },
      { pn: 'NEW', location: 'B', source: 'ocr' },
    ] as InventoryItem[];
    expect(inventoryReview(items, catalog)).toEqual({ units: 4, products: 2, locations: 2, unknown: ['NEW'], manual: 2 });
    expect(inventoryReview(items, null).unknown).toEqual(['KNOWN', 'NEW']);
  });
});
