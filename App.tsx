import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, AppState, BackHandler, FlatList, KeyboardAvoidingView, Pressable, ScrollView, StatusBar, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import NetInfo from '@react-native-community/netinfo';
import { openDatabaseAsync } from 'expo-sqlite';
import { randomUUID } from 'expo-crypto';
import { COMPANY_DOMAIN, errorMessage, inventoryTextSchema, normalizeCode, receiptSchema, RECIPIENT, type Catalog, type InventoryItem, type User } from './shared/model';
import { matchingProducts } from './shared/labels';
import { accessToken, configurationError, login, logout, restoreSession } from './src/google';
import { loadWorkbookService } from './src/catalog';
import { createGmailDelivery } from './src/delivery';
import { InventoryRepository, type InventorySummary } from './src/repository';
import { Outbox } from './src/outbox';
import { UnitScanner, type ScannedUnit } from './src/UnitScanner';
import { Button, colors, Field, Notice, styles } from './src/ui';
import { InventoryReview } from './src/InventoryReview';
import { ErrorBoundary } from './src/ErrorBoundary';
import { saveWorkbookFiles } from './src/exportFiles';
import { formatCnpj, isValidCnpj, organizationSchema, YTECH_CNPJ, YTECH_NAME, type Organization } from './shared/company';
import { OrganizationFields } from './src/OrganizationFields';
import { ExportScreen } from './src/ExportScreen';
import { chooseBackup, createDocument, shareDocument } from './src/shareExport';
import type { ExportEntry, ExportFormat } from './src/exportFormats';

const labels = { draft: 'Em coleta', queued: 'Envio pendente', sending: 'Enviando', sent: 'Enviado pelo Gmail', failed: 'Falha no envio', uncertain: 'Envio a conferir' };

