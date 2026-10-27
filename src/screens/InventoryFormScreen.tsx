import { useState } from 'react';
import { KeyboardAvoidingView, ScrollView, Text } from 'react-native';
import { isValidCnpj, YTECH_CNPJ, type Organization } from '../../shared/company';
import { OrganizationFields } from '../OrganizationFields';
import { Button, Field, styles } from '../ui';

export type InventoryFormValues = { title: string; location: string; kind: Organization['kind']; clientName: string; clientCnpj: string };

export function InventoryFormScreen({ mode, initial, locations, busy, onSubmit, onBack }: {
  mode: 'new' | 'edit'; initial: InventoryFormValues; locations: readonly string[]; busy: boolean;
  onSubmit: (values: InventoryFormValues) => void; onBack: () => void;
}) {
  const [values, setValues] = useState(initial);
  const set = <K extends keyof InventoryFormValues>(key: K) => (value: InventoryFormValues[K]) => setValues(previous => ({ ...previous, [key]: value }));
  const editing = mode === 'edit';
  const incomplete = !values.title.trim() || !values.location.trim() ||
    (values.kind === 'external' && (!values.clientName.trim() || !isValidCnpj(values.clientCnpj)));

  return <KeyboardAvoidingView style={{ flex: 1 }} behavior="height"><ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
    <Text style={styles.heading}>{editing ? 'Editar identificação' : 'Nova coleta'}</Text>
    <OrganizationFields kind={values.kind} onKind={set('kind')} name={values.clientName} onName={set('clientName')} cnpj={values.clientCnpj} onCnpj={set('clientCnpj')} internalCnpj={YTECH_CNPJ} busy={busy} />
    <Field label="Nome do inventário" value={values.title} onChangeText={set('title')} placeholder="Ex.: Estoque principal · outubro" maxLength={120} />
    <Field label="Localização inicial" value={values.location} onChangeText={set('location')} placeholder="Ex.: MZ01-E01-N01" maxLength={120} autoCapitalize="characters" />
    <Text style={styles.body}>Endereços do modelo. Escolha um ou informe a localização real:</Text>
    {locations.map(address => <Button key={address} title={address} secondary onPress={() => set('location')(address)} />)}
    {editing && <Text style={styles.body}>Os itens já salvos mantêm suas localizações. Esta localização será sugerida nas próximas leituras.</Text>}
    <Button title={editing ? 'Salvar identificação' : 'Começar coleta'} disabled={busy || incomplete} onPress={() => onSubmit(values)} />
    <Button title="Voltar" secondary onPress={onBack} />
  </ScrollView></KeyboardAvoidingView>;
}
