import type { InventoryItem } from '../../shared/model';
import type { ScannedUnit } from '../UnitScanner';

type Source = InventoryItem['source'];

export type ManualForm = {
  pn: string; ns: string; rawPn: string; rawNs: string; pnSource: Source; nsSource: Source;
  patrimony: string; confirmed: boolean; keepPn: boolean; savedMessage: string;
};

export type ManualFormAction =
  | { type: 'typePn'; value: string }
  | { type: 'typeNs'; value: string }
  | { type: 'patrimony'; value: string }
  | { type: 'toggleConfirmed' }
  | { type: 'toggleKeepPn' }
  // Values read by the camera fill the fields but still need the user's confirmation.
  | { type: 'fill'; unit: Partial<ScannedUnit> }
  | { type: 'reset'; unit: Partial<ScannedUnit> }
  | { type: 'saved'; message: string };

export const EMPTY_MANUAL_FORM: ManualForm = {
  pn: '', ns: '', rawPn: '', rawNs: '', pnSource: 'manual', nsSource: 'manual', patrimony: '', confirmed: false, keepPn: false, savedMessage: '',
};

export function fillManualForm(state: ManualForm, unit: Partial<ScannedUnit>): ManualForm {
  return {
    ...state, confirmed: false,
    ...(unit.pn ? { pn: unit.pn.value, rawPn: unit.pn.raw, pnSource: unit.pn.source } : {}),
    ...(unit.ns ? { ns: unit.ns.value, rawNs: unit.ns.raw, nsSource: unit.ns.source } : {}),
  };
}

export function manualFormReducer(state: ManualForm, action: ManualFormAction): ManualForm {
  switch (action.type) {
    case 'typePn':
      return { ...state, pn: action.value, rawPn: action.value, pnSource: 'manual', confirmed: false };
    case 'typeNs':
      return { ...state, ns: action.value, rawNs: action.value, nsSource: 'manual', confirmed: false };
    case 'patrimony':
      return { ...state, patrimony: action.value };
    case 'toggleConfirmed':
      return { ...state, confirmed: !state.confirmed };
    case 'toggleKeepPn':
      return { ...state, keepPn: !state.keepPn };
    case 'fill':
      return fillManualForm(state, action.unit);
    case 'reset':
      return fillManualForm(EMPTY_MANUAL_FORM, action.unit);
    case 'saved':
      // Keeps the part number for batches of the same model when the user asked to.
      return {
        ...EMPTY_MANUAL_FORM, keepPn: state.keepPn, savedMessage: action.message,
        ...(state.keepPn ? { pn: state.pn, rawPn: state.rawPn, pnSource: state.pnSource } : {}),
      };
  }
}

// Any field typed by hand makes the unit manual; otherwise OCR wins over a decoded barcode.
export function manualEntrySource(form: Pick<ManualForm, 'pnSource' | 'nsSource'>): Source {
  if (form.pnSource === 'manual' || form.nsSource === 'manual') return 'manual';
  return form.pnSource === 'ocr' || form.nsSource === 'ocr' ? 'ocr' : 'barcode';
}
