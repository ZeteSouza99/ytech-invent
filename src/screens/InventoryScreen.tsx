import { useMemo } from 'react';
import { FlatList, Text, View } from 'react-native';
import { formatCnpj, organizationKindLabel } from '../../shared/company';
import { inventoryTextSchema, receiptSchema, type InventoryItem } from '../../shared/model';
import type { InventorySummary } from '../repository';
import { Button, colors, Field, Notice, stateLabels, styles } from '../ui';

export function InventoryScreen({
  inventory, items, search, onSearch, knownPns, busy, online,
  onEditIdentification, onRetry, onExport, onDelete, onRemoveItem, onEditItem, onScan, onManual, onReview,
}: {
  inventory: InventorySummary; items: InventoryItem[]; search: string; onSearch: (value: string) => void;
  knownPns: ReadonlySet<string>; busy: boolean; online: boolean;
  onEditIdentification: () => void; onRetry: (allowUncertain: boolean) => void; onExport: () => void; onDelete: () => void;
  onRemoveItem: (item: InventoryItem) => void; onEditItem: (item: InventoryItem) => void;
  onScan: () => void; onManual: () => void; onReview: () => void;
}) {
  const receipt = useMemo(() => {
    if (!inventory.receipt) return null;
    try {
      const parsed = receiptSchema.safeParse(JSON.parse(inventory.receipt));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }, [inventory.receipt]);
  const visibleItems = useMemo(() => {
    const query = search.trim().toUpperCase();
    return query ? items.filter(item => `${item.pn} ${item.ns} ${item.patrimony ?? ''} ${item.location}`.toUpperCase().includes(query)) : items;
  }, [items, search]);
  const pendingProducts = useMemo(() => new Set(items.filter(item => !knownPns.has(item.pn)).map(item => item.pn)).size, [items, knownPns]);
  const draft = inventory.state === 'draft';
  const invalidIdentification = !inventoryTextSchema.safeParse(inventory.title).success || !inventoryTextSchema.safeParse(inventory.location).success;

  return <>
    <FlatList data={visibleItems} keyExtractor={item => item.id} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled"
      ListHeaderComponent={<View style={{ gap: 14 }}>
        <Text style={styles.heading}>{inventory.title}</Text>
        {inventory.organization && <Text selectable style={styles.body}>{organizationKindLabel(inventory.organization)} · {inventory.organization.name}{'\n'}CNPJ: {formatCnpj(inventory.organization.cnpj)}</Text>}
        <Text style={styles.body}>{inventory.location} · {items.length} unidades</Text>
        <Text style={[styles.pill, { alignSelf: 'flex-start' }]}>{stateLabels[inventory.state]}</Text>
        {!!inventory.problem && <Notice error>{inventory.problem}</Notice>}
        {draft && <>
          {invalidIdentification && <Notice>A identificação salva contém caracteres inválidos. Edite-a antes de concluir; suas leituras estão preservadas.</Notice>}
          <Button title="Editar identificação" secondary disabled={busy} onPress={onEditIdentification} />
        </>}
        {!!pendingProducts && <Notice>{pendingProducts} PN fora do catálogo. Eles constarão no inventário como pendências, não no arquivo SB1.</Notice>}
        {!!inventory.lastError && <Notice error>{inventory.lastError}</Notice>}
        {!!inventory.receipt && !receipt && <Notice error>O comprovante local não pôde ser lido. Confira a pasta Enviados antes de repetir qualquer envio; as unidades continuam salvas.</Notice>}
        {receipt && <Notice>{receipt.message}{'\n'}{receipt.warnings.slice(0, 6).join('\n')}{receipt.warnings.length > 6 ? `\nMais ${receipt.warnings.length - 6} avisos no relatório.` : ''}</Notice>}
        {inventory.state === 'queued' && <Notice>Leituras preservadas. O envio pelo seu Gmail é tentado com este aplicativo aberto e conectado e, quando o Android permitir, também em segundo plano.</Notice>}
        {inventory.state === 'sending' && <Notice>Enviando pelo seu Gmail. Mantenha o aplicativo aberto até concluir.</Notice>}
        {inventory.state === 'uncertain' && <Notice>Não foi possível confirmar se o e-mail saiu. Confira a pasta Enviados do seu Gmail antes de reenviar.</Notice>}
        {inventory.state === 'sent' && <Text style={styles.body}>A mensagem está na pasta Enviados do seu Gmail. O envio não confirma a leitura pela destinatária.</Text>}
        {inventory.state === 'failed' && <Button title="Tentar envio novamente" disabled={busy || !online} onPress={() => onRetry(false)} />}
        {inventory.state === 'uncertain' && <Button title="Reenviar após conferir Enviados" secondary disabled={busy || !online} onPress={() => onRetry(true)} />}
        {!!items.length && <Button title="Exportar ou compartilhar arquivo" secondary disabled={busy} onPress={onExport} />}
        <Button title="Excluir inventário" danger disabled={busy || inventory.state === 'sending'} onPress={onDelete} />
        {!!items.length && <Field label="Buscar unidade" value={search} onChangeText={onSearch} placeholder="PN, número de série ou localização" autoCorrect={false} />}
      </View>}
      ListEmptyComponent={<Text style={[styles.body, { paddingVertical: 28 }]}>{items.length ? 'Nenhuma unidade corresponde à busca.' : 'Nenhum item contado. Toque em Ler equipamento.'}</Text>}
      renderItem={({ item }) => <View style={styles.item}>
        <Text selectable style={styles.code}>{item.pn}</Text>
        <Text selectable style={styles.code}>NS {item.ns}</Text>
        {!!item.patrimony && <Text selectable style={styles.body}>Patrimônio: {item.patrimony}</Text>}
        <Text style={styles.body}>{item.location} · 1 unidade</Text>
        {!knownPns.has(item.pn) && <Text style={{ color: colors.amber }}>PN pendente de cadastro</Text>}
        {draft && <View style={styles.row}>
          <View style={{ flex: 1 }}><Button title="Editar unidade" secondary disabled={busy} onPress={() => onEditItem(item)} /></View>
          <View style={{ flex: 1 }}><Button title="Remover leitura" secondary disabled={busy} onPress={() => onRemoveItem(item)} /></View>
        </View>}
      </View>} />
    {draft && <View style={styles.footer}>
      <Button title="Ler equipamento" disabled={busy} onPress={onScan} />
      <View style={styles.row}>
        <View style={{ flex: 1 }}><Button title="Digitar" secondary disabled={busy} onPress={onManual} /></View>
        <View style={{ flex: 1 }}><Button title="Revisar e concluir" secondary disabled={busy || !items.length} onPress={onReview} /></View>
      </View>
    </View>}
  </>;
}
