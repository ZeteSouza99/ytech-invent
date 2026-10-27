import { normalizeCode, partNumberSchema } from '../model';
import type { BarcodeRead, Box, Evidence, Reading } from './types';
import { excludedValue, genericSerial, looksLikePartNumber, SERIAL_PRINTER, strongSerial } from './values';
import type { CatalogIndex } from './catalog';
import { makeReading } from './readings';

// EOT, TAB, LF, CR, FS, GS and RS separate the fields of ISO 15434 envelopes and of tab-separated PDF417.
const FIELD_SEPARATORS = new Set([4, 9, 10, 13, 28, 29, 30]);
// Other ANSI MH10.8.2 identifiers printed on the same boxes: revision, country, lot, quantity, date.
const OTHER_IDENTIFIER = /^(?:2P[A-Z0-9]{1,4}|4L[A-Z]{2}|1T[A-Z0-9]+|Q\d{1,6}|D\d{6,8}|1?0D\d{4,8}|9D\d{4,8})$/;

export function printable(value: string): string {
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
export function barcodeFields(raw: string): BarcodeFields | null {
  if (raw.startsWith('[)>')) {
    const [envelope, ...fields] = splitFields(raw.slice(3));
    return { ...(envelope ? { envelope } : {}), fields };
  }
  const fields = splitFields(raw);
  return fields.length > 1 ? { fields } : null;
}

// GS1 element strings (ISO 15434 format 05). Zebra printers put the serial number at the end of the
// GIAI, AI 8004: "8004" + "663056" + "99J242000740". AI 21 is the GS1 serial number.
export function gs1Serial(field: string): string | null {
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
