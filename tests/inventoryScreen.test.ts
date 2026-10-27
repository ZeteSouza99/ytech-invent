import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isValidElement, type ReactNode } from 'react';
import { DEFAULT_RECIPIENT } from '../shared/model';
import { useInventoryData } from '../src/app/hooks';
import { INVENTORY_STATES, type InventoryRepository, type InventorySummary } from '../src/repository';
import { InventoryScreen } from '../src/screens/InventoryScreen';
import { ResendPanel } from '../src/screens/RecipientEditor';

// One slot per hook call, in call order. Callbacks, memos and effects are recomputed only when their
// dependencies change, as in React: the reopened-inventory bug depended on exactly that.
const runtime = vi.hoisted(() => ({ slots: [] as unknown[], cursor: 0, effects: [] as (() => void)[] }));

vi.mock('react', async importOriginal => {
  const actual = await importOriginal<typeof import('react')>();
  type Deps = readonly unknown[] | undefined;
  const same = (previous: Deps, next: Deps) => !!previous && !!next && previous.length === next.length
    && previous.every((value, index) => Object.is(value, next[index]));
  function slot<T>(create: () => T): T {
    const index = runtime.cursor++;
    if (!(index in runtime.slots)) runtime.slots[index] = create();
    return runtime.slots[index] as T;
  }
  function memo<T>(factory: () => T, deps: Deps): T {
    const entry = slot<{ deps: Deps; value?: T; ready: boolean }>(() => ({ deps: undefined, ready: false }));
    if (!entry.ready || !same(entry.deps, deps)) {
      entry.value = factory();
      entry.deps = deps;
      entry.ready = true;
    }
    return entry.value as T;
  }
  return {
    ...actual,
    useState<T>(initial: T | (() => T)) {
      const entry = slot(() => ({ value: typeof initial === 'function' ? (initial as () => T)() : initial }));
      const set = (next: T | ((previous: T) => T)) => {
        entry.value = typeof next === 'function' ? (next as (previous: T) => T)(entry.value) : next;
      };
      return [entry.value, set];
    },
    useRef: <T>(initial: T) => slot(() => ({ current: initial })),
    useMemo: memo,
    useCallback: <T>(callback: T, deps: Deps) => memo(() => callback, deps),
    useEffect(effect: () => void, deps?: Deps) {
      const entry = slot<{ deps: Deps; ran: boolean }>(() => ({ deps: undefined, ran: false }));
      if (entry.ran && same(entry.deps, deps)) return;
      entry.deps = deps;
      entry.ran = true;
      runtime.effects.push(effect);
    },
  };
});
vi.mock('react-native', () => ({
  AppState: { currentState: 'active', addEventListener: () => ({ remove: () => undefined }) },
  StyleSheet: { create: <T>(styles: T) => styles },
  FlatList: 'FlatList', Pressable: 'Pressable', Text: 'Text', TextInput: 'TextInput', View: 'View',
}));
vi.mock('@react-native-community/netinfo', () => ({ default: {} }));
vi.mock('../src/backgroundSend', () => ({ enableBackgroundSending: vi.fn(), disableBackgroundSending: vi.fn() }));
vi.mock('../src/catalog', () => ({ importCatalog: vi.fn(), loadCatalog: vi.fn(), restoreBundledCatalog: vi.fn() }));
vi.mock('../src/google', () => ({ login: vi.fn(), logout: vi.fn(), restoreSession: vi.fn() }));
vi.mock('../src/services', () => ({ openForegroundServices: vi.fn() }));

beforeEach(() => {
  runtime.slots = [];
  runtime.cursor = 0;
  runtime.effects = [];
});

