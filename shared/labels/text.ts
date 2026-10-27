import { normalizeCode } from '../model';
import type { BarcodeRead, Box, Evidence, LabelAnalysis, LabelField, LabelScan, Reading } from './types';
import {
  adjacent, center, DIGIT_LOOKALIKES, digitCount, editDistance, excludedValue, genericSerial, looksLikePartNumber,
  SERIAL_DIGITS, SERIAL_PRINTER, skeleton, strongSerial, zeroRuns,
} from './values';
import type { CatalogIndex } from './catalog';
import { barcodeConfirmed, makeReading, mergeInto, shadowedBy, suggestion } from './readings';
import { barcodeFields, classifyBarcode, gs1Serial, printable } from './barcode';

function cleanText(text: string): string {
  return printable(text).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase()
    .replace(/[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/g, '-')
    .replace(/\uFF1A/g, ':')
    .replace(/\s*-\s*/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/\s*\/\s*/g, '/')
    .replace(/\s+/g, ' ')
    .trim();
}

type LabelKind = LabelField | 'other';
type LabelHit = { kind: LabelKind; start: number; end: number };

const LABELS: { kind: LabelKind; pattern: RegExp }[] = [
  { kind: 'pn', pattern: /\(1P\)\s*(?:P[/I1L]N|PART\s*(?:NUMBER|NO\.?|#))?\s*[:.]?/g },
  { kind: 'pn', pattern: /(?:^|[^A-Z0-9(])(?:P\/N|P[I1L]N(?=\s*:)|PN(?=\s*:)|PART\s*(?:NUMBER|NO\.?|#)(?![A-Z0-9])|NUMERO\s+DA\s+PECA)\s*[:.]?/g },
  { kind: 'ns', pattern: /\(1?S\)\s*(?:S[/I1L]N|SN|SERIAL\s*(?:NUMBER|NO\.?)?)?\s*[:.]?/g },
  { kind: 'ns', pattern: /(?:^|[^A-Z0-9(])(?:S\/N|S[I1L]N(?=\s*:)|SN(?=\s*[:.])|SERIAL(?:\s*(?:NUMBER|NO\.?|NUM\.?|#))?(?![A-Z0-9])|NO\.?\s*DE\s*SERIE|NUMERO\s+DE\s+SERIE)\s*[:.]?/g },
  { kind: 'other', pattern: /(?:^|[^A-Z0-9])(?:BT\s*MAC|WLAN\s*MAC|MAC|WLAN|BT|BD[_ ]?ADDR|IP|MFD|MFG|DATE|DATA|QTY|QUANTITY|QUANTIDADE|REV|MODEL|MODELO|FCC\s*ID|IC|ORIGIN|UID|IMEI|ICCID|FACTORY\s*ID)(?![A-Z0-9])\s*[:.#]?/g },
];

function labelHits(text: string): LabelHit[] {
  const hits: LabelHit[] = [];
  for (const { kind, pattern } of LABELS) {
    pattern.lastIndex = 0;
    for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
      hits.push({ kind, start: match.index, end: match.index + match[0].length });
      if (match[0].length === 0) pattern.lastIndex += 1;
    }
  }
  hits.sort((left, right) => left.start - right.start || right.end - left.end);
  const merged: LabelHit[] = [];
  for (const hit of hits) {
    const previous = merged.at(-1);
    if (previous && hit.start < previous.end) {
      if (hit.kind === previous.kind || previous.kind === 'other') {
        previous.end = Math.max(previous.end, hit.end);
        if (previous.kind === 'other') previous.kind = hit.kind;
      }
      continue;
    }
    merged.push({ ...hit });
  }
  return merged;
}

function tokensOf(text: string): string[] {
  return text.split(' ')
    .map(token => token.replace(/^[:.#,;]+/, '').replace(/[.,;:]+$/, ''))
    .filter(token => token.length > 0);
}

type Line = { text: string; box?: Box; hits: LabelHit[] };

// Lines to the right of, or just below, a label whose value is not on the same line.
function neighbourLines(lines: Line[], index: number): Line[] {
  const label = lines[index]!;
  if (!label.box) return lines.slice(index + 1, index + 3);
  const box = label.box;
  const height = Math.max(box.height, 1);
  const right: { line: Line; distance: number }[] = [];
  const below: { line: Line; distance: number }[] = [];
  lines.forEach((line, position) => {
    if (position === index || !line.box) return;
    const other = line.box;
    const overlap = Math.min(box.y + box.height, other.y + other.height) - Math.max(box.y, other.y);
    if (overlap > Math.min(box.height, other.height) * 0.5 && other.x >= box.x + box.width * 0.5) {
      right.push({ line, distance: other.x - (box.x + box.width) });
      return;
    }
    const gap = other.y - (box.y + box.height);
    const horizontal = Math.min(box.x + box.width, other.x + other.width) - Math.max(box.x, other.x);
    // Barcodes are often printed between the label and its human-readable value.
    if (gap > -height * 0.3 && gap < height * 6 && horizontal > -height * 2) below.push({ line, distance: gap });
  });
  right.sort((left, other) => left.distance - other.distance);
  below.sort((left, other) => left.distance - other.distance);
  return [...right.map(item => item.line), ...below.slice(0, 3).map(item => item.line)];
}

function valueRegions(line: Line): { kind: LabelKind; text: string }[] {
  return line.hits.map((hit, index) => ({
    kind: hit.kind,
    text: line.text.slice(hit.end, line.hits[index + 1]?.start ?? line.text.length).trim(),
  }));
}

function unlabeledText(line: Line): string {
  if (!line.hits.length) return line.text;
  // Text before the first label is unlabeled; values after labels belong to those labels.
  return line.text.slice(0, line.hits[0]!.start);
}

type DecodedValue = { value: string; identifier: boolean; kind?: LabelField; read: BarcodeRead };

function decodedVariants(barcodes: BarcodeRead[]): DecodedValue[] {
  const variants: DecodedValue[] = [];
  for (const read of barcodes) {
    const multiple = barcodeFields(read.value);
    for (const field of multiple?.fields ?? [read.value]) {
      const value = normalizeCode(printable(field));
      if (!value) continue;
      variants.push({ value, identifier: false, read });
      const serial = multiple?.envelope === '05' ? gs1Serial(value) : null;
      if (serial) variants.push({ value: serial, identifier: true, kind: 'ns', read });
      else if (value.startsWith('1P')) variants.push({ value: value.slice(2), identifier: true, kind: 'pn', read });
      else if (/^[SP][A-Z0-9]/.test(value)) variants.push({ value: value.slice(1), identifier: true, kind: value.startsWith('S') ? 'ns' : 'pn', read });
    }
  }
  return variants;
}

// The barcode beside the text whose value the OCR misread by one or two characters, when there is exactly one.
function misreadOf(text: string, decoded: DecodedValue[], box: Box | undefined, fits: (item: DecodedValue) => boolean): DecodedValue | null {
  const value = text.replace(/ /g, '');
  if (value.length < 6) return null;
  const nearest = new Map<BarcodeRead, { item: DecodedValue; distance: number }>();
  for (const item of decoded) {
    if (!fits(item) || !adjacent(box, item.read.box)) continue;
    const distance = editDistance(value, item.value.replace(/ /g, ''), 2);
    const known = nearest.get(item.read);
    if (distance <= 2 && (!known || distance < known.distance)) nearest.set(item.read, { item, distance });
  }
  const matches = [...nearest.values()];
  const best = Math.min(...matches.map(match => match.distance));
  const closest = [...new Set(matches.filter(match => match.distance === best).map(match => match.item.value))];
  return closest.length === 1 ? matches.find(match => match.distance === best)!.item : null;
}

// Readings whose text was replaced by the barcode printed beside it, which may be on another label in view.
const correctedByCode = new WeakSet<Reading>();

function pnFromTokens(
  tokens: string[], raw: string, catalog: CatalogIndex, decoded: DecodedValue[], box?: Box,
): Reading | null {
  const fromCode = (barcode: DecodedValue) => makeReading('pn', barcode.value, barcode.read.value, 'barcode',
    ['codigo', 'rotulo', 'texto', ...(barcode.identifier ? ['identificador' as const] : []), ...(catalog.has(barcode.value) ? ['catalogo' as const] : [])],
    catalog, barcode.read.box ?? box);
  const partNumberCode = (item: DecodedValue) =>
    item.kind === 'pn' || (!item.kind && (catalog.has(item.value) || looksLikePartNumber(item.value)));
  let approximate: Reading | null = null;
  // Part numbers may contain spaces in the catalog ("TC200J-1KC111A6 BR"): try the longest prefix first.
  for (let size = Math.min(tokens.length, 4); size >= 1; size -= 1) {
    const text = tokens.slice(0, size).join(' ');
    const key = skeleton(text);
    const barcode = decoded.find(item => skeleton(item.value) === key);
    if (barcode && key.length >= 5) return fromCode(barcode);
    const match = catalog.match(text);
    if (match?.kind === 'approximate') {
      approximate ??= makeReading('pn', match.value, raw, 'ocr', ['texto', 'rotulo', 'catalogo-aproximado'], catalog, box);
    } else if (match) {
      // A unique catalog entry differing only by look-alike characters (O/0, S/5...), or a counted part number
      // differing only by O/0, is the same part number.
      return makeReading('pn', match.value, raw, 'ocr', ['texto', 'rotulo', 'catalogo'], catalog, box);
    }
  }
  // The exact code printed beside a misread text beats a catalog entry one character away.
  for (let size = Math.min(tokens.length, 4); size >= 1; size -= 1) {
    const near = misreadOf(tokens.slice(0, size).join(''), decoded, box, partNumberCode);
    if (!near) continue;
    const reading = fromCode(near);
    if (reading) correctedByCode.add(reading);
    return reading;
  }
  if (approximate) return approximate;
  return asPrinted(tokens, raw, catalog, box);
}

// The part number as printed, when no barcode, catalog entry or counted part number accounts for it.
function asPrinted(tokens: string[], raw: string, catalog: CatalogIndex, box?: Box): Reading | null {
  const first = tokens[0];
  if (!first || first.length < 5 || !/[A-Z]/.test(first) || !/\d/.test(first) || excludedValue(first)) return null;
  const value = zeroRuns(first);
  return makeReading('pn', value, raw, 'ocr', ['texto', 'rotulo', ...(value !== first ? ['digitos-corrigidos' as const] : [])], catalog, box);
}

function mapDigits(value: string, from: number): string {
  let result = value.slice(0, from);
  for (const character of value.slice(from)) result += DIGIT_LOOKALIKES[character] ?? character;
  return result;
}

function nsFromTokens(
  tokens: string[], raw: string, catalog: CatalogIndex, decoded: DecodedValue[], box?: Box,
): Reading | null {
  const ocr = (value: string, evidence: Evidence[]) => makeReading('ns', value, raw, 'ocr', ['texto', 'rotulo', ...evidence], catalog, box);
  const fromCode = (barcode: DecodedValue) => makeReading('ns', barcode.value, barcode.read.value, 'barcode',
    ['codigo', 'rotulo', 'texto', ...(barcode.identifier ? ['identificador' as const] : []), ...(strongSerial(barcode.value) ? ['padrao' as const] : [])],
    catalog, barcode.read.box ?? box);
  const serialCode = (item: DecodedValue) => item.kind === 'ns' || (!item.kind && strongSerial(item.value));
  const exactCode = (value: string) => {
    const key = skeleton(value);
    return key.length >= 6 ? decoded.find(item => skeleton(item.value) === key) : undefined;
  };
  // The barcode printed with the text holds the exact characters, even when the OCR misread one or two.
  const resolve = (value: string, evidence: Evidence[]) => {
    const code = exactCode(value) ?? misreadOf(value, decoded, box, serialCode);
    return code ? fromCode(code) : ocr(value, evidence);
  };
  for (const [index, token] of tokens.entries()) {
    const barcode = exactCode(token);
    if (barcode) return fromCode(barcode);
    // OCR splits long serials into groups: "241185251 00190" is 24118525100190.
    let joined = token;
    for (let next = index + 1; /^\d+$/.test(token) && next < Math.min(tokens.length, index + 4) && /^\d+$/.test(tokens[next]!); next += 1) {
      joined += tokens[next]!;
      if (SERIAL_DIGITS.test(joined)) return resolve(joined, ['padrao']);
    }
    if (excludedValue(token) || catalog.has(token)) continue;
    const near = misreadOf(token, decoded, box, serialCode);
    if (near) return fromCode(near);
    if (strongSerial(token)) return ocr(token, ['padrao']);
    // Symbols printed before the serial, e.g. "F9|52N222300499".
    const embedded = token.split(/[^A-Z0-9]+/).find(part => part !== token && strongSerial(part));
    if (embedded) return resolve(embedded, ['padrao']);
    const digits = mapDigits(token, 0);
    if (digitCount(token) >= 10 && SERIAL_DIGITS.test(digits)) return ocr(digits, ['padrao', 'digitos-corrigidos']);
    const printer = token.length === 12 ? mapDigits(token, 3) : '';
    if (printer && SERIAL_PRINTER.test(printer)) return ocr(printer, ['padrao', 'digitos-corrigidos']);
  }
  // Values without a known serial layout only after every token was checked for one.
  const generic = tokens.find(token => !excludedValue(token) && !catalog.has(token) && genericSerial(token));
  return generic ? ocr(generic, []) : null;
}

// On every label seen, the part number is printed above or beside its serial number.
function pairingCost(serial: Box, partNumber: Box): number {
  const position = center(serial);
  const other = center(partNumber);
  const dy = position.y - other.y;
  return Math.abs(position.x - other.x) * 0.3 + (dy >= -serial.height ? Math.abs(dy) : Math.abs(dy) * 4);
}

function pairsOf(readings: Reading[]): LabelAnalysis['pairs'] {
  const partNumbers = readings.filter(reading => reading.field === 'pn' && reading.box && reading.confidence !== 'baixa');
  const pairs: LabelAnalysis['pairs'] = [];
  for (const serial of readings) {
    if (serial.field !== 'ns' || !serial.box) continue;
    let best: { partNumber: Reading; cost: number } | null = null;
    for (const partNumber of partNumbers) {
      const cost = pairingCost(serial.box, partNumber.box!);
      if (!best || cost < best.cost) best = { partNumber, cost };
    }
    if (best) pairs.push({ ns: serial.value, pn: best.partNumber.value, ...(suggestion(best.partNumber) ? { suggested: true as const } : {}) });
  }
  return pairs;
}

// The serial number in view that a part number printed at `box` belongs to.
function ownerOf(box: Box, serials: Reading[]): string | undefined {
  let best: { ns: string; cost: number } | null = null;
  for (const serial of serials) {
    const cost = pairingCost(serial.box!, box);
    if (!best || cost < best.cost) best = { ns: serial.value, cost };
  }
  return best?.ns;
}

function focusOf(readings: Reading[], width?: number, height?: number): string | undefined {
  if (!width || !height) return undefined;
  const serials = readings.filter(reading => reading.field === 'ns' && reading.box && reading.confidence !== 'baixa');
  const values = new Set(serials.map(reading => reading.value));
  if (values.size < 2) return undefined;
  const distances = serials
    .map(reading => {
      const position = center(reading.box!);
      return { value: reading.value, distance: Math.hypot((position.x - width / 2) / width, (position.y - height / 2) / height) };
    })
    .sort((left, right) => left.distance - right.distance);
  const nearest = distances[0]!;
  const runnerUp = distances.find(item => item.value !== nearest.value);
  // Only pick for the user when one label is clearly the one being aimed at.
  return runnerUp && nearest.distance <= 0.35 && nearest.distance < runnerUp.distance * 0.6 ? nearest.value : undefined;
}

export function analyzeLabel(scan: LabelScan, catalog: CatalogIndex): LabelAnalysis {
  const readings = new Map<string, Reading>();
  const decoded = decodedVariants(scan.barcodes);
  const claimed = new Set<string>();
  const lines: Line[] = scan.lines.map(line => {
    const text = cleanText(line.text);
    return { text, ...(line.box ? { box: line.box } : {}), hits: labelHits(text) };
  });

  // A part number taken from another one, a suggestion ('catalogo-aproximado') or the barcode beside a misread text,
  // waits until every exact reading of the photo is known.
  const suggestions: { reading: Reading; printed: Reading | null; at?: Box }[] = [];
  lines.forEach((line, index) => {
    for (const region of valueRegions(line)) {
      if (region.kind === 'other') continue;
      let tokens = tokensOf(region.text);
      let origin = line;
      let reading = region.kind === 'pn'
        ? pnFromTokens(tokens, line.text, catalog, decoded, line.box)
        : nsFromTokens(tokens, line.text, catalog, decoded, line.box);
      if (!reading) {
        for (const neighbour of neighbourLines(lines, index)) {
          if (neighbour.hits.some(hit => hit.kind !== 'other' && hit.start === 0)) break;
          if (neighbour.hits.length && neighbour.hits[0]!.start === 0) continue;
          tokens = tokensOf(unlabeledText(neighbour));
          origin = neighbour;
          reading = region.kind === 'pn'
            ? pnFromTokens(tokens, neighbour.text, catalog, decoded, neighbour.box)
            : nsFromTokens(tokens, neighbour.text, catalog, decoded, neighbour.box);
          if (reading) break;
        }
      }
      if (!reading) continue;
      if (reading.source === 'barcode') claimed.add(reading.value);
      if (suggestion(reading) || correctedByCode.has(reading)) {
        suggestions.push({ reading, printed: asPrinted(tokens, origin.text, catalog, origin.box), ...(origin.box ? { at: origin.box } : {}) });
      } else mergeInto(readings, reading, catalog);
    }
  });

  // A barcode the printed label assigned to one field must not also count for the other.
  for (const read of scan.barcodes) {
    for (const reading of classifyBarcode(read, catalog)) {
      const otherField = reading.field === 'pn' ? 'ns' : 'pn';
      if (claimed.has(reading.value) && readings.has(`${otherField}|${reading.value}`)) continue;
      mergeInto(readings, reading, catalog);
    }
  }

  // Catalog part numbers printed without a "P/N" label, e.g. under "Part Number/Número da peça" and a barcode.
  for (const line of lines) {
    const tokens = tokensOf(unlabeledText(line));
    for (let start = 0; start < tokens.length; start += 1) {
      for (let size = Math.min(3, tokens.length - start); size >= 1; size -= 1) {
        const text = tokens.slice(start, start + size).join(' ');
        if (!catalog.strong(text)) continue;
        const reading = makeReading('pn', normalizeCode(text), line.text, 'ocr', ['texto', 'catalogo'], catalog, line.box);
        if (reading) mergeInto(readings, reading, catalog);
        break;
      }
    }
  }

  // With several units in view, text close to a part number printed on another unit's label is more likely a sibling
  // model (ZT41142 and ZT41143) than a misreading of it: keep what that label shows, so that each serial number pairs
  // with the part number of its own label.
  const known = new Map(readings);
  const confirmed = [...known.values()].filter(barcodeConfirmed);
  const inView = [...known.values()].filter(reading =>
    reading.field === 'ns' && reading.box && reading.confidence !== 'baixa' && !shadowedBy(reading, confirmed));
  for (const { reading, printed, at } of suggestions) {
    // Where the replacement is printed: the barcode itself, or an exact reading of the suggested part number.
    const source = correctedByCode.has(reading) ? reading.box : known.get(`pn|${reading.value}`)?.box;
    const elsewhere = inView.length > 1 && !!source && !!at && ownerOf(source, inView) !== ownerOf(at, inView);
    const chosen = elsewhere ? printed : reading;
    if (chosen) mergeInto(readings, chosen, catalog);
  }

  const all = [...readings.values()];
  const exact = all.filter(barcodeConfirmed);
  // A part number read only as text is a misreading of a code printed on its own unit's label, not of another unit's.
  const sameUnit = (reading: Reading, other: Reading) =>
    inView.length <= 1 || !reading.box || !other.box || ownerOf(reading.box, inView) === ownerOf(other.box, inView);
  const list = all.filter(reading =>
    !shadowedBy(reading, reading.field === 'pn' ? exact.filter(other => sameUnit(reading, other)) : exact));
  const serials = new Set(list.filter(reading => reading.field === 'ns' && reading.confidence !== 'baixa').map(reading => reading.value)).size;
  const focus = focusOf(list, scan.width, scan.height);
  return { readings: list, pairs: pairsOf(list), serials, ...(focus ? { focus } : {}) };
}
