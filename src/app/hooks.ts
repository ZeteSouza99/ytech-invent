import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import { errorMessage, type Catalog, type InventoryItem, type User } from '../../shared/model';
import { disableBackgroundSending, enableBackgroundSending } from '../backgroundSend';
import { importCatalog, loadCatalog, restoreBundledCatalog, type CatalogSource, type LoadedCatalog } from '../catalog';
import { login, logout, restoreSession } from '../google';
import type { Outbox } from '../outbox';
import type { InventoryRepository, InventorySummary } from '../repository';
import { openForegroundServices, type Services } from '../services';

const SYNC_INTERVAL_MS = 30000;

// Runs one user action at a time; failures become the error banner instead of escaping.
export function useBusyAction() {
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async (action: () => Promise<void>): Promise<boolean> => {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await action();
      return true;
    } catch (failure) {
      setError(errorMessage(failure));
      return false;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, []);
  return { busy, busyRef, error, setError, run };
}

export function useServices() {
  const [services, setServices] = useState<Services | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let mounted = true;
    openForegroundServices()
      .then(value => { if (mounted) setServices(value); })
      .catch(error => { if (mounted) setFailure(errorMessage(error)); })
      .finally(() => { if (mounted) setLoading(false); });
    return () => { mounted = false; };
  }, []);
  return { services, failure, loading };
}

export function useSession(onError: (message: string) => void) {
  const [user, setUser] = useState<User | null>(null);
  const [restoring, setRestoring] = useState(true);
  const userRef = useRef<User | null>(null);
  userRef.current = user;
  const errorRef = useRef(onError);
  errorRef.current = onError;

  useEffect(() => {
    let mounted = true;
    restoreSession()
      .then(saved => { if (mounted) setUser(saved); })
      .catch(failure => {
        if (mounted) errorRef.current(`Não foi possível restaurar o login: ${errorMessage(failure)}. Entre novamente; suas coletas foram preservadas.`);
      })
      .finally(() => { if (mounted) setRestoring(false); });
    return () => { mounted = false; };
  }, []);

  // Sending in the background follows the session: active while someone is signed in.
  useEffect(() => {
    if (!user) return;
    enableBackgroundSending().catch(failure => {
      errorRef.current(`O envio em segundo plano não pôde ser ativado (${errorMessage(failure)}). O envio continua com o app aberto e conectado.`);
    });
  }, [user]);

  const signIn = useCallback(async () => {
    const signedIn = await login();
    setUser(signedIn);
  }, []);

  const signOut = useCallback(async () => {
    // Harmless if it fails: without a session the task sends nothing.
    await disableBackgroundSending().catch(() => undefined);
    await logout();
    setUser(null);
  }, []);

  return { user, userRef, restoring, signIn, signOut };
}

export function useCatalogState() {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [source, setSource] = useState<CatalogSource>('bundled');
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [catalogWarning, setCatalogWarning] = useState<string | null>(null);
  const apply = useCallback((loaded: LoadedCatalog) => {
    setCatalog(loaded.service.catalog);
    setSource(loaded.source);
    setCatalogWarning(loaded.warning);
    setCatalogError(null);
  }, []);

  useEffect(() => {
    let mounted = true;
    loadCatalog()
      .then(loaded => { if (mounted) apply(loaded); })
      .catch(failure => { if (mounted) setCatalogError(errorMessage(failure)); });
    return () => { mounted = false; };
  }, [apply]);

  const importFromFile = useCallback(async () => {
    const loaded = await importCatalog();
    if (loaded) apply(loaded);
    return loaded;
  }, [apply]);

  const restoreBundled = useCallback(async () => {
    const loaded = await restoreBundledCatalog();
    apply(loaded);
    return loaded;
  }, [apply]);

  return { catalog, source, catalogError, catalogWarning, importFromFile, restoreBundled };
}

