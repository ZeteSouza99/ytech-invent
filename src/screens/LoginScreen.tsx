import { ScrollView, Text, View } from 'react-native';
import { COMPANY_DOMAIN } from '../../shared/model';
import { Button, colors, Notice, styles } from '../ui';

export function LoginScreen({ busy, online, configError, storageReady, onSignIn }: {
  busy: boolean; online: boolean; configError: string | null; storageReady: boolean; onSignIn: () => void;
}) {
  return <ScrollView contentContainerStyle={[styles.content, { flexGrow: 1, justifyContent: 'center' }]}>
    <View style={{ flexDirection: 'row', height: 58, gap: 5, marginBottom: 14 }} accessibilityElementsHidden>
      {[5, 12, 5, 5, 15, 7, 4, 11, 4, 13, 6, 4].map((width, index) => <View key={index} style={{ width, backgroundColor: colors.blue, borderRadius: 1 }} />)}
    </View>
    <Text style={[styles.heading, { fontSize: 35 }]}>Cada equipamento.{'\n'}Cada número de série.</Text>
    <Text style={styles.body}>Leia, confira e registre o estoque da Ytech para a mudança de sistema. As leituras ficam salvas neste aparelho, mesmo sem internet.</Text>
    {configError && <Notice>{configError} Consulte a configuração do projeto com o administrador.</Notice>}
    {!storageReady && <Notice error>Falha ao abrir o armazenamento. Não inicie leituras sem corrigir esse erro.</Notice>}
    <Button title="Entrar com Google" disabled={busy || !online || !!configError || !storageReady} onPress={onSignIn} />
    <Text style={styles.body}>Acesso exclusivo @{COMPANY_DOMAIN}. O primeiro acesso precisa de internet. O app pede permissão para enviar o inventário pelo seu Gmail; ele não lê seus e-mails.</Text>
  </ScrollView>;
}
