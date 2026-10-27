import { ScrollView, Text, View } from 'react-native';
import { formatCnpj, YTECH_CNPJ, YTECH_NAME } from '../../shared/company';
import { DEFAULT_RECIPIENT, type Catalog, type User } from '../../shared/model';
import type { CatalogSource } from '../catalog';
import { Button, Notice, styles } from '../ui';
import { RecipientEditor } from './RecipientEditor';

export function AccountScreen({
  user, catalog, catalogSource, catalogError, catalogWarning, storageWarning, busy, online, hasUnits, defaultRecipient,
  onSaveDefaultRecipient, onExportAll, onRestoreBackup, onImportCatalog, onRestoreCatalog, onSignInAgain, onSignOut,
}: {
  user: User; catalog: Catalog | null; catalogSource: CatalogSource; catalogError: string | null; catalogWarning: string | null;
  storageWarning: string | null; busy: boolean; online: boolean; hasUnits: boolean; defaultRecipient: string;
  onSaveDefaultRecipient: (recipient: string) => void;
  onExportAll: () => void; onRestoreBackup: () => void; onImportCatalog: () => void; onRestoreCatalog: () => void;
  onSignInAgain: () => void; onSignOut: () => void;
}) {
  const catalogText = catalog
    ? `${catalog.products.length} PN · ${catalogSource === 'imported' ? 'catálogo importado neste aparelho' : 'catálogo embutido nesta versão do app'} · versão ${catalog.version.slice(0, 12)}`
    : catalogError ?? 'Carregando catálogo…';
  return <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
    <Text style={styles.heading}>Conta e dados</Text>
    <Text style={styles.subheading}>{user.name}</Text><Text selectable style={styles.body}>{user.email}</Text>
    <View style={styles.panel}><Text style={styles.subheading}>{YTECH_NAME}</Text><Text selectable style={styles.body}>CNPJ: {formatCnpj(YTECH_CNPJ)}{'\n'}Usado automaticamente nos inventários internos.</Text></View>
    <Button title="Exportar todos os inventários com unidades" secondary disabled={busy || !hasUnits} onPress={onExportAll} />
    <Button title="Restaurar backup JSON do Ytech Invent" secondary disabled={busy} onPress={onRestoreBackup} />
    <View style={styles.panel}>
      <Text style={styles.subheading}>Destino dos inventários</Text>
      <RecipientEditor key={defaultRecipient} label="E-mail que recebe os inventários" saved={defaultRecipient} saveTitle="Salvar destino padrão" busy={busy} onSave={onSaveDefaultRecipient} />
      {defaultRecipient !== DEFAULT_RECIPIENT && <Button title={`Voltar para ${DEFAULT_RECIPIENT}`} secondary disabled={busy} onPress={() => onSaveDefaultRecipient(DEFAULT_RECIPIENT)} />}
      <Text style={styles.body}>Vale para os próximos inventários desta conta neste aparelho. Ao concluir cada inventário você ainda pode digitar outro e-mail só para ele.</Text>
      <Text style={styles.body}>O envio sai da sua conta Google e fica na sua pasta Enviados. Dois anexos: relatório em PDF e planilha Excel, com PN, descrição, NS, quantidade, patrimônio e localização de cada unidade e a quantidade por PN. Com a conta conectada, o Android também tenta enviar a fila em segundo plano quando há internet; o horário exato é decidido pelo sistema.</Text>
    </View>
    <View style={styles.panel}>
      <Text style={styles.subheading}>Catálogo de produtos</Text>
      <Text style={styles.body}>{catalogText}</Text>
      {catalogWarning && <Notice error>{catalogWarning}</Notice>}
      {catalog && !!catalog.warnings.length && <Notice>{catalog.warnings.slice(0, 8).join('\n')}{catalog.warnings.length > 8 ? `\nE mais ${catalog.warnings.length - 8} aviso(s).` : ''}</Notice>}
      <Button title="Importar catálogo SB1 (.xlsx)" secondary disabled={busy} onPress={onImportCatalog} />
      {catalogSource === 'imported' && <Button title="Voltar ao catálogo embutido" secondary disabled={busy} onPress={onRestoreCatalog} />}
      <Text style={styles.body}>O catálogo é usado para reconhecer os PN na leitura e preencher a descrição nos relatórios. A planilha precisa ter a aba Produtos com as colunas B1_COD, B1_XPART e B1_DESC.</Text>
    </View>
    <Text style={styles.body}>As leituras ficam somente neste aparelho até o envio. Desinstalar o app ou limpar seus dados remove coletas ainda não enviadas.</Text>
    {storageWarning && <Notice error>{storageWarning}</Notice>}
    <Button title="Entrar novamente com Google" secondary disabled={busy || !online} onPress={onSignInAgain} />
    <Button title="Sair desta conta" secondary disabled={busy} onPress={onSignOut} />
  </ScrollView>;
}
