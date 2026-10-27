import { normalizeCode, partNumberSchema } from '../model';
import type { Box } from './types';

// Layouts seen on the inventory labels: Zebra/Motorola/Extreme 14-digit serials
// (e.g. 25150523023493, 03052211308046) and Zebra printer serials (e.g. 99J242000740, T3N232800835).
export const SERIAL_DIGITS = /^\d{14}$/;
export const SERIAL_PRINTER = /^[A-Z0-9]{2}[A-Z]\d{9}$/;
const MAC_SEPARATED = /^(?:[0-9A-F]{2}[:-]){5}[0-9A-F]{2}$/;
const MAC_PLAIN = /^[0-9A-F]{12}$/;
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const DATE_NUMERIC = /^\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}$/;
const DATE_TEXT = /^\d{1,2}(?:JAN|FEB|FEV|MAR|APR|ABR|MAY|MAI|JUN|JUL|AUG|AGO|SEP|SET|OCT|OUT|NOV|DEC|DEZ)\d{2,4}$/;

export const DIGIT_LOOKALIKES: Record<string, string> = { O: '0', Q: '0', D: '0', I: '1', L: '1', '|': '1', Z: '2', S: '5', B: '8', G: '6' };

export function strongSerial(value: string): boolean {
  return SERIAL_DIGITS.test(value) || SERIAL_PRINTER.test(value);
}

export function digitCount(value: string): number {
  let count = 0;
  for (const character of value) if (character >= '0' && character <= '9') count += 1;
  return count;
}

export function genericSerial(value: string): boolean {
  return /^[A-Z0-9]{8,24}$/.test(value) && digitCount(value) >= 5 && !(MAC_PLAIN.test(value) && /[A-F]/.test(value));
}

export function excludedValue(value: string): boolean {
  return MAC_SEPARATED.test(value) || (MAC_PLAIN.test(value) && /[A-F]/.test(value)) || IPV4.test(value) ||
    DATE_NUMERIC.test(value) || DATE_TEXT.test(value) || /^\d{1,4}$/.test(value) || /^[A-Z ]+$/.test(value) ||
    /^HTTPS?:/.test(value);
}

export function looksLikePartNumber(value: string): boolean {
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

// OCR reads zeros inside digit runs as the letter O ("SRO0004ZZWW"). Only used for part numbers
// outside the catalog; the only catalog part number with O next to a digit (TC51OK) matches the catalog first.
export function zeroRuns(value: string): string {
  return value.replace(/[0-9O]{2,}/g, run => (/\d/.test(run) ? run.replace(/O/g, '0') : run));
}

export function withinOneEdit(left: string, right: string): boolean {
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
export function editDistance(left: string, right: string, limit: number): number {
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
export function adjacent(text?: Box, code?: Box): boolean {
  if (!text || !code) return false;
  const height = Math.max(text.height, 1);
  const vertical = Math.max(code.y - (text.y + text.height), text.y - (code.y + code.height), 0);
  const horizontal = Math.max(code.x - (text.x + text.width), text.x - (code.x + code.width), 0);
  return vertical <= height * 4 && horizontal <= height * 2;
}

export function center(box: Box) {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}
