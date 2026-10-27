import { useMemo } from 'react';
import { FlatList, Pressable, Text, View } from 'react-native';
import { formatCnpj, organizationKindLabel } from '../../shared/company';
import type { InventorySummary } from '../repository';
import { Button, colors, Field, Notice, stateLabels, styles } from '../ui';

export function HomeScreen({ userName, inventories, search, onSearch, catalogReady, catalogError, catalogWarning, busy, onStart, onOpen }: {
  userName: string; inventories: InventorySummary[]; search: string; onSearch: (value: string) => void;
  catalogReady: boolean; catalogError: string | null; catalogWarning: string | null; busy: boolean;
  onStart: () => void; onOpen: (id: string) => void;
}) {
  const visible = useMemo(() => {
    const query = search.trim().toUpperCase();
    return inventories.filter(entry => `${entry.title} ${entry.location} ${entry.organization?.name ?? ''} ${entry.organization?.cnpj ?? ''} ${entry.organization ? formatCnpj(entry.organization.cnpj) : ''}`.toUpperCase().includes(query));
  }, [inventories, search]);

  return <FlatList data={visible} keyExtractor={item => item.id} contentContainerStyle={styles.content}
    ListHeaderComponent={<View style={{ gap: 16 }}>
      <Text style={styles.heading}>Inventários</Text>
      <Text style={styles.body}>{userName}, retome uma coleta ou comece por uma localização do estoque.</Text>
      {!catalogReady && !catalogError && <Notice>Carregando o catálogo de produtos…</Notice>}
      {catalogError && <Notice error>{catalogError}</Notice>}
      {catalogWarning && <Notice error>{catalogWarning}</Notice>}
      <Button title="Iniciar inventário" disabled={!catalogReady || busy} onPress={onStart} />
      <Field label="Buscar inventário" value={search} onChangeText={onSearch} placeholder="Nome, cliente, CNPJ ou localização" />
    </View>}
    ListEmptyComponent={<View style={[styles.panel, { marginTop: 22 }]}><Text style={styles.subheading}>Pronto para a primeira coleta</Text><Text style={styles.body}>Identifique a localização, leia o PN e depois o NS de cada equipamento.</Text></View>}
    renderItem={({ item }) => <Pressable accessibilityRole="button" disabled={busy} onPress={() => onOpen(item.id)} style={styles.item}>
      <Text style={styles.subheading}>{item.title}</Text>
      {item.organization && <Text style={styles.body}>{organizationKindLabel(item.organization)} · {item.organization.name} · {formatCnpj(item.organization.cnpj)}</Text>}
      <Text style={styles.body}>{item.location} · {item.count} {item.count === 1 ? 'unidade' : 'unidades'}</Text>
      <Text style={{ color: item.state === 'sent' ? colors.green : item.state === 'draft' ? colors.blue : colors.amber, fontWeight: '700' }}>{stateLabels[item.state]}</Text>
      {!!item.problem && <Text style={{ color: colors.red }}>Dados com problema. Abra a coleta para ver o que fazer.</Text>}
      <Text style={styles.body}>{new Date(item.startedAt).toLocaleString('pt-BR')}</Text>
    </Pressable>} />;
}
