import { useState } from 'react';
import { View } from 'react-native';
import { recipientSchema } from '../../shared/model';
import { Button, Field, Notice } from '../ui';

// Typed e-mail address with immediate validation of the format.
export function RecipientField({ label, value, onChangeText, busy }: {
  label: string; value: string; onChangeText: (value: string) => void; busy: boolean;
}) {
  const empty = !value.trim();
  const invalid = !empty && !recipientSchema.safeParse(value).success;
  return <View style={{ gap: 8 }}>
    <Field label={label} value={value} onChangeText={onChangeText} editable={!busy} keyboardType="email-address"
      autoCapitalize="none" autoCorrect={false} autoComplete="email" maxLength={254} placeholder="nome@empresa.com" />
    {empty && <Notice>Digite o e-mail que vai receber o inventário.</Notice>}
    {invalid && <Notice>Confira o e-mail: use um único endereço, no formato nome@empresa.com.</Notice>}
  </View>;
}

// Edits a saved address; the save button only appears useful when the typed value is valid and different.
export function RecipientEditor({ label, saved, saveTitle, busy, onSave }: {
  label: string; saved: string; saveTitle: string; busy: boolean; onSave: (recipient: string) => void;
}) {
  const [value, setValue] = useState(saved);
  const parsed = recipientSchema.safeParse(value);
  const changed = parsed.success && parsed.data !== saved;
  return <View style={{ gap: 8 }}>
    <RecipientField label={label} value={value} onChangeText={setValue} busy={busy} />
    <Button title={saveTitle} secondary disabled={busy || !changed} onPress={() => { if (parsed.success) onSave(parsed.data); }} />
  </View>;
}

// Sends an inventory already sent once more, to the last address or another one typed here.
export function ResendPanel({ recipient, busy, online, onResend }: {
  recipient: string; busy: boolean; online: boolean; onResend: (recipient: string) => void;
}) {
  const [value, setValue] = useState(recipient);
  const parsed = recipientSchema.safeParse(value);
  return <View style={{ gap: 8 }}>
    <RecipientField label="Reenviar para" value={value} onChangeText={setValue} busy={busy} />
    {!online && <Notice>Você está offline. O reenvio fica na fila até haver internet.</Notice>}
    <Button title="Reenviar e-mail" secondary disabled={busy || !parsed.success} onPress={() => { if (parsed.success) onResend(parsed.data); }} />
  </View>;
}
