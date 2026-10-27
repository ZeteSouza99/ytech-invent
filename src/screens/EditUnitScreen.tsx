import { useState } from 'react';
import { KeyboardAvoidingView, ScrollView, Text, View } from 'react-native';
import type { InventoryItem } from '../../shared/model';
import type { UnitChanges } from '../repository';
import { Button, Field, styles } from '../ui';

export function EditUnitScreen({ item, busy, onSave, onBack }: {
  item: InventoryItem; busy: boolean; onSave: (changes: UnitChanges) => void; onBack: () => void;
}) {
  const [location, setLocation] = useState(item.location);
  const [patrimony, setPatrimony] = useState(item.patrimony ?? '');
  return <KeyboardAvoidingView style={{ flex: 1 }} behavior="height"><ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
    <Text style={styles.heading}>Editar unidade</Text>
    <View style={styles.panel}>
      <Text selectable style={styles.code}>{item.pn}</Text>
      <Text selectable style={styles.code}>NS {item.ns}</Text>
      <Text style={styles.body}>PN e NS não podem ser alterados. Se a leitura estiver errada, remova a unidade e leia a etiqueta de novo.</Text>
    </View>
    <Field label="Localização desta unidade" value={location} onChangeText={setLocation} autoCapitalize="characters" maxLength={120} />
    <Field label="Patrimônio (opcional)" value={patrimony} onChangeText={setPatrimony} autoCapitalize="characters" autoCorrect={false} maxLength={80} />
    <Button title="Salvar alterações" disabled={busy || !location.trim()} onPress={() => onSave({ location, patrimony })} />
    <Button title="Voltar ao inventário" secondary disabled={busy} onPress={onBack} />
  </ScrollView></KeyboardAvoidingView>;
}
