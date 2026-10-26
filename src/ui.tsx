import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View, type TextInputProps } from 'react-native';

export const colors = {
  paper: '#F3F7FC', white: '#FFFFFF', ink: '#16324F', muted: '#52677F',
  line: '#D4DFED', blue: '#2457DB', green: '#0C735F', amber: '#945400', red: '#B42335',
};

export function Button({ title, onPress, secondary = false, disabled = false, danger = false }: {
  title: string; onPress: () => void; secondary?: boolean; disabled?: boolean; danger?: boolean;
}) {
  return <Pressable accessibilityRole="button" accessibilityLabel={title} accessibilityState={{ disabled }}
    disabled={disabled} onPress={onPress}
    style={({ pressed }) => [styles.button, secondary && styles.secondary, danger && styles.danger, (pressed || disabled) && { opacity: disabled ? 0.45 : 0.8 }]}>
    <Text style={[styles.buttonText, secondary && { color: colors.blue }, danger && { color: colors.red }]}>{title}</Text>
  </Pressable>;
}

export function Field({ label, ...props }: TextInputProps & { label: string }) {
  return <View style={styles.field}><Text style={styles.label}>{label}</Text>
    <TextInput {...props} accessibilityLabel={label} placeholderTextColor={colors.muted} style={[styles.input, props.style]} />
  </View>;
}

export function Notice({ children, error = false }: { children: ReactNode; error?: boolean }) {
  return <View accessibilityLiveRegion="polite" style={[styles.notice, error && { backgroundColor: '#FDEEF0' }]}>
    <Text style={{ color: error ? colors.red : colors.amber, lineHeight: 21 }}>{children}</Text>
  </View>;
}

export const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.paper },
  header: { paddingHorizontal: 22, paddingVertical: 16, backgroundColor: colors.white, borderBottomWidth: 1, borderBottomColor: colors.line, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  brand: { fontSize: 24, color: colors.ink, fontWeight: '800', letterSpacing: -0.8 },
  heading: { fontSize: 27, color: colors.ink, fontWeight: '700', letterSpacing: -0.6 },
  subheading: { fontSize: 19, color: colors.ink, fontWeight: '700' },
  body: { color: colors.muted, fontSize: 15, lineHeight: 23 },
  code: { fontFamily: 'monospace', fontSize: 17, fontWeight: '600', color: colors.ink },
  content: { padding: 22, gap: 18, paddingBottom: 40 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  panel: { backgroundColor: colors.white, padding: 18, borderRadius: 14, gap: 14 },
  field: { gap: 8 },
  label: { color: colors.ink, fontSize: 15, fontWeight: '600' },
  input: { borderWidth: 1, borderColor: colors.line, borderRadius: 8, backgroundColor: colors.white, minHeight: 54, paddingHorizontal: 14, paddingVertical: 12, color: colors.ink, fontSize: 17 },
  button: { minHeight: 54, paddingHorizontal: 18, paddingVertical: 15, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.blue, borderRadius: 9 },
  buttonText: { color: colors.white, fontSize: 16, fontWeight: '700', textAlign: 'center' },
  secondary: { backgroundColor: '#E9EFFD', borderWidth: 1, borderColor: '#CCD9F9' },
  danger: { backgroundColor: '#FDEEF0', borderWidth: 1, borderColor: '#F1C6CE' },
  notice: { padding: 14, backgroundColor: '#FFF3DC', borderRadius: 8 },
  item: { paddingVertical: 16, gap: 7, borderBottomWidth: 1, borderBottomColor: colors.line },
  pill: { paddingHorizontal: 12, paddingVertical: 6, backgroundColor: '#E3F2ED', borderRadius: 20, color: colors.green, fontSize: 12, fontWeight: '700' },
  footer: { padding: 18, gap: 10, borderTopWidth: 1, borderTopColor: colors.line, backgroundColor: colors.white },
});
