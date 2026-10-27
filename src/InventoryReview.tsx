import { useState } from 'react';
import { KeyboardAvoidingView, ScrollView, Text, View } from 'react-native';
import { recipientSchema, type Catalog, type InventoryItem } from '../shared/model';
import { inventoryReview } from './review';
import { formatCnpj, organizationKindLabel, type Organization } from '../shared/company';
import { RecipientField } from './screens/RecipientEditor';
import { Button, Notice, styles } from './ui';

export function InventoryReview({ title, organization, items, catalog, defaultRecipient, busy, online, onFinish, onExport, onBack }: {
  title: string; items: InventoryItem[]; catalog: Catalog | null; defaultRecipient: string; busy: boolean; online: boolean;
  organization?: Organization;
  onFinish: (recipient: string) => void; onExport: () => void; onBack: () => void;
}) {
  const review = inventoryReview(items, catalog);
  // Starts at the account default; another address typed here applies only to this inventory.
  const [recipient, setRecipient] = useState(defaultRecipient);
  const parsed = recipientSchema.safeParse(recipient);
  return <KeyboardAvoidingView style={{ flex: 1 }} behavior="height"><ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
    <Text style={styles.heading}>Conferir inventário</Text>
    <Text style={styles.subheading}>{title}</Text>
    {organization && <Text selectable style={styles.body}>{organizationKindLabel(organization)} · {organization.name}{'\n'}CNPJ: {formatCnpj(organization.cnpj)}</Text>}
    <View style={styles.panel}>
      <Text style={styles.subheading}>{review.units} unidades · {review.products} PN</Text>
      <Text style={styles.body}>{review.locations} localizações · {review.manual} unidades com digitação manual</Text>
    </View>
    {!!review.unknown.length && <Notice>{review.unknown.length} PN fora do catálogo: {review.unknown.slice(0, 8).join(', ')}{review.unknown.length > 8 ? '…' : ''}. Entram normalmente no relatório, sem descrição.</Notice>}
    <View style={styles.panel}>
      <Text style={styles.label}>Envio pelo Gmail</Text>
      <RecipientField label="Enviar para" value={recipient} onChangeText={setRecipient} busy={busy} />
      {parsed.success && parsed.data !== defaultRecipient && <Text style={styles.body}>Só este inventário vai para este endereço. O destino padrão continua {defaultRecipient}.</Text>}
      {parsed.success && parsed.data !== defaultRecipient && <Button title={`Voltar para ${defaultRecipient}`} secondary disabled={busy} onPress={() => setRecipient(defaultRecipient)} />}
      <Text style={styles.body}>Dois anexos: relatório em PDF e planilha Excel, ambos com PN, descrição, NS, quantidade, patrimônio e localização de cada unidade e a quantidade por PN. Depois de concluir, as unidades ficam bloqueadas para edição.</Text>
      {!online && <Notice>Você está offline. A coleta ficará na fila até abrir o app com internet.</Notice>}
    </View>
    <Button title="Concluir e enviar" disabled={busy || !items.length || !parsed.success} onPress={() => { if (parsed.success) onFinish(parsed.data); }} />
    <Button title="Exportar cópia parcial" secondary disabled={busy || !items.length} onPress={onExport} />
    <Button title="Voltar e conferir as unidades" secondary disabled={busy} onPress={onBack} />
  </ScrollView></KeyboardAvoidingView>;
}
