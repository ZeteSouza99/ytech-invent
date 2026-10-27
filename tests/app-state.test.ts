import { describe, expect, it } from 'vitest';
import { backTarget, initialNavigation, navigationReducer, type Navigation } from '../src/app/navigation';
import { openableInBackground, storagePlan, type StorageState } from '../src/storagePlan';
import { EMPTY_MANUAL_FORM, manualEntrySource, manualFormReducer } from '../src/screens/manualForm';
import type { ScannedUnit } from '../src/UnitScanner';

const unit: ScannedUnit = {
  pn: { field: 'pn', value: 'MC3401-0G1R64SS-A6', raw: '1PMC3401-0G1R64SS-A6', source: 'barcode', evidence: ['codigo'], confidence: 'alta' },
  ns: { field: 'ns', value: '25150523023493', raw: 'S25150523023493', source: 'ocr', evidence: ['texto'], confidence: 'alta' },
};

describe('navegação', () => {
  it('volta para a tela de origem de cada fluxo e sai do app só a partir dos inventários', () => {
    const at = (screen: Navigation['screen'], exportAll = false): Navigation => ({ screen, exportAll, unitId: null });
    expect(backTarget(at('home'))).toBeNull();
    expect(backTarget(at('export', true))).toBe('account');
    expect(backTarget(at('export'))).toBe('inventory');
    for (const screen of ['capture', 'edit', 'review', 'unit'] as const) expect(backTarget(at(screen))).toBe('inventory');
    for (const screen of ['new', 'inventory', 'account'] as const) expect(backTarget(at(screen))).toBe('home');
  });

  it('guarda a unidade em edição e o tipo de exportação até sair da tela', () => {
    let state = navigationReducer(initialNavigation, { type: 'unit', id: 'u1' });
    expect(state).toEqual({ screen: 'unit', exportAll: false, unitId: 'u1' });
    state = navigationReducer(state, { type: 'back' });
    expect(state).toEqual({ screen: 'inventory', exportAll: false, unitId: null });
    state = navigationReducer(state, { type: 'export', all: true });
    expect(navigationReducer(state, { type: 'back' }).screen).toBe('account');
    expect(navigationReducer(initialNavigation, { type: 'back' })).toBe(initialNavigation);
  });
});

describe('abertura do banco criptografado', () => {
  const state = (overrides: Partial<StorageState>): StorageState => ({ cipher: true, legacy: false, encrypted: false, key: false, ready: false, ...overrides });

  it('cria, abre ou migra sem nunca descartar a única cópia legível', () => {
    expect(storagePlan(state({}))).toEqual({ action: 'create' });
    expect(storagePlan(state({ legacy: true }))).toEqual({ action: 'migrate', discardEncrypted: false });
    // An encrypted file without the verified flag is an interrupted export; the legacy file is still the source.
    expect(storagePlan(state({ legacy: true, encrypted: true, key: true }))).toEqual({ action: 'migrate', discardEncrypted: true });
    expect(storagePlan(state({ encrypted: true, key: true, ready: true }))).toEqual({ action: 'open', removeLegacy: false });
    expect(storagePlan(state({ legacy: true, encrypted: true, key: true, ready: true }))).toEqual({ action: 'open', removeLegacy: true });
    expect(storagePlan(state({ encrypted: true, key: true }))).toEqual({ action: 'open', removeLegacy: false });
    expect(storagePlan(state({ ready: true, legacy: true }))).toEqual({ action: 'migrate', discardEncrypted: false });
  });

  it('para com erro, sem apagar nada, quando a chave ou o SQLCipher faltam para dados já criptografados', () => {
    expect(storagePlan(state({ encrypted: true, ready: true }))).toEqual({ action: 'key-missing' });
    expect(storagePlan(state({ encrypted: true }))).toEqual({ action: 'key-missing' });
    expect(storagePlan(state({ cipher: false, encrypted: true, ready: true, key: true }))).toEqual({ action: 'cipher-missing' });
    expect(storagePlan(state({ cipher: false, encrypted: true, key: true }))).toEqual({ action: 'cipher-missing' });
    expect(storagePlan(state({ cipher: false, legacy: true, encrypted: true }))).toEqual({ action: 'plain' });
    expect(storagePlan(state({ cipher: false }))).toEqual({ action: 'plain' });
  });

  it('em segundo plano só abre um banco pronto, nunca cria nem migra', () => {
    const allowed = (overrides: Partial<StorageState>) => openableInBackground(storagePlan(state(overrides)));
    expect(allowed({ encrypted: true, key: true, ready: true })).toBe(true);
    expect(allowed({ legacy: true, encrypted: true, key: true, ready: true })).toBe(true);
    expect(allowed({ cipher: false, legacy: true })).toBe(true);
    expect(allowed({})).toBe(false);
    expect(allowed({ legacy: true })).toBe(false);
    expect(allowed({ legacy: true, encrypted: true, key: true })).toBe(false);
    expect(allowed({ encrypted: true, ready: true })).toBe(false);
  });
});

describe('formulário de digitação', () => {
  it('exige nova confirmação a cada valor lido ou digitado', () => {
    let form = manualFormReducer(EMPTY_MANUAL_FORM, { type: 'fill', unit });
    expect(form).toMatchObject({ pn: unit.pn.value, rawPn: unit.pn.raw, pnSource: 'barcode', ns: unit.ns.value, nsSource: 'ocr', confirmed: false });
    expect(manualEntrySource(form)).toBe('ocr');
    form = manualFormReducer(form, { type: 'toggleConfirmed' });
    expect(form.confirmed).toBe(true);
    form = manualFormReducer(form, { type: 'typeNs', value: '123' });
    expect(form).toMatchObject({ ns: '123', rawNs: '123', nsSource: 'manual', confirmed: false });
    expect(manualEntrySource(form)).toBe('manual');
    expect(manualEntrySource({ pnSource: 'barcode', nsSource: 'barcode' })).toBe('barcode');
  });

  it('mantém o PN após salvar somente quando pedido e limpa o restante', () => {
    let form = manualFormReducer(EMPTY_MANUAL_FORM, { type: 'reset', unit });
    form = manualFormReducer(manualFormReducer(form, { type: 'patrimony', value: 'P1' }), { type: 'toggleKeepPn' });
    const kept = manualFormReducer(form, { type: 'saved', message: 'NS salvo.' });
    expect(kept).toMatchObject({ pn: unit.pn.value, pnSource: 'barcode', ns: '', patrimony: '', keepPn: true, confirmed: false, savedMessage: 'NS salvo.' });
    const cleared = manualFormReducer(manualFormReducer(form, { type: 'toggleKeepPn' }), { type: 'saved', message: 'ok' });
    expect(cleared).toEqual({ ...EMPTY_MANUAL_FORM, savedMessage: 'ok' });
    expect(manualFormReducer(form, { type: 'reset', unit: { ns: unit.ns } })).toEqual({ ...EMPTY_MANUAL_FORM, ns: unit.ns.value, rawNs: unit.ns.raw, nsSource: 'ocr' });
  });
});