describe('unidades do inventário aberto', () => {
  it('voltar à lista e abrir o mesmo inventário mostra as unidades de novo', async () => {
    const units: Record<string, number> = { A: 3, B: 2 };
    const repository = {
      list: async () => [],
      items: async (_owner: string, id: string) => Array.from({ length: units[id] ?? 0 }, (_, index) => ({ id: `${id}${index}` })),
    } as unknown as InventoryRepository;
    const errors: string[] = [];
    // Rendered like a component: the hook runs at the top level of each render.
    function InventoryData() {
      return useInventoryData(repository, 'conta', message => errors.push(message));
    }
    let data = null as ReturnType<typeof InventoryData> | null;
    // Renders until the effects and the reads they start have finished.
    async function settle() {
      for (let round = 0; round < 6; round++) {
        runtime.cursor = 0;
        data = InventoryData();
        for (const effect of runtime.effects.splice(0)) effect();
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      return data?.items.length;
    }
    await settle();
    for (const id of ['A', 'A', 'B', 'B', 'A']) {
      data?.select(id);
      expect(await settle(), id).toBe(units[id]);
    }
    expect(errors).toEqual([]);
  });
});

describe('tela do inventário', () => {
  interface Props { children?: ReactNode; ListHeaderComponent?: ReactNode; recipient?: string }
  function elements(node: ReactNode): { type: unknown; props: Props }[] {
    if (Array.isArray(node)) return node.flatMap(elements);
    if (!isValidElement<Props>(node)) return [];
    return [{ type: node.type, props: node.props }, ...elements(node.props.children), ...elements(node.props.ListHeaderComponent)];
  }
  function text(node: ReactNode): string {
    if (typeof node === 'string') return node;
    if (Array.isArray(node)) return node.map(text).join('');
    return isValidElement<Props>(node) ? `${text(node.props.children)} ${text(node.props.ListHeaderComponent)}` : '';
  }
  function screen(changes: Partial<InventorySummary>) {
    runtime.slots = [];
    runtime.cursor = 0;
    const inventory: InventorySummary = {
      id: 'inventario', owner: 'conta', title: 'Cliente', location: 'MZ01-E01-N01', startedAt: '2026-10-27T10:00:00.000Z',
      completedAt: '2026-10-27T11:00:00.000Z', catalogVersion: 'v1', state: 'sent', lastError: '', receipt: null, count: 1, ...changes,
    };
    const ignore = () => undefined;
    return InventoryScreen({
      inventory, items: [], search: '', onSearch: ignore, knownPns: new Set(), busy: false, online: true,
      onEditIdentification: ignore, onRetry: ignore, onChangeRecipient: ignore, onResend: ignore, onExport: ignore, onDelete: ignore,
      onRemoveItem: ignore, onEditItem: ignore, onScan: ignore, onManual: ignore, onReview: ignore,
    });
  }
  const resendPanel = (tree: ReactNode) => elements(tree).find(element => element.type === ResendPanel);

  it.each(INVENTORY_STATES)('oferece Reenviar e-mail só para inventário enviado: %s', state => {
    expect(!!resendPanel(screen({ state }))).toBe(state === 'sent');
  });

  it('reenvia para o último destinatário e não oferece reenvio de inventário marcado para reparo', () => {
    expect(resendPanel(screen({}))?.props.recipient).toBe(DEFAULT_RECIPIENT);
    expect(resendPanel(screen({ recipient: 'compras@cliente.com.br' }))?.props.recipient).toBe('compras@cliente.com.br');
    expect(resendPanel(screen({ problem: 'A identificação da empresa salva neste inventário está ilegível.' }))).toBeUndefined();
  });

  it('no envio incerto de um reenvio, avisa que as mensagens anteriores também estão em Enviados', () => {
    expect(text(screen({ state: 'uncertain' }))).toContain('Confira a pasta Enviados');
    expect(text(screen({ state: 'uncertain' }))).not.toContain('reenvios anteriores');
    expect(text(screen({ state: 'uncertain', resends: 2 }))).toContain('a mensagem original e os reenvios anteriores também aparecem lá');
  });
});
