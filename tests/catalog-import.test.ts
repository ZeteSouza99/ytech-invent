import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => {
  const files = new Map<string, Uint8Array>();
  const directories = new Set<string>();
  const path = (parts: unknown[]) => parts.map(part => typeof part === 'string' ? part : (part as { uri: string }).uri).join('/');
  class File {
    uri: string;
    constructor(...parts: unknown[]) { this.uri = path(parts); }
    get exists() { return files.has(this.uri); }
    async bytes() {
      const content = files.get(this.uri);
      if (!content) throw new Error(`Arquivo ausente: ${this.uri}`);
      return content.slice();
    }
    create() { files.set(this.uri, new Uint8Array()); }
    write(content: Uint8Array) { files.set(this.uri, content.slice()); }
    delete() { if (!files.delete(this.uri)) throw new Error(`Arquivo ausente: ${this.uri}`); }
    async move(destination: File, options?: { overwrite?: boolean }) {
      if (destination.exists && !options?.overwrite) throw new Error('Destino já existe.');
      files.set(destination.uri, files.get(this.uri)!);
      files.delete(this.uri);
      this.uri = destination.uri;
    }
  }
  class Directory {
    uri: string;
    constructor(...parts: unknown[]) { this.uri = path(parts); }
    get exists() { return directories.has(this.uri); }
    create() { directories.add(this.uri); }
  }
  return { files, directories, File, Directory, picked: vi.fn() };
});

vi.mock('expo-file-system', () => ({ File: fake.File, Directory: fake.Directory, Paths: { document: new fake.Directory('file:///docs') } }));
vi.mock('expo-document-picker', () => ({ getDocumentAsync: fake.picked }));
vi.mock('expo-asset', () => ({ Asset: { fromModule: () => ({ downloadAsync: async () => undefined, localUri: 'file:///bundle/sb1.xlsx' }) } }));
vi.mock('expo-crypto', () => ({
  CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
  digest: async (_algorithm: string, bytes: Uint8Array) => Uint8Array.from(createHash('sha256').update(bytes).digest()).buffer,
}));
vi.mock('../assets/catalog/sb1-produtos.xlsx', () => ({ default: 1 }));

const template = new Uint8Array(await readFile('assets/catalog/sb1-produtos.xlsx'));
const IMPORTED = 'file:///docs/catalog/sb1-produtos.xlsx';
const PICKED = 'file:///cache/escolhido.xlsx';

async function catalogModule() {
  vi.resetModules();
  return import('../src/catalog');
}

function pick(content: Uint8Array) {
  fake.files.set(PICKED, content);
  fake.picked.mockResolvedValue({ canceled: false, assets: [{ uri: PICKED, size: content.length }] });
}

beforeEach(() => {
  fake.files.clear();
  fake.directories.clear();
  fake.picked.mockReset();
  fake.files.set('file:///bundle/sb1.xlsx', template);
});

describe('catálogo importado pelo app', () => {
  it('usa o catálogo embutido enquanto nada foi importado', async () => {
    const loaded = await (await catalogModule()).loadCatalog();
    expect(loaded.source).toBe('bundled');
    expect(loaded.warning).toBeNull();
    expect(loaded.service.catalog.products.length).toBeGreaterThan(0);
  });

  it('valida a planilha antes de substituir, guarda uma cópia e apaga a do seletor', async () => {
    const catalog = await catalogModule();
    pick(template);
    const imported = await catalog.importCatalog();
    expect(imported?.source).toBe('imported');
    expect(fake.files.get(IMPORTED)).toEqual(template);
    expect(fake.files.has(PICKED)).toBe(false);
    expect((await catalog.loadCatalog()).source).toBe('imported');
    expect((await (await catalogModule()).loadCatalog()).source).toBe('imported');
  });

  it('recusa arquivo inválido sem tocar no catálogo em uso', async () => {
    const catalog = await catalogModule();
    pick(new TextEncoder().encode('não é uma planilha'));
    await expect(catalog.importCatalog()).rejects.toThrow('Modelo inválido');
    expect(fake.files.has(IMPORTED)).toBe(false);
    expect(fake.files.has(PICKED)).toBe(false);
    expect((await catalog.loadCatalog()).source).toBe('bundled');
  });

  it('não altera nada quando a escolha é cancelada', async () => {
    const catalog = await catalogModule();
    fake.picked.mockResolvedValue({ canceled: true, assets: null });
    expect(await catalog.importCatalog()).toBeNull();
    expect(fake.files.has(IMPORTED)).toBe(false);
  });

  it('volta ao catálogo embutido e apaga a cópia importada', async () => {
    const catalog = await catalogModule();
    pick(template);
    await catalog.importCatalog();
    expect((await catalog.restoreBundledCatalog()).source).toBe('bundled');
    expect(fake.files.has(IMPORTED)).toBe(false);
  });

  it('avisa e usa o embutido quando a cópia importada não pode mais ser lida', async () => {
    fake.files.set(IMPORTED, new TextEncoder().encode('corrompido'));
    const loaded = await (await catalogModule()).loadCatalog();
    expect(loaded.source).toBe('bundled');
    expect(loaded.warning).toContain('importe o arquivo de novo');
    expect(fake.files.has(IMPORTED)).toBe(true);
  });
});
