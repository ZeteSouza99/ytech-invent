import { useCallback, useEffect, useMemo, useReducer, useState } from 'react';
import { ActivityIndicator, Alert, BackHandler, Pressable, StatusBar, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { randomUUID } from 'expo-crypto';
import { errorMessage, RECIPIENT, type InventoryItem, type Product } from './shared/model';
import { formatCnpj, organizationSchema, YTECH_CNPJ, YTECH_NAME } from './shared/company';
import { configurationError } from './src/google';
import { loadWorkbookService } from './src/catalog';
import type { InventorySummary, UnitChanges } from './src/repository';
import { UnitScanner, type ScannedUnit } from './src/UnitScanner';
import { Button, colors, Notice, styles } from './src/ui';
import { InventoryReview } from './src/InventoryReview';
import { ErrorBoundary } from './src/ErrorBoundary';
import { saveWorkbookFiles } from './src/exportFiles';
import { ExportScreen } from './src/ExportScreen';
import { chooseBackup, createDocument, shareDocument } from './src/shareExport';
import type { ExportEntry, ExportFormat } from './src/exportFormats';
import { describeFrom } from './shared/report';
import {
  useBusyAction, useCatalogState, useConnectivity, useCountedPartNumbers, useInventoryData, useOutboxSync, useServices, useSession,
} from './src/app/hooks';
import { initialNavigation, navigationReducer, type Screen } from './src/app/navigation';
import { LoginScreen } from './src/screens/LoginScreen';
import { HomeScreen } from './src/screens/HomeScreen';
import { InventoryFormScreen, type InventoryFormValues } from './src/screens/InventoryFormScreen';
import { InventoryScreen } from './src/screens/InventoryScreen';
import { ManualEntryScreen, type ManualEntry } from './src/screens/ManualEntryScreen';
import { EditUnitScreen } from './src/screens/EditUnitScreen';
import { AccountScreen } from './src/screens/AccountScreen';

const EMPTY_FORM: InventoryFormValues = { title: '', location: '', kind: 'internal', clientName: '', clientCnpj: '' };

function formValues(inventory: InventorySummary): InventoryFormValues {
  const external = inventory.organization?.kind === 'external' ? inventory.organization : null;
  return {
    title: inventory.title, location: inventory.location, kind: inventory.organization?.kind ?? 'internal',
    clientName: external?.name ?? '', clientCnpj: external ? formatCnpj(external.cnpj) : '',
  };
}

function Application() {
  const { busy, busyRef, error, setError, run } = useBusyAction();
  const storage = useServices();
  const session = useSession(setError);
  const catalogState = useCatalogState();
  const { online, active } = useConnectivity();
  const repository = storage.services?.repository ?? null;
  const outbox = storage.services?.outbox ?? null;
  const user = session.user;
  const owner = user?.sub ?? null;
  const data = useInventoryData(repository, owner, setError);
  const counted = useCountedPartNumbers(repository, owner, setError);
  useOutboxSync(outbox, owner, online, active, data.reloadList, setError);

  const [navigation, dispatch] = useReducer(navigationReducer, initialNavigation);
  const [inventorySearch, setInventorySearch] = useState('');
  const [search, setSearch] = useState('');
  const [form, setForm] = useState<InventoryFormValues>(EMPTY_FORM);
  // Location suggested for the next units; shared by the camera and the manual form.
  const [unitLocation, setUnitLocation] = useState('');
  const [scanning, setScanning] = useState(false);
  const [lockedPn, setLockedPn] = useState<string | null>(null);
  const [manual, setManual] = useState<{ key: number; unit: Partial<ScannedUnit> }>({ key: 0, unit: {} });

  const { catalog } = catalogState;
  const { current, items, inventories } = data;
  const screen = navigation.screen;
  const productsByPn = useMemo(() => new Map<string, Product>(catalog?.products.map(product => [product.pn, product]) ?? []), [catalog]);
  const knownPns = useMemo(() => new Set(productsByPn.keys()), [productsByPn]);
  const catalogPns = useMemo(() => catalog?.products.map(product => product.pn) ?? [], [catalog]);
  const savedSerials = useMemo(() => new Set(items.map(item => item.ns)), [items]);
  const describe = useCallback((pn: string) => productsByPn.get(pn)?.description, [productsByPn]);
  const editingUnit = items.find(item => item.id === navigation.unitId);
  const configError = configurationError();
  const reportError = useCallback((failure: unknown) => setError(errorMessage(failure)), [setError]);

  useEffect(() => {
    if (storage.services?.storageWarning) setError(storage.services.storageWarning);
  }, [storage.services, setError]);

  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (busy) return true;
      if (screen === 'home' || !user) return false;
      setError(null);
      dispatch({ type: 'back' });
      return true;
    });
    return () => subscription.remove();
  }, [busy, screen, user, setError]);

  function go(destination: Exclude<Screen, 'export' | 'unit'>) {
    if (busyRef.current) return;
    setError(null);
    dispatch({ type: 'go', screen: destination });
  }

  function openExport(all = false) {
    if (busyRef.current) return;
    setError(null);
    dispatch({ type: 'export', all });
  }

  async function signIn() {
    if (!repository) throw new Error('O armazenamento local não está disponível. Reinicie o aplicativo.');
    await session.signIn();
    setSearch('');
    setInventorySearch('');
    dispatch({ type: 'go', screen: 'home' });
  }

  function signOut() {
    Alert.alert('Sair da conta?', 'As coletas permanecem neste aparelho, vinculadas a esta conta. Entre novamente com a mesma conta para retomá-las.', [
      { text: 'Permanecer', style: 'cancel' },
      { text: 'Sair', onPress: () => { void run(async () => { await session.signOut(); dispatch({ type: 'go', screen: 'home' }); }); } },
    ]);
  }

  function startInventory() {
    setForm(EMPTY_FORM);
    go('new');
  }

  function editIdentification() {
    if (!current) return;
    setForm(formValues(current));
    go('edit');
  }

  async function submitForm(values: InventoryFormValues) {
    const organization = organizationSchema.parse(values.kind === 'internal'
      ? { kind: 'internal', name: YTECH_NAME, cnpj: YTECH_CNPJ }
      : { kind: 'external', name: values.clientName, cnpj: values.clientCnpj });
    if (screen === 'edit') {
      if (!repository || !owner || !current) throw new Error('Inventário não disponível.');
      await repository.updateMetadata(owner, current.id, { title: values.title, location: values.location, organization });
      // The edited location is the one suggested for the next units.
      setUnitLocation(values.location);
      await data.reloadList();
      dispatch({ type: 'go', screen: 'inventory' });
      return;
    }
    if (!repository || !owner || !catalog) throw new Error('Aguarde o catálogo de produtos carregar antes de iniciar.');
    const id = randomUUID();
    await repository.create({
      id, owner, title: values.title, location: values.location, startedAt: new Date().toISOString(), completedAt: null,
      catalogVersion: catalog.version, state: 'draft', receipt: null, lastError: '', organization,
    });
    setUnitLocation(values.location);
    setSearch('');
    data.select(id);
    dispatch({ type: 'go', screen: 'inventory' });
    await data.reloadList();
  }

  function openInventory(id: string) {
    if (busyRef.current) return;
    setSearch('');
    // A location typed for units of another inventory must not be suggested here.
    setUnitLocation(inventories.find(entry => entry.id === id)?.location ?? '');
    data.select(id);
    go('inventory');
  }

  function startScanning() {
    if (!current) return;
    setUnitLocation(current.location);
    setLockedPn(null);
    setScanning(true);
  }

  function openManualForm(unit: Partial<ScannedUnit> = {}) {
    if (!current) return;
    if (!unitLocation.trim()) setUnitLocation(current.location);
    setManual(previous => ({ key: previous.key + 1, unit }));
    setScanning(false);
    dispatch({ type: 'go', screen: 'capture' });
  }

  // The list only carries counts; the unit itself is added to the screen without reloading every unit.
  function unitSaved(inventoryId: string, item: InventoryItem) {
    data.changeItems(inventoryId, previous => [item, ...previous]);
    counted.remember(item.pn);
    data.reloadList().catch(reportError);
  }

  async function saveScanned(unit: ScannedUnit, keep: boolean): Promise<string> {
    if (!repository || !owner || !current) throw new Error('Inventário não disponível.');
    const item = await repository.add(owner, current.id, {
      id: randomUUID(), pn: unit.pn.value, ns: unit.ns.value, rawPn: unit.pn.raw, rawNs: unit.ns.raw,
      location: unitLocation.trim() || current.location, quantity: 1, capturedAt: new Date().toISOString(),
      source: unit.pn.source === 'barcode' && unit.ns.source === 'barcode' ? 'barcode' : 'ocr',
      // The user confirmed by tapping "Salvar unidade" with both values on screen.
      confirmed: true,
    });
    if (keep) setLockedPn(unit.pn.value);
    unitSaved(current.id, item);
    return `NS ${unit.ns.value} salvo. Aponte para o próximo equipamento.`;
  }

  function saveManual(entry: ManualEntry): Promise<boolean> {
    return run(async () => {
      if (!repository || !owner || !current) throw new Error('Inventário não disponível.');
      const item = await repository.add(owner, current.id, {
        id: randomUUID(), pn: entry.pn, ns: entry.ns, rawPn: entry.rawPn, rawNs: entry.rawNs, location: unitLocation,
        quantity: 1, capturedAt: new Date().toISOString(), source: entry.source, confirmed: true,
        ...(entry.patrimony.trim() ? { patrimony: entry.patrimony } : {}),
      });
      unitSaved(current.id, item);
    });
  }

  function saveUnit(changes: UnitChanges) {
    void run(async () => {
      if (!repository || !owner || !current || !navigation.unitId) throw new Error('Unidade não disponível.');
      const item = await repository.updateItem(owner, current.id, navigation.unitId, changes);
      data.changeItems(current.id, previous => previous.map(entry => entry.id === item.id ? item : entry));
      dispatch({ type: 'go', screen: 'inventory' });
    });
  }

  function removeItem(item: InventoryItem) {
    if (!repository || !owner || !current) return;
    const id = current.id;
    Alert.alert('Remover leitura?', `NS ${item.ns} será retirado desta coleta.`, [
      { text: 'Manter', style: 'cancel' },
      { text: 'Remover', style: 'destructive', onPress: () => { void run(async () => {
        await repository.remove(owner, id, item.id);
        data.changeItems(id, previous => previous.filter(entry => entry.id !== item.id));
        data.reloadList().catch(reportError);
      }); } },
    ]);
  }

  async function exportFiles(format: ExportFormat, destination: 'folder' | 'share') {
    if (!repository || !owner) throw new Error('Conta não disponível.');
    const selected = navigation.exportAll ? inventories.filter(entry => entry.count > 0) : current ? [current] : [];
    if (!selected.length) throw new Error('Nenhum inventário com unidades para exportar.');
    const entries: ExportEntry[] = [];
    for (const entry of selected) entries.push({ inventory: await repository.snapshot(owner, entry.id), partial: entry.state === 'draft' });
    const service = await loadWorkbookService();
    const attachment = format === 'xlsx'
      ? await service.spreadsheet(entries)
      : await createDocument(entries, format, describeFrom(service.catalog.products));
    if (destination === 'share') await shareDocument(attachment);
    else {
      const names = await saveWorkbookFiles([attachment], navigation.exportAll ? 'todos' : entries[0]!.inventory.id, entries.some(entry => entry.partial));
      if (names) Alert.alert('Arquivo salvo', `${names[0]} salvo na pasta escolhida. A exportação não altera o envio pelo Gmail.`);
    }
  }

  async function importBackup() {
    if (!repository || !owner) return;
    const entries = await chooseBackup();
    if (!entries) return;
    Alert.alert('Restaurar backup?', `${entries.length} inventário(s) encontrado(s). Serão restaurados como coletas abertas, sem enviar e-mails. IDs já existentes serão ignorados.`, [
      { text: 'Cancelar', style: 'cancel' },
      { text: 'Restaurar', onPress: () => { void run(async () => {
        if (session.userRef.current?.sub !== owner) throw new Error('A conta mudou. Selecione o backup novamente.');
        const result = await repository.importInventories(owner, entries.map(entry => entry.inventory));
        await data.reloadList();
        await counted.reload();
        Alert.alert('Backup restaurado', `${result.imported} importado(s); ${result.skipped} já existente(s). Confira antes de concluir qualquer envio.`);
      }); } },
    ]);
  }

  async function importCatalog() {
    const loaded = await catalogState.importFromFile();
    if (loaded) Alert.alert('Catálogo importado', `${loaded.service.catalog.products.length} PN carregados. O novo catálogo vale para as próximas leituras e exportações.`);
  }

  function restoreCatalog() {
    Alert.alert('Voltar ao catálogo embutido?', 'O catálogo importado será apagado deste aparelho. As coletas e leituras não mudam.', [
      { text: 'Cancelar', style: 'cancel' },
      { text: 'Voltar ao embutido', onPress: () => { void run(async () => { await catalogState.restoreBundled(); }); } },
    ]);
  }

  function confirmFinish() {
    if (!repository || !owner || !current) return;
    const id = current.id;
    Alert.alert('Concluir inventário?', `As ${items.length} unidades serão bloqueadas para edição. O app enviará o relatório em PDF e a planilha Excel pelo seu Gmail para ${RECIPIENT} quando houver internet.`, [
      { text: 'Continuar coleta', style: 'cancel' },
      { text: 'Concluir e enviar', onPress: () => { void run(async () => {
        await repository.finish(owner, id);
        dispatch({ type: 'go', screen: 'inventory' });
        await data.reloadList();
        if (online && outbox) {
          try {
            await outbox.sync(owner);
          } finally {
            await data.reloadList();
          }
        }
      }); } },
    ]);
  }

  function confirmDeleteInventory() {
    if (!repository || !owner || !current || busyRef.current) return;
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
        if (session.userRef.current?.sub !== owner) throw new Error('A conta mudou. Abra o inventário novamente.');
        await repository.deleteInventory(owner, id);
        data.forgetInventory(id);
        setSearch('');
        setScanning(false);
        dispatch({ type: 'go', screen: 'home' });
      }); } },
    ]);
  }

  function retrySend(allowUncertain: boolean) {
    if (!outbox || !owner || !current) return;
    const id = current.id;
    const send = () => { void run(async () => {
      try { await outbox.retry(owner, id, allowUncertain); }
      finally { await data.reloadList(); }
    }); };
    if (!allowUncertain) { send(); return; }
    Alert.alert('Reenviar este inventário?', `Abra a pasta Enviados do seu Gmail e procure “Inventário Ytech: ${current.title}”. Se a mensagem já estiver lá, não reenvie: a Lorena receberia uma cópia duplicada.`, [
      { text: 'Não reenviar', style: 'cancel' },
      { text: 'Não está em Enviados, reenviar', style: 'destructive', onPress: send },
    ]);
  }

  if (storage.loading || session.restoring) {
    return <SafeAreaView style={[styles.screen, { justifyContent: 'center', alignItems: 'center' }]}><ActivityIndicator size="large" color={colors.blue} /><Text style={styles.body}>Abrindo dados salvos…</Text></SafeAreaView>;
  }

  return <SafeAreaView style={styles.screen}>
    <StatusBar barStyle="dark-content" backgroundColor={colors.white} />
    <View style={styles.header}>
      <Pressable accessibilityRole="button" accessibilityLabel="Ir para inventários" onPress={() => go('home')}><Text style={styles.brand}>Ytech Invent</Text></Pressable>
      <Text style={[styles.pill, !online && { color: colors.amber, backgroundColor: '#FFF3DC' }]}>{online ? 'Conectado' : 'Offline'}</Text>
    </View>
    {storage.failure && <View style={{ padding: 14 }}><Notice error>{storage.failure}</Notice></View>}
    {error && <View style={{ padding: 14, gap: 8 }}><Notice error>{error}</Notice><Button title="Fechar aviso" secondary onPress={() => setError(null)} /></View>}
    {busy && <ActivityIndicator color={colors.blue} accessibilityLabel="Processando" style={{ padding: 8 }} />}
    {/* Without local storage nothing can be read or saved: keep the entry screen, blocked, as before. */}
    {!user || !repository ? <LoginScreen busy={busy} online={online} configError={configError} storageReady={!!repository} onSignIn={() => { void run(signIn); }} /> : <>
      {screen === 'home' && <HomeScreen userName={user.name} inventories={inventories} search={inventorySearch} onSearch={setInventorySearch}
        catalogReady={!!catalog} catalogError={catalogState.catalogError} catalogWarning={catalogState.catalogWarning} busy={busy}
        onStart={startInventory} onOpen={openInventory} />}
      {(screen === 'new' || screen === 'edit') && <InventoryFormScreen key={screen} mode={screen} initial={form} locations={catalog?.locations ?? []} busy={busy}
        onSubmit={values => { void run(() => submitForm(values)); }} onBack={() => go(screen === 'edit' ? 'inventory' : 'home')} />}
      {screen === 'inventory' && current && <InventoryScreen inventory={current} items={items} search={search} onSearch={setSearch}
        knownPns={knownPns} busy={busy} online={online} onEditIdentification={editIdentification} onRetry={retrySend}
        onExport={() => openExport()} onDelete={confirmDeleteInventory} onRemoveItem={removeItem}
        onEditItem={item => { if (!busyRef.current) dispatch({ type: 'unit', id: item.id }); }}
        onScan={startScanning} onManual={() => openManualForm()} onReview={() => go('review')} />}
      {screen === 'review' && current && <InventoryReview title={current.title} organization={current.organization} items={items} catalog={catalog} busy={busy} online={online}
        onFinish={confirmFinish} onExport={() => openExport()} onBack={() => go('inventory')} />}
      {screen === 'export' && <ExportScreen title={navigation.exportAll ? 'Todos os inventários com unidades desta conta' : current?.title ?? ''}
        partial={navigation.exportAll ? inventories.some(entry => entry.count > 0 && entry.state === 'draft') : current?.state === 'draft'} busy={busy}
        onExport={(format, destination) => { void run(() => exportFiles(format, destination)); }}
        onBack={() => go(navigation.exportAll ? 'account' : 'inventory')} />}
      {screen === 'capture' && current && <ManualEntryScreen key={manual.key} initialUnit={manual.unit} catalog={catalog} productsByPn={productsByPn}
        catalogPns={catalogPns} countedPns={counted.pns} savedSerials={savedSerials} active={active} location={unitLocation} onLocation={setUnitLocation}
        inventoryLocation={current.location} busy={busy} onSave={saveManual} onBack={() => go('inventory')} />}
      {screen === 'unit' && current && editingUnit && <EditUnitScreen key={editingUnit.id} item={editingUnit} busy={busy}
        onSave={saveUnit} onBack={() => go('inventory')} />}
      {screen === 'account' && <AccountScreen user={user} catalog={catalog} catalogSource={catalogState.source} catalogError={catalogState.catalogError}
        catalogWarning={catalogState.catalogWarning} storageWarning={storage.services?.storageWarning ?? null} busy={busy} online={online}
        hasUnits={inventories.some(entry => entry.count > 0)} onExportAll={() => openExport(true)}
        onRestoreBackup={() => { void run(importBackup); }} onImportCatalog={() => { void run(importCatalog); }} onRestoreCatalog={restoreCatalog}
        onSignInAgain={() => { void run(signIn); }} onSignOut={signOut} />}
      {screen !== 'capture' && screen !== 'unit' && <View style={[styles.footer, styles.row]}>
        <View style={{ flex: 1 }}><Button title="Inventários" secondary onPress={() => go('home')} /></View>
        <View style={{ flex: 1 }}><Button title="Conta" secondary onPress={() => go('account')} /></View>
      </View>}
    </>}
    {scanning && current && <UnitScanner active={active} catalogPns={catalogPns} countedPns={counted.pns} savedSerials={savedSerials} describe={describe}
      location={unitLocation.trim() || current.location} lockedPn={lockedPn} onUnlockPn={() => setLockedPn(null)}
      onClose={() => setScanning(false)} onManual={openManualForm} onSave={saveScanned} />}
  </SafeAreaView>;
}

export default function App() {
  return <SafeAreaProvider><ErrorBoundary>
    <Application />
  </ErrorBoundary></SafeAreaProvider>;
}
