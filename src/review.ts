import type { Catalog, InventoryItem } from '../shared/model';

export function inventoryReview(items: readonly InventoryItem[], catalog: Catalog | null) {
  const known = new Set(catalog?.products.map(product => product.pn) ?? []);
  const pns = new Set(items.map(item => item.pn));
  return {
    units: items.length,
    products: pns.size,
    locations: new Set(items.map(item => item.location)).size,
    unknown: [...pns].filter(pn => !known.has(pn)),
    manual: items.filter(item => item.source === 'manual').length,
  };
}
