import { Text, View } from 'react-native';
import { formatCnpj, isValidCnpj, YTECH_NAME, type Organization } from '../shared/company';
import { Button, Field, Notice, styles } from './ui';

export function OrganizationFields({ kind, onKind, name, onName, cnpj, onCnpj, internalCnpj, busy }: {
  kind: Organization['kind']; onKind: (kind: Organization['kind']) => void;
  name: string; onName: (name: string) => void; cnpj: string; onCnpj: (cnpj: string) => void;
  internalCnpj: string; busy: boolean;
}) {
  return <View style={styles.panel}>
    <Text style={styles.subheading}>Este inventário é interno ou externo?</Text>
    <View style={styles.row}>
      <View style={{ flex: 1 }}><Button title="Interno" secondary={kind !== 'internal'} disabled={busy} onPress={() => onKind('internal')} /></View>
      <View style={{ flex: 1 }}><Button title="Externo" secondary={kind !== 'external'} disabled={busy} onPress={() => onKind('external')} /></View>
    </View>
    {kind === 'internal' ? <>
      <Text style={styles.label}>{YTECH_NAME}</Text>
      <Text selectable style={styles.body}>CNPJ: {formatCnpj(internalCnpj)}{ '\n' }Preenchido automaticamente.</Text>
    </> : <>
      <Field label="Nome do cliente" value={name} onChangeText={onName} maxLength={120} editable={!busy} />
      <Field label="CNPJ do cliente" value={cnpj} onChangeText={onCnpj} maxLength={18} autoCapitalize="characters" autoCorrect={false} editable={!busy} placeholder="00.000.000/0000-00" />
      {!!cnpj && !isValidCnpj(cnpj) && <Notice>Confira os 14 caracteres e os dígitos verificadores do CNPJ.</Notice>}
    </>}
  </View>;
}
