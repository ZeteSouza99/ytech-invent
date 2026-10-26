import { codeSchema, normalizeCode, partNumberSchema } from './model';

export type Box = { x: number; y: number; width: number; height: number };
export type BarcodeRead = { value: string; format?: string; box?: Box };
export type TextLineRead = { text: string; box?: Box; block?: number };
export type LabelScan = { width?: number; height?: number; barcodes: BarcodeRead[]; lines: TextLineRead[] };

export type LabelField = 'pn' | 'ns';
export type Confidence = 'alta' | 'media' | 'baixa';
export type Evidence =
  | 'codigo'              // decoded barcode: exact characters, protected by the symbology checksum
  | 'identificador'       // ANSI MH10.8.2 data identifier (1P, S) or ISO 15434 field
  | 'rotulo'              // printed next to "P/N", "Part Number", "S/N", "Serial No."...
  | 'catalogo'            // exact SB1 catalog part number
  | 'catalogo-aproximado' // printed text matched to a single catalog part number
  | 'padrao'              // matches the serial layouts found on the labels
  | 'texto'               // read from printed characters (OCR)
  | 'digitos-corrigidos'  // OCR letters mapped to digits by the serial layout
  | 'fixado';             // part number kept from the previous unit

export type Reading = {
  field: LabelField;
  value: string;
  raw: string;
  source: 'barcode' | 'ocr';
  evidence: Evidence[];
  confidence: Confidence;
  box?: Box;
};

export type LabelAnalysis = {
  readings: Reading[];
  // Serial number -> part number printed on the same label, when the photo shows several units.
  pairs: { ns: string; pn: string }[];
  // Serial number of the label at the center of the photo, when it clearly stands out.
  focus?: string;
  // Different serial numbers in this photo; more than one means several labels are in view.
  serials: number;
};

const RANK: Record<Confidence, number> = { baixa: 0, media: 1, alta: 2 };
// EOT, TAB, LF, CR, FS, GS and RS separate the fields of ISO 15434 envelopes and of tab-separated PDF417.
const FIELD_SEPARATORS = new Set([4, 9, 10, 13, 28, 29, 30]);

// Layouts seen on the inventory labels: Zebra/Motorola/Extreme 14-digit serials
// (e.g. 25150523023493, 03052211308046) and Zebra printer serials (e.g. 99J242000740, T3N232800835).
const SERIAL_DIGITS = /^\d{14}$/;
const SERIAL_PRINTER = /^[A-Z0-9]{2}[A-Z]\d{9}$/;
const MAC_SEPARATED = /^(?:[0-9A-F]{2}[:-]){5}[0-9A-F]{2}$/;
const MAC_PLAIN = /^[0-9A-F]{12}$/;
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const DATE_NUMERIC = /^\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}$/;
const DATE_TEXT = /^\d{1,2}(?:JAN|FEB|FEV|MAR|APR|ABR|MAY|MAI|JUN|JUL|AUG|AGO|SEP|SET|OCT|OUT|NOV|DEC|DEZ)\d{2,4}$/;
// Other ANSI MH10.8.2 identifiers printed on the same boxes: revision, country, lot, quantity, date.
const OTHER_IDENTIFIER = /^(?:2P[A-Z0-9]{1,4}|4L[A-Z]{2}|1T[A-Z0-9]+|Q\d{1,6}|D\d{6,8}|1?0D\d{4,8}|9D\d{4,8})$/;

const DIGIT_LOOKALIKES: Record<string, string> = { O: '0', Q: '0', D: '0', I: '1', L: '1', '|': '1', Z: '2', S: '5', B: '8', G: '6' };

export function strongSerial(value: string): boolean {
  return SERIAL_DIGITS.test(value) || SERIAL_PRINTER.test(value);
}

function digitCount(value: string): number {
  let count = 0;
  for (const character of value) if (character >= '0' && character <= '9') count += 1;
  return count;
}

function genericSerial(value: string): boolean {
  return /^[A-Z0-9]{8,24}$/.test(value) && digitCount(value) >= 5 && !(MAC_PLAIN.test(value) && /[A-F]/.test(value));
}

function excludedValue(value: string): boolean {
  return MAC_SEPARATED.test(value) || (MAC_PLAIN.test(value) && /[A-F]/.test(value)) || IPV4.test(value) ||
    DATE_NUMERIC.test(value) || DATE_TEXT.test(value) || /^\d{1,4}$/.test(value) || /^[A-Z ]+$/.test(value) ||
    /^HTTPS?:/.test(value);
}

