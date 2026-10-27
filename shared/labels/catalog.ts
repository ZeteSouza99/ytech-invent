import { normalizeCode } from '../model';
import { skeleton, withinOneEdit } from './values';

export type CatalogMatch = { value: string; kind: 'exact' | 'lookalike' | 'edit' };

export type CatalogIndex = {
  // Known part number: in the catalog or already counted.
  has(pn: string): boolean;
  // Long alphanumeric part numbers are distinctive; short numeric ones need a printed label.
  strong(pn: string): boolean;
  // Already counted by this account. Reading one again needs no further confirmation.
  seen(pn: string): boolean;
  // Adds a part number counted during this reading session.
  remember(pn: string): void;
  match(text: string): CatalogMatch | null;
};

export function createCatalogIndex(partNumbers: Iterable<string>, counted: Iterable<string> = []): CatalogIndex {
  const values = new Set<string>();
  const counts = new Set<string>();
  const bySkeleton = new Map<string, string[]>();
  const add = (partNumber: string) => {
    const value = normalizeCode(partNumber);
    if (!value || values.has(value)) return value;
    values.add(value);
    const key = skeleton(value);
    bySkeleton.set(key, [...(bySkeleton.get(key) ?? []), value]);
    return value;
  };
  const remember = (partNumber: string) => {
    const value = add(partNumber);
    if (value) counts.add(value);
  };
  for (const partNumber of partNumbers) add(partNumber);
  for (const partNumber of counted) remember(partNumber);
  return {
    has: partNumber => values.has(normalizeCode(partNumber)),
    strong(partNumber) {
      const value = normalizeCode(partNumber);
      return values.has(value) && value.length >= 6 && /[A-Z]/.test(value) && /\d/.test(value);
    },
    seen: partNumber => counts.has(normalizeCode(partNumber)),
    remember,
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
