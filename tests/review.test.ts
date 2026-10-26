import { describe, expect, it } from 'vitest';
import { inventoryReview } from '../src/review';
import type { Catalog, InventoryItem } from '../shared/model';

describe('revisão antes de concluir', () => {
  it('conta unidades e PNs distintos, incluindo cadastro com conflito e locais livres', () => {
    const catalog: Catalog = {
      version: 'v1', locations: ['A'], warnings: [], products: [
        { pn: 'KNOWN', code: '1', description: 'Produto', issues: [] },
        { pn: 'CONFLICT', code: '', description: '', issues: ['PN ambíguo'] },
      ],
    };
    const items = [
      { pn: 'KNOWN', location: 'A', source: 'barcode' },
      { pn: 'KNOWN', location: 'A', source: 'manual' },
      { pn: 'NEW', location: 'B', source: 'manual' },
      { pn: 'NEW', location: 'B', source: 'ocr' },
      { pn: 'CONFLICT', location: 'A', source: 'barcode' },
    ] as InventoryItem[];
    expect(inventoryReview(items, catalog)).toEqual({
      units: 5, products: 3, locations: 2, unknown: ['NEW'], pending: ['CONFLICT'], otherLocations: ['B'], manual: 2,
    });
  });
});