function looksLikePartNumber(value: string): boolean {
  return value.length >= 5 && value.length <= 40 && value.includes('-') && /[A-Z]/.test(value) && /\d/.test(value) &&
    !excludedValue(value) && partNumberSchema.safeParse(value).success;
}

// Characters OCR confuses are collapsed so "MC3401-OG1R64SS-A6" finds "MC3401-0G1R64SS-A6".
export function skeleton(value: string): string {
  let result = '';
  for (const character of normalizeCode(value)) {
    if (' -_.'.includes(character)) continue;
    result += DIGIT_LOOKALIKES[character] ?? character;
  }
  return result;
}

function withinOneEdit(left: string, right: string): boolean {
  if (left === right) return true;
  if (Math.abs(left.length - right.length) > 1) return false;
  const [shorter, longer] = left.length <= right.length ? [left, right] : [right, left];
  let index = 0;
  while (index < shorter.length && shorter[index] === longer[index]) index += 1;
  return shorter.length === longer.length
    ? shorter.slice(index + 1) === longer.slice(index + 1)
    : shorter.slice(index) === longer.slice(index + 1);
}

// Edit distance, giving up above `limit`: tells an OCR misread ("…778") from the exact barcode value ("…776").
function editDistance(left: string, right: string, limit: number): number {
  if (Math.abs(left.length - right.length) > limit) return limit + 1;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= right.length; column += 1) {
      const cost = left[row - 1] === right[column - 1] ? 0 : 1;
      current.push(Math.min(previous[column]! + 1, current[column - 1]! + 1, previous[column - 1]! + cost));
    }
    if (Math.min(...current) > limit) return limit + 1;
    previous = current;
  }
  return previous[right.length]!;
}

// A barcode and its human-readable text are printed together, side by side or one above the other.
function adjacent(text?: Box, code?: Box): boolean {
  if (!text || !code) return false;
  const height = Math.max(text.height, 1);
  const vertical = Math.max(code.y - (text.y + text.height), text.y - (code.y + code.height), 0);
  const horizontal = Math.max(code.x - (text.x + text.width), text.x - (code.x + code.width), 0);
  return vertical <= height * 4 && horizontal <= height * 2;
}

// OCR-only readings one or two characters away from a barcode-confirmed value of the same field are misreads of it.
function shadowedBy(reading: Reading, exact: readonly Reading[]): boolean {
  return reading.confidence !== 'alta' && !reading.evidence.includes('codigo') && exact.some(other =>
    other.field === reading.field && other.value !== reading.value && editDistance(other.value, reading.value, 2) <= 2);
}

function barcodeConfirmed(reading: Reading): boolean {
  return reading.confidence === 'alta' && reading.evidence.includes('codigo');
}

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

