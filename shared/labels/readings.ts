import { codeSchema, partNumberSchema } from '../model';
import { RANK, type Box, type Confidence, type Evidence, type LabelField, type Reading } from './types';
import { editDistance } from './values';
import type { CatalogIndex } from './catalog';

// OCR-only readings one or two characters away from a barcode-confirmed value of the same field are misreads of it.
export function shadowedBy(reading: Reading, exact: readonly Reading[]): boolean {
  return reading.confidence !== 'alta' && !reading.evidence.includes('codigo') && exact.some(other =>
    other.field === reading.field && other.value !== reading.value && editDistance(other.value, reading.value, 2) <= 2);
}

export function barcodeConfirmed(reading: Reading): boolean {
  return reading.confidence === 'alta' && reading.evidence.includes('codigo');
}

function confidenceOf(field: LabelField, evidence: readonly Evidence[], strongCatalog: boolean): Confidence {
  const has = (item: Evidence) => evidence.includes(item);
  if (has('fixado')) return 'alta';
  if (field === 'pn') {
    // A part number already counted needs no second photo once identified by its barcode, a labeled text or a
    // distinctive text. An approximate match may be a sibling model (ZT41142 and ZT41143) or a misreading saved
    // earlier, and digits the catalog refused to correct may belong to another part number: both are compared with the label.
    if (has('historico') && !has('catalogo-aproximado') && !has('digitos-corrigidos') && (has('codigo') || has('rotulo') || strongCatalog)) return 'alta';
    if (has('codigo') && (has('identificador') || has('rotulo') || (has('catalogo') && strongCatalog))) return 'alta';
    if (has('texto') && has('catalogo') && (has('rotulo') || strongCatalog)) return 'alta';
    if (has('texto') && has('rotulo') && has('catalogo-aproximado')) return 'media';
    if (has('codigo') || (has('texto') && has('rotulo'))) return 'media';
    return 'baixa';
  }
  if (has('codigo') && (has('identificador') || has('rotulo') || has('padrao'))) {
    return has('identificador') && !has('padrao') && !has('rotulo') ? 'media' : 'alta';
  }
  if (has('codigo')) return 'media';
  if (has('texto') && has('rotulo') && has('padrao') && !has('digitos-corrigidos')) return 'media';
  return 'baixa';
}

export function makeReading(
  field: LabelField, value: string, raw: string, source: Reading['source'], evidence: Evidence[],
  catalog: CatalogIndex, box?: Box,
): Reading | null {
  const parsed = (field === 'pn' ? partNumberSchema : codeSchema).safeParse(value);
  if (!parsed.success) return null;
  const unique = [...new Set([...evidence, ...(field === 'pn' && catalog.seen(parsed.data) ? ['historico' as const] : [])])];
  const confidence = confidenceOf(field, unique, field === 'pn' && catalog.strong(parsed.data));
  return { field, value: parsed.data, raw: raw.slice(0, 2048), source, evidence: unique, confidence, ...(box ? { box } : {}) };
}

export function mergeInto(map: Map<string, Reading>, reading: Reading, catalog: CatalogIndex) {
  const key = `${reading.field}|${reading.value}`;
  const previous = map.get(key);
  if (!previous) {
    map.set(key, reading);
    return;
  }
  const evidence = [...new Set([...previous.evidence, ...reading.evidence])];
  const preferred = previous.source === 'barcode' ? previous : reading;
  const merged = makeReading(reading.field, reading.value, preferred.raw, preferred.source, evidence, catalog, preferred.box ?? previous.box);
  if (merged && RANK[merged.confidence] < Math.max(RANK[previous.confidence], RANK[reading.confidence])) {
    merged.confidence = RANK[previous.confidence] >= RANK[reading.confidence] ? previous.confidence : reading.confidence;
  }
  if (merged) map.set(key, merged);
}
