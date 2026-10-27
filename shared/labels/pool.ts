import { normalizeCode } from '../model';
import { RANK, type LabelAnalysis, type LabelField, type Reading } from './types';
import { barcodeConfirmed, shadowedBy } from './readings';

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
      // With several labels in view, another label's part number must not stand in for this label's own one
      // while it is still being confirmed.
      const ownPending = !pairedEntry && paired !== undefined && this.latestSerials > 1;
      if (pairedEntry) partNumber = pairedEntry.reading;
      else if (!ownPending && distinct.size === 1) partNumber = acceptedPns[0]!.reading;
      else if (!ownPending && distinct.size > 1 && serial) {
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