function confidenceOf(field: LabelField, evidence: readonly Evidence[], strongCatalog: boolean): Confidence {
  const has = (item: Evidence) => evidence.includes(item);
  if (has('fixado')) return 'alta';
  if (field === 'pn') {
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

function makeReading(
  field: LabelField, value: string, raw: string, source: Reading['source'], evidence: Evidence[],
  catalog: CatalogIndex, box?: Box,
): Reading | null {
  const parsed = (field === 'pn' ? partNumberSchema : codeSchema).safeParse(value);
  if (!parsed.success) return null;
  const unique = [...new Set(evidence)];
  const confidence = confidenceOf(field, unique, field === 'pn' && catalog.strong(parsed.data));
  return { field, value: parsed.data, raw: raw.slice(0, 2048), source, evidence: unique, confidence, ...(box ? { box } : {}) };
}

function printable(value: string): string {
  let result = '';
  for (const character of value) {
    const code = character.charCodeAt(0);
    result += code < 32 || code === 127 ? ' ' : character;
  }
  return result;
}

function splitFields(value: string): string[] {
  const fields: string[] = [];
  let current = '';
  for (const character of value) {
    if (!FIELD_SEPARATORS.has(character.charCodeAt(0))) {
      current += character;
      continue;
    }
    if (current) fields.push(current);
    current = '';
  }
  if (current) fields.push(current);
  return fields;
}

type BarcodeFields = { envelope?: string; fields: string[] };

// "[)>" RS "06" GS "1PMS4717-LU000R" GS "S22194520101338" RS EOT, or "1PMS4717-LU000R" TAB "TW" TAB "S22194520101338".
function barcodeFields(raw: string): BarcodeFields | null {
  if (raw.startsWith('[)>')) {
    const [envelope, ...fields] = splitFields(raw.slice(3));
    return { ...(envelope ? { envelope } : {}), fields };
  }
  const fields = splitFields(raw);
  return fields.length > 1 ? { fields } : null;
}

// GS1 element strings (ISO 15434 format 05). Zebra printers put the serial number at the end of the
// GIAI, AI 8004: "8004" + "663056" + "99J242000740". AI 21 is the GS1 serial number.
function gs1Serial(field: string): string | null {
  let rest = field;
  for (;;) {
    if (/^0[12]\d{14}/.test(rest)) rest = rest.slice(16);
    else if (/^1[1-7]\d{6}/.test(rest)) rest = rest.slice(8);
    else break;
  }
  if (rest.startsWith('8004')) {
    const tail = rest.slice(-12);
    return rest.length > 16 && SERIAL_PRINTER.test(tail) ? tail : null;
  }
  return rest.startsWith('21') && rest.length > 2 ? rest.slice(2) : null;
}

function fieldReadings({ envelope, fields }: BarcodeFields, raw: string, catalog: CatalogIndex, box?: Box): Reading[] {
  const pn = (value: string) => makeReading('pn', value, raw, 'barcode',
    ['codigo', 'identificador', ...(catalog.has(value) ? ['catalogo' as const] : [])], catalog, box);
  const ns = (value: string) => makeReading('ns', value, raw, 'barcode',
    ['codigo', 'identificador', ...(strongSerial(value) ? ['padrao' as const] : [])], catalog, box);
  // Inside an envelope every field carries an identifier; plain tab-separated fields need stronger signs.
  const enveloped = envelope !== undefined;
  const readings: Reading[] = [];
  for (const field of fields) {
    const value = normalizeCode(printable(field));
    let reading: Reading | null = null;
    if (envelope === '05') {
      const serial = gs1Serial(value);
      if (serial) reading = ns(serial);
    } else if (value.startsWith('1P')) reading = pn(value.slice(2));
    else if (/^P[A-Z0-9]/.test(value) && !value.startsWith('PN') && (enveloped || catalog.has(value.slice(1)))) reading = pn(value.slice(1));
    else if (/^S[A-Z0-9]/.test(value) && (enveloped || strongSerial(value.slice(1)) || genericSerial(value.slice(1)))) reading = ns(value.slice(1));
    else if (!enveloped && catalog.has(value)) reading = makeReading('pn', value, raw, 'barcode', ['codigo', 'catalogo'], catalog, box);
    else if (!enveloped && strongSerial(value)) reading = makeReading('ns', value, raw, 'barcode', ['codigo', 'padrao'], catalog, box);
    if (reading) readings.push(reading);
  }
  return readings;
}

// Classifies one decoded barcode. Only part numbers and serial numbers are kept;
// MAC, IP, dates, quantities, revisions and countries are discarded.
export function classifyBarcode(read: BarcodeRead, catalog: CatalogIndex): Reading[] {
  const raw = read.value;
  if (!raw || raw.length > 2048) return [];
  const multiple = barcodeFields(raw);
  if (multiple) return fieldReadings(multiple, raw, catalog, read.box);
  const value = normalizeCode(printable(raw));
  if (!value) return [];
  const pn = (text: string, evidence: Evidence[]) => makeReading('pn', text, raw, 'barcode', ['codigo', ...evidence], catalog, read.box);
  const ns = (text: string, evidence: Evidence[]) => makeReading('ns', text, raw, 'barcode', ['codigo', ...evidence], catalog, read.box);
  let result: Reading | null = null;
  if (catalog.has(value)) result = pn(value, ['catalogo']);
  else if (strongSerial(value)) result = ns(value, ['padrao']);
  else if (value.startsWith('1P') && partNumberSchema.safeParse(value.slice(2)).success) {
    result = pn(value.slice(2), ['identificador', ...(catalog.has(value.slice(2)) ? ['catalogo' as const] : [])]);
  } else if (value.startsWith('P') && catalog.has(value.slice(1))) result = pn(value.slice(1), ['identificador', 'catalogo']);
  else if (value.startsWith('S') && (strongSerial(value.slice(1)) || genericSerial(value.slice(1)))) {
    result = ns(value.slice(1), ['identificador', ...(strongSerial(value.slice(1)) ? ['padrao' as const] : [])]);
  } else if (OTHER_IDENTIFIER.test(value) || excludedValue(value)) result = null;
  else if (looksLikePartNumber(value)) result = pn(value, ['padrao']);
  else if (genericSerial(value)) result = ns(value, []);
  return result ? [result] : [];
}

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

function center(box: Box) {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

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
    if (match?.kind === 'edit') {
      approximate ??= makeReading('pn', match.value, raw, 'ocr', ['texto', 'rotulo', 'catalogo-aproximado'], catalog, box);
    } else if (match) {
      // A unique catalog entry differing only by look-alike characters (O/0, S/5...) is the same part number.
      return makeReading('pn', match.value, raw, 'ocr', ['texto', 'rotulo', 'catalogo'], catalog, box);
    }
  }
  // The exact code printed beside a misread text beats a catalog entry one character away.
  for (let size = Math.min(tokens.length, 4); size >= 1; size -= 1) {
    const near = misreadOf(tokens.slice(0, size).join(''), decoded, box, partNumberCode);
    if (near) return fromCode(near);
  }
  if (approximate) return approximate;
  const first = tokens[0];
  if (first && first.length >= 5 && /[A-Z]/.test(first) && /\d/.test(first) && !excludedValue(first)) {
    const value = zeroRuns(first);
    return makeReading('pn', value, raw, 'ocr', ['texto', 'rotulo', ...(value !== first ? ['digitos-corrigidos' as const] : [])], catalog, box);
  }
  return null;
}

// OCR reads zeros inside digit runs as the letter O ("SRO0004ZZWW"). Only used for part numbers
// outside the catalog; the only catalog part number with O next to a digit (TC51OK) matches the catalog first.
function zeroRuns(value: string): string {
  return value.replace(/[0-9O]{2,}/g, run => (/\d/.test(run) ? run.replace(/O/g, '0') : run));
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

function mergeInto(map: Map<string, Reading>, reading: Reading, catalog: CatalogIndex) {
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

function pairsOf(readings: Reading[]): { ns: string; pn: string }[] {
  const partNumbers = readings.filter(reading => reading.field === 'pn' && reading.box && reading.confidence !== 'baixa');
  const pairs: { ns: string; pn: string }[] = [];
  for (const serial of readings) {
    if (serial.field !== 'ns' || !serial.box) continue;
    const position = center(serial.box);
    let best: { pn: string; cost: number } | null = null;
    for (const partNumber of partNumbers) {
      const other = center(partNumber.box!);
      const dy = position.y - other.y;
      // On every label seen, the part number is printed above or beside its serial number.
      const cost = Math.abs(position.x - other.x) * 0.3 + (dy >= -serial.box.height ? Math.abs(dy) : Math.abs(dy) * 4);
      if (!best || cost < best.cost) best = { pn: partNumber.value, cost };
    }
    if (best) pairs.push({ ns: serial.value, pn: best.pn });
  }
  return pairs;
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

  lines.forEach((line, index) => {
    for (const region of valueRegions(line)) {
      if (region.kind === 'other') continue;
      let tokens = tokensOf(region.text);
      let reading = region.kind === 'pn'
        ? pnFromTokens(tokens, line.text, catalog, decoded, line.box)
        : nsFromTokens(tokens, line.text, catalog, decoded, line.box);
      if (!reading) {
        for (const neighbour of neighbourLines(lines, index)) {
          if (neighbour.hits.some(hit => hit.kind !== 'other' && hit.start === 0)) break;
          if (neighbour.hits.length && neighbour.hits[0]!.start === 0) continue;
          tokens = tokensOf(unlabeledText(neighbour));
          reading = region.kind === 'pn'
            ? pnFromTokens(tokens, neighbour.text, catalog, decoded, neighbour.box)
            : nsFromTokens(tokens, neighbour.text, catalog, decoded, neighbour.box);
          if (reading) break;
        }
      }
      if (reading) {
        if (reading.source === 'barcode') claimed.add(reading.value);
        mergeInto(readings, reading, catalog);
      }
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

  const all = [...readings.values()];
  const exact = all.filter(barcodeConfirmed);
  const list = all.filter(reading => !shadowedBy(reading, exact));
  const serials = new Set(list.filter(reading => reading.field === 'ns' && reading.confidence !== 'baixa').map(reading => reading.value)).size;
  const focus = focusOf(list, scan.width, scan.height);
  return { readings: list, pairs: pairsOf(list), serials, ...(focus ? { focus } : {}) };
}

type Entry = { reading: Reading; frames: Set<number>; last: number };

export type Decision =
  | { status: 'searching'; pn?: Reading; ns?: Reading; hint: string }
  | { status: 'ready'; pn: Reading; ns: Reading }
  | { status: 'multiple'; options: { pn?: Reading; ns: Reading }[] };

const RECENT_FRAMES = 3;

// Accumulates readings over consecutive photos of the same label.
export class ReadingPool {
  private frame = 0;
  private entries = new Map<string, Entry>();
  private pairs = new Map<string, string>();
  private focus: string | undefined;
  private latestSerials = 0;

  addFrame(analysis: LabelAnalysis): void {
    this.frame += 1;
    for (const reading of analysis.readings) this.merge(reading);
    for (const pair of analysis.pairs) this.pairs.set(pair.ns, pair.pn);
    this.focus = analysis.focus;
    this.latestSerials = analysis.serials;
  }

  addLive(readings: Reading[]): void {
    for (const reading of readings) this.merge(reading);
  }

  reset(): void {
    this.frame = 0;
    this.entries.clear();
    this.pairs.clear();
    this.focus = undefined;
    this.latestSerials = 0;
  }

  private merge(reading: Reading): void {
    const key = `${reading.field}|${reading.value}`;
    const entry = this.entries.get(key);
    if (!entry) {
      this.entries.set(key, { reading, frames: new Set([this.frame]), last: this.frame });
      return;
    }
    entry.frames.add(this.frame);
    entry.last = this.frame;
    const evidence = [...new Set([...entry.reading.evidence, ...reading.evidence])];
    const confidence = RANK[reading.confidence] > RANK[entry.reading.confidence] ? reading.confidence : entry.reading.confidence;
    const preferred = entry.reading.source === 'barcode' ? entry.reading : reading;
    entry.reading = { ...preferred, evidence, confidence, ...(reading.box ? { box: reading.box } : {}) };
  }

  // A reading counts when it is certain, or when a probable reading repeats in another photo.
  private acceptable(entry: Entry): boolean {
    return entry.reading.confidence === 'alta' || (entry.reading.confidence === 'media' && entry.frames.size >= 2);
  }

  confirmations(field: LabelField, value: string): number {
    return this.entries.get(`${field}|${value}`)?.frames.size ?? 0;
  }

  decide(options: { lockedPn?: string | null; savedSerials: ReadonlySet<string> }): Decision {
    const recent = [...this.entries.values()].filter(entry => entry.last >= this.frame - (RECENT_FRAMES - 1));
    const order = (left: Entry, right: Entry) =>
      RANK[right.reading.confidence] - RANK[left.reading.confidence] || right.frames.size - left.frames.size || right.last - left.last;
    // A misread in one photo ("…778") of a value another photo confirmed by barcode ("…776") is not another unit.
    const exact = recent.map(entry => entry.reading).filter(barcodeConfirmed);
    const visible = recent.filter(entry => !shadowedBy(entry.reading, exact));
    const serials = visible.filter(entry => entry.reading.field === 'ns').sort(order);
    const partNumbers = visible.filter(entry => entry.reading.field === 'pn').sort(order);
    const accepted = serials.filter(entry => this.acceptable(entry));
    const unsaved = serials.filter(entry => !options.savedSerials.has(entry.reading.value));
    // Serial numbers still on their way to confirmation may be the unit being counted.
    const candidates = unsaved.filter(entry => entry.reading.confidence !== 'baixa');
    const fresh = candidates.filter(entry => this.acceptable(entry));
    const acceptedPns = partNumbers.filter(entry => this.acceptable(entry));
    const lockedPn = options.lockedPn ? normalizeCode(options.lockedPn) : null;
    const multiple = (entries: Entry[]): Decision => ({
      status: 'multiple',
      options: entries.map(entry => {
        const paired = this.pairs.get(entry.reading.value);
        const pn = lockedPn ? undefined : acceptedPns.find(item => item.reading.value === paired)?.reading;
        return { ns: entry.reading, ...(pn ? { pn } : {}) };
      }),
    });

    let serial: Entry | undefined;
    let crowded = false;
    const focused = this.focus ? candidates.find(entry => entry.reading.value === this.focus) : undefined;
    if (focused) {
      // The label being aimed at wins, but only once its own reading is confirmed.
      if (this.acceptable(focused)) serial = focused;
    } else if (this.latestSerials > 1) {
      // Several labels in the latest photo: ask, or wait until the others are confirmed too.
      if (fresh.length > 1) return multiple(fresh);
      if (fresh.length === 1) {
        if (candidates.length === 1) serial = fresh[0];
        else crowded = true;
      }
    } else {
      // A single label in view: the serial read in the latest photo is the unit being counted.
      const current = fresh.filter(entry => entry.last === this.frame);
      if (current.length === 1) serial = current[0];
      else if (fresh.length === 1) serial = fresh[0];
      else if (fresh.length > 1) return multiple(fresh);
    }

    const shownNs = (serial ?? focused ?? candidates[0] ?? unsaved[0])?.reading;
    if (!serial && candidates.length === 0 && accepted.length > 0) {
      return { status: 'searching', hint: `NS ${accepted[0]!.reading.value} já foi contado. Aponte para o próximo equipamento.`, ...(partNumbers[0] ? { pn: partNumbers[0].reading } : {}) };
    }

    let partNumber: Reading | undefined;
    if (lockedPn) {
      const paired = serial ? this.pairs.get(serial.reading.value) : undefined;
      const conflicting = acceptedPns.find(entry => entry.reading.value !== lockedPn && entry.reading.confidence === 'alta' &&
        (!paired || paired === entry.reading.value));
      if (conflicting) {
        return {
          status: 'searching', pn: conflicting.reading, ...(shownNs ? { ns: shownNs } : {}),
          hint: `O PN desta etiqueta (${conflicting.reading.value}) é diferente do PN mantido (${lockedPn}). Desmarque "Manter PN" para salvar este equipamento.`,
        };
      }
      partNumber = { field: 'pn', value: lockedPn, raw: lockedPn, source: 'ocr', evidence: ['fixado'], confidence: 'alta' };
    } else {
      const paired = serial ? this.pairs.get(serial.reading.value) : undefined;
      const pairedEntry = paired ? acceptedPns.find(entry => entry.reading.value === paired) : undefined;
      const distinct = new Set(acceptedPns.map(entry => entry.reading.value));
      if (pairedEntry) partNumber = pairedEntry.reading;
      else if (distinct.size === 1) partNumber = acceptedPns[0]!.reading;
      else if (distinct.size > 1 && serial) {
        return { status: 'multiple', options: acceptedPns.map(entry => ({ pn: entry.reading, ns: serial!.reading })) };
      }
    }

    if (serial && partNumber) return { status: 'ready', pn: partNumber, ns: serial.reading };
    // While confirming, show the part number printed with the serial being shown, not another unit's.
    const pairedWithShown = shownNs ? this.pairs.get(shownNs.value) : undefined;
    const pairedPn = partNumbers.find(entry => entry.reading.value === pairedWithShown)?.reading;
    const shownPn = (lockedPn || serial ? partNumber : undefined) ?? pairedPn ?? partNumber ?? partNumbers[0]?.reading;
    const confirming = (reading?: Reading) => reading !== undefined && reading.confidence !== 'baixa';
    const hint = !shownPn && !shownNs ? 'Centralize a etiqueta com o PN e o NS do equipamento.'
      : crowded ? 'Há mais de um NS na imagem. Centralize só a etiqueta do equipamento que está contando.'
        : !serial ? (confirming(shownNs) ? 'Confirmando o NS… mantenha a etiqueta enquadrada.' : 'Procurando o NS… aproxime do número de série.')
          : !partNumbers.length && this.frame >= 3
            ? 'Esta etiqueta não mostra o PN. Toque em "Digitar ou corrigir" para escolher o PN no catálogo, ou aponte para outra etiqueta do equipamento.'
            : confirming(shownPn) ? 'Confirmando o PN… mantenha a etiqueta enquadrada.'
              : 'Procurando o PN… aproxime do texto "P/N" ou do código do PN.';
    return { status: 'searching', hint, ...(shownPn ? { pn: shownPn } : {}), ...(shownNs ? { ns: shownNs } : {}) };
  }
}

export function matchingProducts<T extends { pn: string; description: string }>(products: T[], query: string): T[] {
  const term = normalizeCode(query);
  if (!term) return [];
  return products.filter(product => product.pn.includes(term) || product.description.toUpperCase().includes(term)).slice(0, 12);
}
