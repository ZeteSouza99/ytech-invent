import type { Catalog, InventoryItem } from '../shared/model';

export function inventoryReview(items: readonly InventoryItem[], catalog: Catalog | null) {
  const products = new Map(catalog?.products.map(product => [product.pn, product]) ?? []);
  const addresses = new Set(catalog?.locations ?? []);
  const pns = new Set(items.map(item => item.pn));
  return {
    units: items.length,
    products: pns.size,
    locations: new Set(items.map(item => item.location)).size,
    unknown: [...pns].filter(pn => !products.has(pn)),
    pending: [...pns].filter(pn => !!products.get(pn)?.issues.length),
    otherLocations: [...new Set(items.filter(item => !addresses.has(item.location)).map(item => item.location))],
    manual: items.filter(item => item.source === 'manual').length,
  };
}
