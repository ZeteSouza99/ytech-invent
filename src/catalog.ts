import { Asset } from 'expo-asset';
import { CryptoDigestAlgorithm, digest } from 'expo-crypto';
import * as DocumentPicker from 'expo-document-picker';
import { Directory, File, Paths } from 'expo-file-system';
import template from '../assets/catalog/sb1-produtos.xlsx';
import { errorMessage } from '../shared/model';
import { createWorkbookService, type WorkbookService } from '../shared/workbook';

export type CatalogSource = 'bundled' | 'imported';
export type LoadedCatalog = { service: WorkbookService; source: CatalogSource; warning: string | null };

const MAX_CATALOG_BYTES = 20 * 1024 * 1024;
const XLSX_TYPES = ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/octet-stream'];

let loading: Promise<LoadedCatalog> | null = null;

function catalogDirectory(): Directory {
  return new Directory(Paths.document, 'catalog');
}

function importedFile(): File {
  return new File(catalogDirectory(), 'sb1-produtos.xlsx');
}

async function versionOf(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const hash = new Uint8Array(await digest(CryptoDigestAlgorithm.SHA256, bytes));
  return Array.from(hash, byte => byte.toString(16).padStart(2, '0')).join('');
}

async function serviceFor(bytes: Uint8Array<ArrayBuffer>): Promise<WorkbookService> {
  return createWorkbookService(bytes, await versionOf(bytes));
}

async function bundledService(): Promise<WorkbookService> {
  const asset = Asset.fromModule(template);
  await asset.downloadAsync();
  if (!asset.localUri) throw new Error('O modelo SB1 não foi encontrado no aplicativo. Reinstale a versão mais recente.');
  return serviceFor(await new File(asset.localUri).bytes());
}

async function load(): Promise<LoadedCatalog> {
  const file = importedFile();
  if (!file.exists) return { service: await bundledService(), source: 'bundled', warning: null };
  try {
    return { service: await serviceFor(await file.bytes()), source: 'imported', warning: null };
  } catch (error) {
    return {
      service: await bundledService(), source: 'bundled',
      warning: `O catálogo importado não pôde ser lido (${errorMessage(error)}). O app está usando o catálogo embutido; importe o arquivo de novo.`,
    };
  }
}

// An imported SB1 file replaces the catalog shipped with the app until the bundled one is restored.
export function loadCatalog(): Promise<LoadedCatalog> {
  loading ??= load().catch(error => {
    loading = null;
    throw error;
  });
  return loading;
}

export async function loadWorkbookService(): Promise<WorkbookService> {
  return (await loadCatalog()).service;
}

// The file is validated with the same rules as the bundled template before anything is replaced.
export async function importCatalog(): Promise<LoadedCatalog | null> {
  const result = await DocumentPicker.getDocumentAsync({ type: XLSX_TYPES, copyToCacheDirectory: true });
  if (result.canceled) return null;
  const asset = result.assets[0]!;
  const picked = new File(asset.uri);
  try {
    if (asset.size && asset.size > MAX_CATALOG_BYTES) throw new Error('O catálogo excede 20 MB.');
    const bytes = await picked.bytes();
    if (bytes.length > MAX_CATALOG_BYTES) throw new Error('O catálogo excede 20 MB.');
    const service = await serviceFor(bytes);
    const directory = catalogDirectory();
    if (!directory.exists) directory.create({ intermediates: true });
    const temporary = new File(directory, 'sb1-produtos.importando.xlsx');
    if (temporary.exists) temporary.delete();
    temporary.create();
    temporary.write(bytes);
    await temporary.move(importedFile(), { overwrite: true });
    const loaded: LoadedCatalog = { service, source: 'imported', warning: null };
    loading = Promise.resolve(loaded);
    return loaded;
  } finally {
    try {
      if (picked.exists) picked.delete();
    } catch {
      // The picker's copy lives in the cache directory, which Android also clears on its own.
    }
  }
}

export async function restoreBundledCatalog(): Promise<LoadedCatalog> {
  const file = importedFile();
  if (file.exists) file.delete();
  loading = null;
  return loadCatalog();
}
