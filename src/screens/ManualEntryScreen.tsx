import { useReducer, useState } from 'react';
import { KeyboardAvoidingView, Pressable, ScrollView, Text, View } from 'react-native';
import { matchingProducts } from '../../shared/labels';
import { normalizeCode, type Catalog, type InventoryItem, type Product } from '../../shared/model';
import { UnitScanner, type ScannedUnit } from '../UnitScanner';
import { Button, colors, Field, Notice, styles } from '../ui';
import { EMPTY_MANUAL_FORM, fillManualForm, manualEntrySource, manualFormReducer } from './manualForm';

export type ManualEntry = { pn: string; ns: string; rawPn: string; rawNs: string; source: InventoryItem['source']; patrimony: string };

export function ManualEntryScreen({
  initialUnit, catalog, productsByPn, catalogPns, savedSerials, active, location, onLocation, inventoryLocation, busy, onSave, onBack,
}: {
  initialUnit: Partial<ScannedUnit>; catalog: Catalog | null; productsByPn: ReadonlyMap<string, Product>;
  catalogPns: readonly string[]; savedSerials: ReadonlySet<string>; active: boolean;
  location: string; onLocation: (value: string) => void; inventoryLocation: string; busy: boolean;
  onSave: (entry: ManualEntry) => Promise<boolean>; onBack: () => void;
}) {
  const [form, dispatch] = useReducer(manualFormReducer, initialUnit, unit => fillManualForm(EMPTY_MANUAL_FORM, unit));
  const [scanning, setScanning] = useState(false);
  const product = productsByPn.get(normalizeCode(form.pn));

  async function save() {
    if (!form.confirmed) return;
    const saved = await onSave({
      pn: form.pn, ns: form.ns, rawPn: form.rawPn || form.pn, rawNs: form.rawNs || form.ns,
      source: manualEntrySource(form), patrimony: form.patrimony,
    });
    if (saved) dispatch({ type: 'saved', message: `NS ${normalizeCode(form.ns)} salvo no aparelho.` });
  }

  return <KeyboardAvoidingView style={{ flex: 1 }} behavior="height"><ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
    <Text style={styles.heading}>Digitar ou corrigir</Text>
    <Text style={styles.body}>Uma unidade por número de série. Confira ambos os campos antes de salvar.</Text>
    {!!form.savedMessage && <View style={[styles.notice, { backgroundColor: '#E3F2ED' }]}><Text accessibilityLiveRegion="polite" style={{ color: colors.green }}>{form.savedMessage}</Text></View>}
    <Button title="Ler etiqueta com a câmera" secondary disabled={busy} onPress={() => setScanning(true)} />
    <View style={styles.panel}>
      <Field label="PN · Part number" value={form.pn} onChangeText={value => dispatch({ type: 'typePn', value })} autoCorrect={false} autoCapitalize="characters" maxLength={120} style={styles.code} placeholder="Leia ou digite o PN" />
      {product ? <><Text style={styles.subheading}>{product.description}</Text><Text style={styles.body}>Código TOTVS: {product.code || 'não informado'}</Text>{!!product.issues.length && <Notice>{product.issues.join('\n')}</Notice>}</>
        : form.pn.trim() ? <Notice>PN não encontrado no catálogo. O item será salvo como pendência, sem gerar cadastro SB1 automaticamente.</Notice> : null}
      {!product && matchingProducts(catalog?.products ?? [], form.pn).slice(0, 5).map(match =>
        <Button key={match.pn} title={`${match.pn}\n${match.description}`} secondary onPress={() => dispatch({ type: 'typePn', value: match.pn })} />)}
    </View>
    <View style={styles.panel}>
      <Field label="NS · Número de série" value={form.ns} onChangeText={value => dispatch({ type: 'typeNs', value })} autoCorrect={false} autoCapitalize="characters" maxLength={80} style={styles.code} placeholder="Leia ou digite o NS" />
      {savedSerials.has(normalizeCode(form.ns)) && <Notice error>Este NS já foi contado neste inventário.</Notice>}
    </View>
    <Field label="Localização desta unidade" value={location} onChangeText={onLocation} autoCapitalize="characters" maxLength={120} />
    <Field label="Patrimônio (opcional)" value={form.patrimony} onChangeText={value => dispatch({ type: 'patrimony', value })} autoCapitalize="characters" autoCorrect={false} maxLength={80} />
    <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: form.keepPn }} onPress={() => dispatch({ type: 'toggleKeepPn' })} style={[styles.row, { minHeight: 48 }]}>
      <Text style={{ fontSize: 24, color: colors.blue }}>{form.keepPn ? '☑' : '☐'}</Text><Text style={[styles.body, { flex: 1 }]}>Manter este PN para a próxima unidade</Text>
    </Pressable>
    <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: form.confirmed }} onPress={() => dispatch({ type: 'toggleConfirmed' })} style={[styles.row, { minHeight: 54 }]}>
      <Text style={{ fontSize: 24, color: colors.blue }}>{form.confirmed ? '☑' : '☐'}</Text><Text style={[styles.label, { flex: 1 }]}>Conferi PN e NS na etiqueta do mesmo equipamento</Text>
    </Pressable>
    <Button title="Salvar unidade" disabled={busy || !form.confirmed || !form.pn.trim() || !form.ns.trim() || !location.trim()} onPress={() => { void save(); }} />
    <Button title="Voltar ao inventário" secondary disabled={busy} onPress={onBack} />
    {scanning && <UnitScanner active={active} catalogPns={catalogPns} savedSerials={savedSerials}
      describe={value => productsByPn.get(value)?.description}
      location={location.trim() || inventoryLocation}
      onClose={() => setScanning(false)}
      onManual={unit => { dispatch({ type: 'reset', unit }); setScanning(false); }}
      onUse={unit => { dispatch({ type: 'fill', unit }); setScanning(false); }} />}
  </ScrollView></KeyboardAvoidingView>;
}