function Application() {
  const [repository, setRepository] = useState<InventoryRepository | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [inventories, setInventories] = useState<InventorySummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [screen, setScreen] = useState<'home' | 'new' | 'edit' | 'inventory' | 'capture' | 'account' | 'review' | 'export'>('home');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [online, setOnline] = useState(false);
  const [active, setActive] = useState(AppState.currentState === 'active');
  // 'save' keeps the camera open and saves each unit; 'fill' returns the values to the manual form.
  const [scanner, setScanner] = useState<'save' | 'fill' | null>(null);
  const [title, setTitle] = useState('');
  const [location, setLocation] = useState('');
  const [pn, setPn] = useState('');
  const [ns, setNs] = useState('');
  const [rawPn, setRawPn] = useState('');
  const [rawNs, setRawNs] = useState('');
  const [pnSource, setPnSource] = useState<InventoryItem['source']>('manual');
  const [nsSource, setNsSource] = useState<InventoryItem['source']>('manual');
  const [confirmed, setConfirmed] = useState(false);
  const [keepPn, setKeepPn] = useState(false);
  const [lockedPn, setLockedPn] = useState<string | null>(null);
  const [savedMessage, setSavedMessage] = useState('');
  const [search, setSearch] = useState('');
  const [kind, setKind] = useState<Organization['kind']>('internal');
  const [clientName, setClientName] = useState('');
  const [clientCnpj, setClientCnpj] = useState('');
  const [patrimony, setPatrimony] = useState('');
  const [exportAll, setExportAll] = useState(false);
  const [inventorySearch, setInventorySearch] = useState('');
  const visibleInventories = useMemo(() => {
    const query = inventorySearch.trim().toUpperCase();
    return inventories.filter(entry => `${entry.title} ${entry.location} ${entry.organization?.name ?? ''} ${entry.organization?.cnpj ?? ''} ${entry.organization ? formatCnpj(entry.organization.cnpj) : ''}`.toUpperCase().includes(query));
  }, [inventories, inventorySearch]);
  const refreshSequence = useRef(0);
  const visibleDataKey = useRef('');
  visibleDataKey.current = `${user?.sub ?? ''}:${selectedId ?? ''}`;
  const userRef = useRef<User | null>(null);
  userRef.current = user;
  const current = inventories.find(inventory => inventory.id === selectedId);
  const product = catalog?.products.find(item => item.pn === normalizeCode(pn));
  const knownPns = useMemo(() => new Set(catalog?.products.map(item => item.pn) ?? []), [catalog]);
  const catalogPns = useMemo(() => catalog?.products.map(item => item.pn) ?? [], [catalog]);
  const savedSerials = useMemo(() => new Set(items.map(item => item.ns)), [items]);
  const visibleItems = useMemo(() => {
    const query = search.trim().toUpperCase();
    return query ? items.filter(item => `${item.pn} ${item.ns} ${item.patrimony ?? ''} ${item.location}`.toUpperCase().includes(query)) : items;
  }, [items, search]);
  const outbox = useMemo(() => repository ? new Outbox(repository, createGmailDelivery({
    workbook: loadWorkbookService,
    reportPdf: inventory => createDocument([{ inventory, partial: false }], 'pdf'),
    user: owner => (userRef.current?.sub === owner ? userRef.current : null),
    accessToken,
  })) : null, [repository]);
  const configError = configurationError();

  const refresh = useCallback(async () => {
    if (!repository || !user) return;
    const sequence = ++refreshSequence.current;
    const dataKey = `${user.sub}:${selectedId ?? ''}`;
    try {
      const savedInventories = await repository.list(user.sub);
      const savedItems = selectedId && savedInventories.some(entry => entry.id === selectedId)
        ? await repository.items(user.sub, selectedId) : [];
      if (sequence !== refreshSequence.current || visibleDataKey.current !== dataKey) return;
      setInventories(savedInventories);
      setItems(savedItems);
    } catch (failure) {
      if (sequence !== refreshSequence.current || visibleDataKey.current !== dataKey) return;
      throw failure;
    }
  }, [repository, user, selectedId]);

  async function run(action: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try { await action(); }
    catch (failure) { setError(errorMessage(failure)); }
    finally { busyRef.current = false; setBusy(false); }
  }

  useEffect(() => {
    let mounted = true;
    void (async () => {
      const db = await openDatabaseAsync('ytech-invent.db');
      const local = new InventoryRepository(db);
      await local.initialize();
      await local.recoverInterrupted();
      const saved = await restoreSession().catch(failure => {
        if (mounted) setError(`Não foi possível restaurar o login: ${errorMessage(failure)}. Entre novamente; suas coletas foram preservadas.`);
        return null;
      });
      if (mounted) { setRepository(local); setUser(saved); }
    })().catch(failure => { if (mounted) setError(errorMessage(failure)); })
      .finally(() => { if (mounted) setLoading(false); });
    loadWorkbookService()
      .then(service => { if (mounted) { setCatalog(service.catalog); setCatalogError(null); } })
      .catch(failure => { if (mounted) setCatalogError(errorMessage(failure)); });
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener(state => setOnline(state.isConnected === true && state.isInternetReachable !== false));
    const subscription = AppState.addEventListener('change', state => setActive(state === 'active'));
    return () => { unsubscribe(); subscription.remove(); };
  }, []);

  useEffect(() => { void refresh().catch(failure => setError(errorMessage(failure))); }, [refresh]);

  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (busy) return true;
      if (screen === 'home' || !user) return false;
      setError(null);
      setScreen(screen === 'export' ? (exportAll ? 'account' : 'inventory') : ['capture', 'edit', 'review'].includes(screen) ? 'inventory' : 'home');
      return true;
    });
    return () => subscription.remove();
  }, [busy, screen, user, exportAll]);

  useEffect(() => {
    if (!outbox || !user || !online || !active) return;
    let mounted = true;
    const owner = user.sub;
    const sync = async () => {
      try { await outbox.sync(owner); }
      catch (failure) { if (mounted) setError(errorMessage(failure)); }
      finally { if (mounted) void refresh().catch(failure => setError(errorMessage(failure))); }
    };
    void sync();
    const timer = setInterval(() => { void sync(); }, 30000);
    return () => { mounted = false; clearInterval(timer); };
  }, [outbox, user, online, active, refresh]);

  async function signIn() {
    if (!repository) throw new Error('O armazenamento local não está disponível. Reinicie o aplicativo.');
    const signedIn = await login();
    setInventories([]);
    setItems([]);
    setSelectedId(null);
    setUser(signedIn);
    setScreen('home');
  }

  async function createInventory() {
    const organization = organizationSchema.parse(kind === 'internal'
      ? { kind, name: YTECH_NAME, cnpj: YTECH_CNPJ }
      : { kind, name: clientName, cnpj: clientCnpj });
    if (screen === 'edit') {
      if (!repository || !user || !current) throw new Error('Inventário não disponível.');
      await repository.updateMetadata(user.sub, current.id, { title, location, organization });
      await refresh();
      setScreen('inventory');
      return;
    }
    if (!repository || !user || !catalog) throw new Error('Aguarde o catálogo de produtos carregar antes de iniciar.');
    const id = randomUUID();
    await repository.create({
      id, owner: user.sub, title, location, startedAt: new Date().toISOString(), completedAt: null,
      catalogVersion: catalog.version, state: 'draft', receipt: null, lastError: '',
      organization,
    });
    setSelectedId(id);
    setScreen('inventory');
    await refresh();
  }

  function clearCapture(preservePn = false) {
    if (!preservePn) { setPn(''); setRawPn(''); setPnSource('manual'); }
    setNs(''); setRawNs(''); setConfirmed(false); setNsSource('manual');
    setPatrimony('');
  }

  function startScanning() {
    if (!current) return;
    setLocation(current.location);
    setLockedPn(null);
    setScanner('save');
  }

  function openManualForm(unit: Partial<ScannedUnit> = {}) {
    if (!current) return;
    clearCapture();
    if (unit.pn) { setPn(unit.pn.value); setRawPn(unit.pn.raw); setPnSource(unit.pn.source); }
    if (unit.ns) { setNs(unit.ns.value); setRawNs(unit.ns.raw); setNsSource(unit.ns.source); }
    if (!location.trim()) setLocation(current.location);
    setSavedMessage('');
    setKeepPn(false);
    setScanner(null);
    setScreen('capture');
  }

  async function saveScanned(unit: ScannedUnit, keep: boolean): Promise<string> {
    if (!repository || !user || !current) throw new Error('Inventário não disponível.');
    await repository.add(user.sub, current.id, {
      id: randomUUID(), pn: unit.pn.value, ns: unit.ns.value, rawPn: unit.pn.raw, rawNs: unit.ns.raw,
      location: location.trim() || current.location, quantity: 1, capturedAt: new Date().toISOString(),
      source: unit.pn.source === 'barcode' && unit.ns.source === 'barcode' ? 'barcode' : 'ocr',
      // The user confirmed by tapping "Salvar unidade" with both values on screen.
      confirmed: true,
    });
    if (keep) setLockedPn(unit.pn.value);
    await refresh();
    return `NS ${unit.ns.value} salvo. Aponte para o próximo equipamento.`;
  }

  async function saveItem() {
    if (!repository || !user || !current) throw new Error('Inventário não disponível.');
    if (!confirmed) throw new Error('Confira PN e NS na etiqueta e marque a confirmação.');
    await repository.add(user.sub, current.id, {
      id: randomUUID(), pn, ns, rawPn: rawPn || pn, rawNs: rawNs || ns, location, quantity: 1,
      capturedAt: new Date().toISOString(),
      source: pnSource === 'manual' || nsSource === 'manual' ? 'manual' : pnSource === 'ocr' || nsSource === 'ocr' ? 'ocr' : 'barcode',
      confirmed: true,
      ...(patrimony.trim() ? { patrimony } : {}),
    });
    setSavedMessage(`NS ${normalizeCode(ns)} salvo no aparelho.`);
    clearCapture(keepPn);
    await refresh();
  }

  function openExport(all = false) {
    setExportAll(all);
    navigate('export');
  }

  async function exportFiles(format: ExportFormat, destination: 'folder' | 'share', workbook = 'report') {
    if (!repository || !user) throw new Error('Conta não disponível.');
    const selected = exportAll ? inventories.filter(entry => entry.count > 0) : current ? [current] : [];
    if (!selected.length) throw new Error('Nenhum inventário com unidades para exportar.');
    const entries: ExportEntry[] = [];
    for (const entry of selected) entries.push({ inventory: await repository.snapshot(user.sub, entry.id), partial: entry.state === 'draft' });
    let attachments;
    if (format === 'xlsx') {
      if (entries.length !== 1) throw new Error('Exporte as planilhas de um inventário por vez.');
      const service = await loadWorkbookService();
      attachments = (await service.export(entries[0]!.inventory, user, { partial: entries[0]!.partial })).attachments;
      if (destination === 'share') attachments = [attachments[workbook === 'sb1' ? 0 : 1]!];
    } else attachments = [await createDocument(entries, format)];
    if (destination === 'share') await shareDocument(attachments[0]!);
    else {
      const names = await saveWorkbookFiles(attachments, exportAll ? 'todos' : entries[0]!.inventory.id, entries.some(entry => entry.partial));
      if (names) Alert.alert('Arquivos salvos', `${names.length} arquivo(s) salvo(s) na pasta escolhida. A exportação não altera o envio pelo Gmail.`);
    }
  }

  async function importBackup() {
    if (!repository || !user) return;
    const entries = await chooseBackup();
    if (!entries) return;
    const owner = user.sub;
    Alert.alert('Restaurar backup?', `${entries.length} inventário(s) encontrado(s). Serão restaurados como coletas abertas, sem enviar e-mails. IDs já existentes serão ignorados.`, [
      { text: 'Cancelar', style: 'cancel' },
      { text: 'Restaurar', onPress: () => { void run(async () => {
        if (userRef.current?.sub !== owner) throw new Error('A conta mudou. Selecione o backup novamente.');
        const result = await repository.importInventories(owner, entries.map(entry => entry.inventory));
        await refresh();
        Alert.alert('Backup restaurado', `${result.imported} importado(s); ${result.skipped} já existente(s). Confira antes de concluir qualquer envio.`);
      }); } },
    ]);
  }

  function confirmFinish() {
    if (!repository || !user || !current) return;
    Alert.alert('Concluir inventário?', `As ${items.length} unidades serão bloqueadas para edição. O app enviará o relatório completo em PDF e as duas planilhas Excel pelo seu Gmail para ${RECIPIENT} quando estiver aberto e conectado. Campos de cadastro pendentes precisam de revisão antes da importação.`, [
      { text: 'Continuar coleta', style: 'cancel' },
      { text: 'Concluir e enviar', onPress: () => { void run(async () => {
        await repository.finish(user.sub, current.id);
        setScreen('inventory');
        await refresh();
        if (online && outbox) { await outbox.sync(user.sub); await refresh(); }
      }); } },
    ]);
  }

  function removeItem(item: InventoryItem) {
    if (!repository || !user || !current) return;
    Alert.alert('Remover leitura?', `NS ${item.ns} será retirado desta coleta.`, [
      { text: 'Manter', style: 'cancel' },
      { text: 'Remover', style: 'destructive', onPress: () => { void run(async () => { await repository.remove(user.sub, current.id, item.id); await refresh(); }); } },
    ]);
  }

  function confirmDeleteInventory() {
    if (!repository || !user || !current || busyRef.current) return;
    const owner = user.sub;
    const id = current.id;
    const deliveryNote = current.state === 'queued'
      ? 'O envio pendente será cancelado. Se o envio já tiver começado, aguarde sua conclusão.'
      : current.state === 'uncertain'
        ? 'O envio está sem confirmação. Confira a pasta Enviados do Gmail antes de excluir.'
        : 'E-mails já enviados e arquivos exportados serão mantidos.';
    Alert.alert('Excluir inventário?', `“${current.title}” e suas ${current.count} unidade(s) serão apagados deste aparelho. Esta ação não pode ser desfeita.\n\n${deliveryNote}`, [
      { text: 'Cancelar', style: 'cancel' },
      ...(current.count > 0 ? [{ text: 'Exportar antes', onPress: () => openExport() }] : []),
      { text: 'Excluir', style: 'destructive', onPress: () => { void run(async () => {
        if (userRef.current?.sub !== owner) throw new Error('A conta mudou. Abra o inventário novamente.');
        await repository.deleteInventory(owner, id);
        ++refreshSequence.current;
        visibleDataKey.current = `${owner}:`;
        setSelectedId(null);
        setItems([]);
        setInventories(previous => previous.filter(entry => entry.id !== id));
        setSearch('');
        setScanner(null);
        setScreen('home');
      }); } },
    ]);
  }

  function retrySend(allowUncertain: boolean) {
    if (!outbox || !user || !current) return;
    const owner = user.sub;
    const id = current.id;
    const send = () => { void run(async () => {
      try { await outbox.retry(owner, id, allowUncertain); }
      finally { await refresh(); }
    }); };
    if (!allowUncertain) { send(); return; }
    Alert.alert('Reenviar este inventário?', `Abra a pasta Enviados do seu Gmail e procure “Inventário Ytech: ${current.title}”. Se a mensagem já estiver lá, não reenvie: a Lorena receberia uma cópia duplicada.`, [
      { text: 'Não reenviar', style: 'cancel' },
      { text: 'Não está em Enviados, reenviar', style: 'destructive', onPress: send },
    ]);
  }

  function navigate(destination: typeof screen) { if (busyRef.current) return; setError(null); setScreen(destination); }
  const receipt = useMemo(() => {
    if (!current?.receipt) return null;
    try {
      const parsed = receiptSchema.safeParse(JSON.parse(current.receipt));
      return parsed.success ? parsed.data : null;
    } catch { return null; }
  }, [current?.receipt]);
  const pendingProducts = current ? new Set(items.filter(item => !knownPns.has(item.pn)).map(item => item.pn)).size : 0;

  if (loading) return <SafeAreaView style={[styles.screen, { justifyContent: 'center', alignItems: 'center' }]}><ActivityIndicator size="large" color={colors.blue} /><Text style={styles.body}>Abrindo dados salvos…</Text></SafeAreaView>;

  return <SafeAreaView style={styles.screen}>
    <StatusBar barStyle="dark-content" backgroundColor={colors.white} />
    <View style={styles.header}>
      <Pressable accessibilityRole="button" accessibilityLabel="Ir para inventários" onPress={() => navigate('home')}><Text style={styles.brand}>Ytech Invent</Text></Pressable>
      <Text style={[styles.pill, !online && { color: colors.amber, backgroundColor: '#FFF3DC' }]}>{online ? 'Conectado' : 'Offline'}</Text>
    </View>
    {error && <View style={{ padding: 14, gap: 8 }}><Notice error>{error}</Notice><Button title="Fechar aviso" secondary onPress={() => setError(null)} /></View>}
    {busy && <ActivityIndicator color={colors.blue} accessibilityLabel="Processando" style={{ padding: 8 }} />}
    {!user ? <ScrollView contentContainerStyle={[styles.content, { flexGrow: 1, justifyContent: 'center' }]}>
      <View style={{ flexDirection: 'row', height: 58, gap: 5, marginBottom: 14 }} accessibilityElementsHidden>
        {[5, 12, 5, 5, 15, 7, 4, 11, 4, 13, 6, 4].map((width, index) => <View key={index} style={{ width, backgroundColor: colors.blue, borderRadius: 1 }} />)}
      </View>
      <Text style={[styles.heading, { fontSize: 35 }]}>Cada equipamento.{'\n'}Cada número de série.</Text>
      <Text style={styles.body}>Leia, confira e registre o estoque da Ytech para a mudança de sistema. As leituras ficam salvas neste aparelho, mesmo sem internet.</Text>
      {configError && <Notice>{configError} Consulte a configuração do projeto com o administrador.</Notice>}
      {!repository && <Notice error>Falha ao abrir o armazenamento. Não inicie leituras sem corrigir esse erro.</Notice>}
      <Button title="Entrar com Google" disabled={busy || !online || !!configError || !repository} onPress={() => { void run(signIn); }} />
      <Text style={styles.body}>Acesso exclusivo @{COMPANY_DOMAIN}. O primeiro acesso precisa de internet. O app pede permissão para enviar o inventário pelo seu Gmail; ele não lê seus e-mails.</Text>
    </ScrollView> : <>
      {screen === 'home' && <FlatList data={visibleInventories} keyExtractor={item => item.id} contentContainerStyle={styles.content}
        ListHeaderComponent={<View style={{ gap: 16 }}>
          <Text style={styles.heading}>Inventários</Text>
          <Text style={styles.body}>{user.name}, retome uma coleta ou comece por uma localização do estoque.</Text>
          {!catalog && !catalogError && <Notice>Carregando o catálogo de produtos…</Notice>}
          {catalogError && <Notice error>{catalogError}</Notice>}
          <Button title="Iniciar inventário" disabled={!catalog || busy} onPress={() => { setTitle(''); setLocation(''); setKind('internal'); setClientName(''); setClientCnpj(''); navigate('new'); }} />
          <Field label="Buscar inventário" value={inventorySearch} onChangeText={setInventorySearch} placeholder="Nome, cliente, CNPJ ou localização" />
        </View>}
        ListEmptyComponent={<View style={[styles.panel, { marginTop: 22 }]}><Text style={styles.subheading}>Pronto para a primeira coleta</Text><Text style={styles.body}>Identifique a localização, leia o PN e depois o NS de cada equipamento.</Text></View>}
        renderItem={({ item }) => <Pressable accessibilityRole="button" disabled={busy} onPress={() => { setItems([]); setSearch(''); setSelectedId(item.id); navigate('inventory'); }} style={styles.item}>
          <Text style={styles.subheading}>{item.title}</Text>
          {item.organization && <Text style={styles.body}>{item.organization.kind === 'internal' ? 'Interno' : 'Externo'} · {item.organization.name} · {formatCnpj(item.organization.cnpj)}</Text>}
          <Text style={styles.body}>{item.location} · {item.count} {item.count === 1 ? 'unidade' : 'unidades'}</Text>
          <Text style={{ color: item.state === 'sent' ? colors.green : item.state === 'draft' ? colors.blue : colors.amber, fontWeight: '700' }}>{labels[item.state]}</Text>
          <Text style={styles.body}>{new Date(item.startedAt).toLocaleString('pt-BR')}</Text>
        </Pressable>} />}
      {(screen === 'new' || screen === 'edit') && <KeyboardAvoidingView style={{ flex: 1 }} behavior="height"><ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
        <Text style={styles.heading}>{screen === 'edit' ? 'Editar identificação' : 'Nova coleta'}</Text>
        <OrganizationFields kind={kind} onKind={setKind} name={clientName} onName={setClientName} cnpj={clientCnpj} onCnpj={setClientCnpj} internalCnpj={YTECH_CNPJ} busy={busy} />
        <Field label="Nome do inventário" value={title} onChangeText={setTitle} placeholder="Ex.: Estoque principal · outubro" maxLength={120} />
        <Field label="Localização inicial" value={location} onChangeText={setLocation} placeholder="Ex.: MZ01-E01-N01" maxLength={120} autoCapitalize="characters" />
        <Text style={styles.body}>Endereços do modelo. Escolha um ou informe a localização real:</Text>
        {catalog?.locations.map(address => <Button key={address} title={address} secondary onPress={() => setLocation(address)} />)}
        <Notice>A localização física não preenche automaticamente o armazém B1_LOCPAD do TOTVS.</Notice>
        {screen === 'edit' && <Text style={styles.body}>Os itens já salvos mantêm suas localizações. Esta localização será sugerida nas próximas leituras.</Text>}
        <Button title={screen === 'edit' ? 'Salvar identificação' : 'Começar coleta'} disabled={busy || !title.trim() || !location.trim() || (kind === 'external' && (!clientName.trim() || !isValidCnpj(clientCnpj)))} onPress={() => { void run(createInventory); }} />
        <Button title="Voltar" secondary onPress={() => navigate(screen === 'edit' ? 'inventory' : 'home')} />
      </ScrollView></KeyboardAvoidingView>}
      {screen === 'inventory' && current && <>
        <FlatList data={visibleItems} keyExtractor={item => item.id} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled"
          ListHeaderComponent={<View style={{ gap: 14 }}>
            <Text style={styles.heading}>{current.title}</Text>
            {current.organization && <Text selectable style={styles.body}>{current.organization.kind === 'internal' ? 'Interno' : 'Externo'} · {current.organization.name}{'\n'}CNPJ: {formatCnpj(current.organization.cnpj)}</Text>}
            <Text style={styles.body}>{current.location} · {items.length} unidades</Text>
            <Text style={[styles.pill, { alignSelf: 'flex-start' }]}>{labels[current.state]}</Text>
            {current.state === 'draft' && <>
              {(!inventoryTextSchema.safeParse(current.title).success || !inventoryTextSchema.safeParse(current.location).success) &&
                <Notice>A identificação salva contém caracteres inválidos. Edite-a antes de concluir; suas leituras estão preservadas.</Notice>}
              <Button title="Editar identificação" secondary disabled={busy} onPress={() => { setTitle(current.title); setLocation(current.location); setKind(current.organization?.kind ?? 'internal'); setClientName(current.organization?.kind === 'external' ? current.organization.name : ''); setClientCnpj(current.organization?.kind === 'external' ? formatCnpj(current.organization.cnpj) : ''); navigate('edit'); }} />
            </>}
            {!!pendingProducts && <Notice>{pendingProducts} PN fora do catálogo. Eles constarão no inventário como pendências, não no arquivo SB1.</Notice>}
            {!!current.lastError && <Notice error>{current.lastError}</Notice>}
            {!!current.receipt && !receipt && <Notice error>O comprovante local não pôde ser lido. Confira a pasta Enviados antes de repetir qualquer envio; as unidades continuam salvas.</Notice>}
            {receipt && <Notice>{receipt.message}{'\n'}{receipt.warnings.slice(0, 6).join('\n')}{receipt.warnings.length > 6 ? `\nMais ${receipt.warnings.length - 6} avisos no relatório.` : ''}</Notice>}
            {current.state === 'queued' && <Notice>Leituras preservadas. O envio pelo seu Gmail é tentado com este aplicativo aberto e conectado. Fechar o app pausa as tentativas.</Notice>}
            {current.state === 'sending' && <Notice>Enviando pelo seu Gmail. Mantenha o aplicativo aberto até concluir.</Notice>}
            {current.state === 'uncertain' && <Notice>Não foi possível confirmar se o e-mail saiu. Confira a pasta Enviados do seu Gmail antes de reenviar.</Notice>}
            {current.state === 'sent' && <Text style={styles.body}>A mensagem está na pasta Enviados do seu Gmail. O envio não confirma a leitura pela destinatária.</Text>}
            {current.state === 'failed' && <Button title="Tentar envio novamente" disabled={busy || !online} onPress={() => retrySend(false)} />}
            {current.state === 'uncertain' && <Button title="Reenviar após conferir Enviados" secondary disabled={busy || !online} onPress={() => retrySend(true)} />}
            {!!items.length && <Button title="Exportar ou compartilhar arquivo" secondary disabled={busy} onPress={() => openExport()} />}
            <Button title="Excluir inventário" danger disabled={busy || current.state === 'sending'} onPress={confirmDeleteInventory} />
            {!!items.length && <Field label="Buscar unidade" value={search} onChangeText={setSearch} placeholder="PN, número de série ou localização" autoCorrect={false} />}
          </View>}
          ListEmptyComponent={<Text style={[styles.body, { paddingVertical: 28 }]}>{items.length ? 'Nenhuma unidade corresponde à busca.' : 'Nenhum item contado. Toque em Ler equipamento.'}</Text>}
          renderItem={({ item }) => <View style={styles.item}>
            <Text selectable style={styles.code}>{item.pn}</Text>
            <Text selectable style={styles.code}>NS {item.ns}</Text>
            {!!item.patrimony && <Text selectable style={styles.body}>Patrimônio: {item.patrimony}</Text>}
            <Text style={styles.body}>{item.location} · 1 unidade</Text>
            {!knownPns.has(item.pn) && <Text style={{ color: colors.amber }}>PN pendente de cadastro</Text>}
            {current.state === 'draft' && <Button title="Remover leitura" secondary disabled={busy} onPress={() => removeItem(item)} />}
          </View>} />
        {current.state === 'draft' && <View style={styles.footer}>
          <Button title="Ler equipamento" disabled={busy} onPress={startScanning} />
          <View style={styles.row}>
            <View style={{ flex: 1 }}><Button title="Digitar" secondary disabled={busy} onPress={() => openManualForm()} /></View>
            <View style={{ flex: 1 }}><Button title="Revisar e concluir" secondary disabled={busy || !items.length} onPress={() => navigate('review')} /></View>
          </View>
        </View>}
      </>}
      {screen === 'review' && current && <InventoryReview title={current.title} organization={current.organization} items={items} catalog={catalog} busy={busy} online={online}
        onFinish={confirmFinish} onExport={() => openExport()} onBack={() => navigate('inventory')} />}
      {screen === 'export' && <ExportScreen title={exportAll ? 'Todos os inventários com unidades desta conta' : current?.title ?? ''} all={exportAll}
        partial={exportAll ? inventories.some(entry => entry.count > 0 && entry.state === 'draft') : current?.state === 'draft'} busy={busy}
        onExport={(format, destination, workbook) => { void run(() => exportFiles(format, destination, workbook)); }}
        onBack={() => navigate(exportAll ? 'account' : 'inventory')} />}
      {screen === 'capture' && current && <KeyboardAvoidingView style={{ flex: 1 }} behavior="height"><ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
        <Text style={styles.heading}>Digitar ou corrigir</Text>
        <Text style={styles.body}>Uma unidade por número de série. Confira ambos os campos antes de salvar.</Text>
        {!!savedMessage && <View style={[styles.notice, { backgroundColor: '#E3F2ED' }]}><Text accessibilityLiveRegion="polite" style={{ color: colors.green }}>{savedMessage}</Text></View>}
        <Button title="Ler etiqueta com a câmera" secondary disabled={busy} onPress={() => setScanner('fill')} />
        <View style={styles.panel}>
          <Field label="PN · Part number" value={pn} onChangeText={value => { setPn(value); setRawPn(value); setPnSource('manual'); setConfirmed(false); }} autoCorrect={false} autoCapitalize="characters" maxLength={120} style={styles.code} placeholder="Leia ou digite o PN" />
          {product ? <><Text style={styles.subheading}>{product.description}</Text><Text style={styles.body}>Código TOTVS: {product.code || 'não informado'}</Text>{!!product.issues.length && <Notice>{product.issues.join('\n')}</Notice>}</>
            : pn ? <Notice>PN não encontrado no catálogo. O item será salvo como pendência, sem gerar cadastro SB1 automaticamente.</Notice> : null}
          {!product && matchingProducts(catalog?.products ?? [], pn).slice(0, 5).map(match => <Button key={match.pn} title={`${match.pn}\n${match.description}`} secondary onPress={() => { setPn(match.pn); setRawPn(match.pn); setPnSource('manual'); setConfirmed(false); }} />)}
        </View>
        <View style={styles.panel}>
          <Field label="NS · Número de série" value={ns} onChangeText={value => { setNs(value); setRawNs(value); setNsSource('manual'); setConfirmed(false); }} autoCorrect={false} autoCapitalize="characters" maxLength={80} style={styles.code} placeholder="Leia ou digite o NS" />
          {items.some(item => item.ns === normalizeCode(ns)) && <Notice error>Este NS já foi contado neste inventário.</Notice>}
        </View>
        <Field label="Localização desta unidade" value={location} onChangeText={setLocation} autoCapitalize="characters" maxLength={120} />
        <Field label="Patrimônio (opcional)" value={patrimony} onChangeText={setPatrimony} autoCapitalize="characters" autoCorrect={false} maxLength={80} />
        <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: keepPn }} onPress={() => setKeepPn(!keepPn)} style={[styles.row, { minHeight: 48 }]}>
          <Text style={{ fontSize: 24, color: colors.blue }}>{keepPn ? '☑' : '☐'}</Text><Text style={[styles.body, { flex: 1 }]}>Manter este PN para a próxima unidade</Text>
        </Pressable>
        <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: confirmed }} onPress={() => setConfirmed(!confirmed)} style={[styles.row, { minHeight: 54 }]}>
          <Text style={{ fontSize: 24, color: colors.blue }}>{confirmed ? '☑' : '☐'}</Text><Text style={[styles.label, { flex: 1 }]}>Conferi PN e NS na etiqueta do mesmo equipamento</Text>
        </Pressable>
        <Button title="Salvar unidade" disabled={busy || !confirmed || !pn || !ns || !location.trim()} onPress={() => { void run(saveItem); }} />
        <Button title="Voltar ao inventário" secondary disabled={busy} onPress={() => navigate('inventory')} />
      </ScrollView></KeyboardAvoidingView>}
      {screen === 'account' && <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.heading}>Conta e dados</Text>
        <Text style={styles.subheading}>{user.name}</Text><Text selectable style={styles.body}>{user.email}</Text>
        <View style={styles.panel}><Text style={styles.subheading}>{YTECH_NAME}</Text><Text selectable style={styles.body}>CNPJ: {formatCnpj(YTECH_CNPJ)}{'\n'}Usado automaticamente nos inventários internos.</Text></View>
        <Button title="Exportar todos os inventários com unidades" secondary disabled={busy || !inventories.some(entry => entry.count > 0)} onPress={() => openExport(true)} />
        <Button title="Restaurar backup JSON do Ytech Invent" secondary disabled={busy} onPress={() => { void run(importBackup); }} />
        <View style={styles.panel}><Text style={styles.subheading}>Destino dos inventários</Text><Text selectable style={styles.body}>{RECIPIENT}</Text><Text style={styles.body}>O envio sai da sua conta Google e fica na sua pasta Enviados. Três anexos: relatório completo em PDF, inventário Excel com séries, quantidades e pendências, e cadastro SB1 no modelo original.</Text></View>
        <Text style={styles.body}>{catalog ? `${catalog.products.length} PN no catálogo desta versão do app.` : catalogError ?? 'Carregando catálogo…'} As leituras ficam somente neste aparelho até o envio. Desinstalar o app ou limpar seus dados remove coletas ainda não enviadas.</Text>
        {catalog && !!catalog.warnings.length && <Notice>{catalog.warnings.slice(0, 8).join('\n')}{catalog.warnings.length > 8 ? '\nDemais pendências serão detalhadas no relatório.' : ''}</Notice>}
        <Button title="Entrar novamente com Google" secondary disabled={busy || !online} onPress={() => { void run(signIn); }} />
        <Button title="Sair desta conta" secondary disabled={busy} onPress={() => {
          Alert.alert('Sair da conta?', 'As coletas permanecem neste aparelho, vinculadas a esta conta. Entre novamente com a mesma conta para retomá-las.', [
            { text: 'Permanecer', style: 'cancel' },
            { text: 'Sair', onPress: () => { void run(async () => { await logout(); setUser(null); setInventories([]); setItems([]); setSelectedId(null); setScreen('home'); }); } },
          ]);
        }} />
      </ScrollView>}
      {screen !== 'capture' && <View style={[styles.footer, styles.row]}>
        <View style={{ flex: 1 }}><Button title="Inventários" secondary onPress={() => navigate('home')} /></View>
        <View style={{ flex: 1 }}><Button title="Conta" secondary onPress={() => navigate('account')} /></View>
      </View>}
    </>}
    {scanner && current && <UnitScanner active={active} catalogPns={catalogPns} savedSerials={savedSerials}
      describe={value => catalog?.products.find(item => item.pn === value)?.description}
      location={location.trim() || current.location}
      lockedPn={scanner === 'save' ? lockedPn : null}
      onUnlockPn={() => setLockedPn(null)}
      onClose={() => setScanner(null)}
      onManual={openManualForm}
      {...(scanner === 'save'
        ? { onSave: saveScanned }
        : { onUse: (unit: ScannedUnit) => {
          setPn(unit.pn.value); setRawPn(unit.pn.raw); setPnSource(unit.pn.source);
          setNs(unit.ns.value); setRawNs(unit.ns.raw); setNsSource(unit.ns.source);
          setConfirmed(false); setScanner(null);
        } })} />}
  </SafeAreaView>;
}

export default function App() {
  return <SafeAreaProvider><ErrorBoundary>
    <Application />
  </ErrorBoundary></SafeAreaProvider>;
}
