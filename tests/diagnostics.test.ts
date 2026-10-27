import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isValidElement, type ReactNode } from 'react';
import App from '../App';
import { CameraDiagnostics } from '../src/CameraDiagnostics';
import { pictureSizeFor } from '../src/pictureSize';
import { UnitScanner, type ScannedUnit } from '../src/UnitScanner';

const runtime = vi.hoisted(() => ({
  states: [] as unknown[],
  cursor: 0,
  effects: [] as (() => void | (() => void))[],
  listener: null as ((state: string) => void) | null,
}));

vi.mock('react', async importOriginal => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    useState(initial: unknown) {
      const index = runtime.cursor++;
      if (!(index in runtime.states)) runtime.states[index] = initial;
      return [runtime.states[index], (value: unknown) => {
        runtime.states[index] = typeof value === 'function' ? value(runtime.states[index]) : value;
      }];
    },
    useEffect(effect: () => void | (() => void)) { runtime.effects.push(effect); },
    useMemo<T>(factory: () => T) { return factory(); },
  };
});
vi.mock('react-native', () => ({
  AppState: {
    currentState: 'active',
    addEventListener: (_name: string, listener: (state: string) => void) => {
      runtime.listener = listener;
      return { remove: vi.fn() };
    },
  },
  Linking: { getInitialURL: vi.fn(async () => null), addEventListener: vi.fn(() => ({ remove: vi.fn() })) },
  StyleSheet: { create: (value: unknown) => value },
  ActivityIndicator: 'ActivityIndicator', Alert: {}, FlatList: 'FlatList',
  KeyboardAvoidingView: 'KeyboardAvoidingView', Pressable: 'Pressable',
  ScrollView: 'ScrollView', StatusBar: 'StatusBar', Text: 'Text',
  TextInput: 'TextInput', View: 'View',
}));
vi.mock('react-native-safe-area-context', () => ({ SafeAreaProvider: 'SafeAreaProvider', SafeAreaView: 'SafeAreaView' }));
vi.mock('@react-native-community/netinfo', () => ({ default: {} }));
vi.mock('expo-sqlite', () => ({ openDatabaseAsync: vi.fn() }));
vi.mock('expo-crypto', () => ({ randomUUID: vi.fn() }));
vi.mock('../src/UnitScanner', () => ({ UnitScanner: vi.fn() }));
vi.mock('../src/labelEval', () => ({ runLabelEvaluation: vi.fn() }));
vi.mock('../src/google', () => ({
  accessToken: vi.fn(), configurationError: vi.fn(), login: vi.fn(), logout: vi.fn(), restoreSession: vi.fn(),
}));
vi.mock('../src/catalog', () => ({
  loadWorkbookService: vi.fn(() => new Promise(() => undefined)), loadCatalog: vi.fn(() => new Promise(() => undefined)),
  importCatalog: vi.fn(), restoreBundledCatalog: vi.fn(),
}));
vi.mock('../src/services', () => ({
  openServices: vi.fn(() => new Promise(() => undefined)), openForegroundServices: vi.fn(() => new Promise(() => undefined)),
}));
vi.mock('../src/backgroundSend', () => ({ enableBackgroundSending: vi.fn(), disableBackgroundSending: vi.fn() }));
vi.mock('../src/delivery', () => ({ createGmailDelivery: vi.fn() }));
vi.mock('../src/exportFiles', () => ({ saveWorkbookFiles: vi.fn() }));
vi.mock('../src/shareExport', () => ({ chooseBackup: vi.fn(), createDocument: vi.fn(), shareDocument: vi.fn() }));

interface Props {
  children?: ReactNode;
  title?: string;
  active?: boolean;
  onPress?: () => void;
  onTestCamera?: () => void;
  onSave?: unknown;
  onUse?: (unit: ScannedUnit) => void;
}

function elements(node: ReactNode): { type: unknown; props: Props }[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Props>(node)) return [];
  return [{ type: node.type, props: node.props }, ...elements(node.props.children)];
}
function render(component: () => ReactNode) {
  runtime.cursor = 0;
  return component();
}
function press(tree: ReactNode, title: string) {
  const button = elements(tree).find(element => element.props.title === title);
  expect(button?.props.onPress).toBeTypeOf('function');
  button?.props.onPress?.();
}
function text(node: ReactNode): string {
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(text).join(' ');
  return isValidElement<Props>(node) ? text(node.props.children) : '';
}
function scannerOf(tree: ReactNode) {
  return elements(tree).find(element => element.type === UnitScanner);
}

const unit: ScannedUnit = {
  pn: { field: 'pn', value: 'HMC3200-LI(H)', raw: '1PHMC3200-LI(H)', source: 'barcode', evidence: ['codigo', 'identificador'], confidence: 'alta' },
  ns: { field: 'ns', value: '000123', raw: 'S000123', source: 'barcode', evidence: ['codigo', 'identificador'], confidence: 'alta' },
};

beforeEach(() => {
  runtime.states = [];
  runtime.cursor = 0;
  runtime.effects = [];
  runtime.listener = null;
  vi.stubGlobal('__DEV__', true);
});

describe('diagnóstico de câmera somente no development build', () => {
  it('não expõe mais diagnóstico nem entrada sem login no aplicativo', () => {
    for (const dev of [true, false]) {
      vi.stubGlobal('__DEV__', dev);
      const tree = elements(render(App));
      expect(tree.some(element => element.type === CameraDiagnostics)).toBe(false);
      expect(tree.some(element => typeof element.props.onTestCamera === 'function')).toBe(false);
      expect(runtime.effects).toHaveLength(0);
    }
  });

  it('usa o leitor real em modo de teste, sem salvar, e descarta a leitura ao sair', () => {
    const close = vi.fn();
    const component = () => CameraDiagnostics({ onClose: close });
    let tree = render(component);
    expect(text(tree)).toContain('Sem login, inventário ou envio');
    press(tree, 'Ler etiqueta');
    tree = render(component);
    const scanner = scannerOf(tree);
    expect(scanner?.props.onUse).toBeTypeOf('function');
    expect(scanner?.props.onSave).toBeUndefined();
    scanner?.props.onUse?.(unit);
    tree = render(component);
    expect(text(tree)).toContain('HMC3200-LI(H)');
    expect(text(tree)).toContain('000123');
    expect(scannerOf(tree)).toBeUndefined();
    press(tree, 'Sair do teste');
    expect(close).toHaveBeenCalledOnce();
    runtime.states = [];
    expect(text(render(component))).not.toContain('HMC3200-LI(H)');
  });

  it('desliga a câmera do leitor quando o aplicativo vai para segundo plano', () => {
    const component = () => CameraDiagnostics({ onClose: vi.fn() });
    press(render(component), 'Ler etiqueta');
    runtime.effects[0]?.();
    expect(scannerOf(render(component))?.props.active).toBe(true);
    runtime.listener?.('background');
    expect(scannerOf(render(component))?.props.active).toBe(false);
    runtime.listener?.('active');
    expect(scannerOf(render(component))?.props.active).toBe(true);
  });
});

describe('resolução das fotos de leitura', () => {
  it('escolhe a maior foto 4:3 de até 13 MP, evitando capturas de 50 MP', () => {
    expect(pictureSizeFor(['8160x6120', '4080x3060', '4000x3000', '3264x2448', '1920x1080'])).toBe('4080x3060');
    expect(pictureSizeFor(['8160x6120', '3840x2160', '1920x1080'])).toBe('3840x2160');
    expect(pictureSizeFor(['invalido', ''])).toBeUndefined();
  });
});
