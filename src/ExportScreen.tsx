import { ScrollView, Text, View } from 'react-native';
import { useState } from 'react';
import { Button, Notice, styles } from './ui';
import type { ExportFormat } from './exportFormats';

export function ExportScreen({ title, all, partial, busy, onExport, onBack }: {
  title: string; all: boolean; partial: boolean; busy: boolean;
  onExport: (format: ExportFormat, destination: 'folder' | 'share', workbook?: 'report' | 'sb1') => void;
  onBack: () => void;
}) {
  const [format, setFormat] = useState<ExportFormat>('pdf');
  const [workbook, setWorkbook] = useState<'report' | 'sb1'>('report');
  return <ScrollView contentContainerStyle={styles.content}>
    <Text style={styles.heading}>Exportar inventário</Text><Text style={styles.body}>{title}</Text>
    {partial && <Notice>As coletas ainda abertas serão identificadas como parciais. Você pode continuar lendo os equipamentos.</Notice>}
    {([['pdf', 'PDF · relatório para conferência'], ['csv', 'CSV · tabela de equipamentos'], ['json', 'JSON · backup completo'], ...(!all ? [['xlsx', 'Excel · relatório e modelo SB1']] : [])] as [ExportFormat, string][]).map(([value, label]) =>
      <Button key={value} title={label} secondary={format !== value} disabled={busy} onPress={() => setFormat(value)} />)}
    {format === 'json' && <Text style={styles.body}>Backup do Ytech Invent, com identificação da empresa, leituras e patrimônio. Restaure em Conta e dados; as coletas importadas ficam abertas para conferência.</Text>}
    {format === 'xlsx' && <View style={styles.panel}>
      <Text style={styles.label}>Arquivo para compartilhar</Text>
      <Button title="Relatório de inventário" secondary={workbook !== 'report'} disabled={busy} onPress={() => setWorkbook('report')} />
      <Button title="Cadastro SB1 para TOTVS" secondary={workbook !== 'sb1'} disabled={busy} onPress={() => setWorkbook('sb1')} />
      <Text style={styles.body}>Ao salvar em uma pasta, as duas planilhas serão incluídas.</Text>
    </View>}
    <Button title="Compartilhar arquivo" disabled={busy} onPress={() => onExport(format, 'share', workbook)} />
    <Button title="Salvar em uma pasta" secondary disabled={busy} onPress={() => onExport(format, 'folder', workbook)} />
    <Text style={styles.body}>O compartilhamento abre os aplicativos do Android. Ele não confirma uma entrega nem altera o envio automático pelo Gmail; confira antes de enviar outra cópia.</Text>
    <Button title="Voltar" secondary disabled={busy} onPress={onBack} />
  </ScrollView>;
}
