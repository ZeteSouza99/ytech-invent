import { normalizeCode } from '../model';
import { skeleton, withinOneEdit } from './values';

export type CatalogMatch = { value: string; kind: 'exact' | 'lookalike' | 'edit' };

export type CatalogIndex = {
  has(pn: string): boolean;
  // Long alphanumeric part numbers are distinctive; short numeric ones need a printed label.
  strong(pn: string): boolean;
  match(text: string): CatalogMatch | null;
};

export function createCatalogIndex(partNumbers: Iterable<string>): CatalogIndex {
  const values = new Set<string>();
  const bySkeleton = new Map<string, string[]>();
  for (const partNumber of partNumbers) {
    const value = normalizeCode(partNumber);
    if (!value || values.has(value)) continue;
    values.add(value);
    const key = skeleton(value);
    bySkeleton.set(key, [...(bySkeleton.get(key) ?? []), value]);
  }
  return {
    has: partNumber => values.has(normalizeCode(partNumber)),
    strong(partNumber) {
      const value = normalizeCode(partNumber);
      return values.has(value) && value.length >= 6 && /[A-Z]/.test(value) && /\d/.test(value);
    },
    match(text) {
      const value = normalizeCode(text);
      if (values.has(value)) return { value, kind: 'exact' };
      const key = skeleton(value);
      if (key.length < 6) return null;
      const same = bySkeleton.get(key);
      if (same) return same.length === 1 ? { value: same[0]!, kind: 'lookalike' } : null;
      if (key.length < 10) return null;
      let found: string | null = null;
      for (const [candidate, partNumbersWithKey] of bySkeleton) {
        if (!withinOneEdit(candidate, key)) continue;
        // Two catalog entries one character apart: refuse to guess.
        if (found !== null || partNumbersWithKey.length !== 1) return null;
        found = partNumbersWithKey[0]!;
      }
      return found ? { value: found, kind: 'edit' } : null;
    },
  };
}

export function matchingProducts<T extends { pn: string; description: string }>(products: T[], query: string): T[] {
  const term = normalizeCode(query);
  if (!term) return [];
  return products.filter(product => product.pn.includes(term) || product.description.toUpperCase().includes(term)).slice(0, 12);
}
