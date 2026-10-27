import { ScrollView, Text } from 'react-native';
import { useState } from 'react';
import { Button, Notice, styles } from './ui';
import type { ExportFormat } from './exportFormats';

const FORMATS: [ExportFormat, string][] = [
  ['pdf', 'PDF · relatório para conferência'],
  ['xlsx', 'Excel · planilha com todas as unidades'],
  ['csv', 'CSV · tabela simples'],
  ['json', 'JSON · backup do app'],
];

export function ExportScreen({ title, partial, busy, onExport, onBack }: {
  title: string; partial: boolean; busy: boolean;
  onExport: (format: ExportFormat, destination: 'folder' | 'share') => void;
  onBack: () => void;
}) {
  const [format, setFormat] = useState<ExportFormat>('pdf');
  return <ScrollView contentContainerStyle={styles.content}>
    <Text style={styles.heading}>Exportar inventário</Text><Text style={styles.body}>{title}</Text>
    {partial && <Notice>As coletas ainda abertas serão identificadas como parciais. Você pode continuar lendo os equipamentos.</Notice>}
    {FORMATS.map(([value, label]) => <Button key={value} title={label} secondary={format !== value} disabled={busy} onPress={() => setFormat(value)} />)}
    {format === 'json'
      ? <Text style={styles.body}>Backup do Ytech Invent, com identificação da empresa, leituras e patrimônio. Restaure em Conta e dados; as coletas importadas ficam abertas para conferência.</Text>
      : <Text style={styles.body}>Uma linha por unidade: empresa, CNPJ, inventário, PN, descrição, NS, quantidade, patrimônio, localização e data da leitura. O PDF e o Excel também trazem a quantidade por PN.</Text>}
    <Button title="Compartilhar arquivo" disabled={busy} onPress={() => onExport(format, 'share')} />
    <Button title="Salvar em uma pasta" secondary disabled={busy} onPress={() => onExport(format, 'folder')} />
    <Text style={styles.body}>O compartilhamento abre os aplicativos do Android. Ele não confirma uma entrega nem altera o envio automático pelo Gmail; confira antes de enviar outra cópia.</Text>
    <Button title="Voltar" secondary disabled={busy} onPress={onBack} />
  </ScrollView>;
}