export function useConnectivity() {
  const [online, setOnline] = useState(false);
  const [active, setActive] = useState(AppState.currentState === 'active');
  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener(state => setOnline(state.isConnected === true && state.isInternetReachable !== false));
    const subscription = AppState.addEventListener('change', state => setActive(state === 'active'));
    return () => { unsubscribe(); subscription.remove(); };
  }, []);
  return { online, active };
}

// Keeps the visible data of one account. Responses that arrive after the account or the open inventory
// changed are discarded, and local changes never wait for a reload of every unit.
export function useInventoryData(repository: InventoryRepository | null, owner: string | null, onError: (message: string) => void) {
  const [inventories, setInventories] = useState<InventorySummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [items, setItems] = useState<InventoryItem[]>([]);
  const listSequence = useRef(0);
  const itemsSequence = useRef(0);
  const itemsInFlight = useRef(0);
  const ownerRef = useRef(owner);
  ownerRef.current = owner;
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;
  const errorRef = useRef(onError);
  errorRef.current = onError;

  const reloadList = useCallback(async () => {
    if (!repository || !owner) return;
    const sequence = ++listSequence.current;
    const saved = await repository.list(owner);
    if (sequence === listSequence.current && ownerRef.current === owner) setInventories(saved);
  }, [repository, owner]);

  const reloadItems = useCallback(async () => {
    if (!repository || !owner) return;
    const id = selectedId;
    const sequence = ++itemsSequence.current;
    itemsInFlight.current += 1;
    try {
      const saved = id ? await repository.items(owner, id) : [];
      if (sequence === itemsSequence.current && ownerRef.current === owner && selectedRef.current === id) setItems(saved);
    } finally {
      itemsInFlight.current -= 1;
    }
  }, [repository, owner, selectedId]);

  useEffect(() => {
    setInventories([]);
    setItems([]);
    setSelectedId(null);
  }, [owner]);

  useEffect(() => { reloadList().catch(failure => errorRef.current(errorMessage(failure))); }, [reloadList]);
  useEffect(() => { reloadItems().catch(failure => errorRef.current(errorMessage(failure))); }, [reloadItems]);

  // A reload started before this write may not contain it; a fresh one replaces its result.
  const changeItems = useCallback((inventoryId: string, change: (previous: InventoryItem[]) => InventoryItem[]) => {
    if (selectedRef.current !== inventoryId) return;
    setItems(change);
    if (itemsInFlight.current > 0) reloadItems().catch(failure => errorRef.current(errorMessage(failure)));
  }, [reloadItems]);

  const select = useCallback((id: string | null) => {
    setItems([]);
    setSelectedId(id);
  }, []);

  const forgetInventory = useCallback((id: string) => {
    listSequence.current += 1;
    itemsSequence.current += 1;
    setInventories(previous => previous.filter(entry => entry.id !== id));
    if (selectedRef.current === id) {
      setSelectedId(null);
      setItems([]);
    }
  }, []);

  const current = inventories.find(inventory => inventory.id === selectedId);
  return { inventories, items, selectedId, current, select, reloadList, reloadItems, changeItems, forgetInventory };
}

// Sends the queue while the app is open, active and online. The list is reloaded only when a state changed.
export function useOutboxSync(outbox: Outbox | null, owner: string | null, online: boolean, active: boolean,
  reloadList: () => Promise<void>, onError: (message: string) => void) {
  const reloadRef = useRef(reloadList);
  reloadRef.current = reloadList;
  const errorRef = useRef(onError);
  errorRef.current = onError;
  useEffect(() => {
    if (!outbox || !owner || !online || !active) return;
    let mounted = true;
    const sync = async () => {
      let changed = true;
      try {
        changed = await outbox.sync(owner);
      } catch (failure) {
        if (mounted) errorRef.current(errorMessage(failure));
      }
      if (mounted && changed) await reloadRef.current().catch(failure => { if (mounted) errorRef.current(errorMessage(failure)); });
    };
    void sync();
    const timer = setInterval(() => { void sync(); }, SYNC_INTERVAL_MS);
    return () => { mounted = false; clearInterval(timer); };
  }, [outbox, owner, online, active]);
}
