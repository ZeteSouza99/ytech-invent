import { Asset } from 'expo-asset';
import { CryptoDigestAlgorithm, digest } from 'expo-crypto';
import { File } from 'expo-file-system';
import template from '../assets/catalog/sb1-produtos.xlsx';
import { createWorkbookService, type WorkbookService } from './workbook';

let service: Promise<WorkbookService> | null = null;

async function loadTemplate(): Promise<WorkbookService> {
  const asset = Asset.fromModule(template);
  await asset.downloadAsync();
  if (!asset.localUri) throw new Error('O modelo SB1 não foi encontrado no aplicativo. Reinstale a versão mais recente.');
  const bytes = await new File(asset.localUri).bytes();
  const hash = new Uint8Array(await digest(CryptoDigestAlgorithm.SHA256, bytes));
  const version = Array.from(hash, byte => byte.toString(16).padStart(2, '0')).join('');
  return createWorkbookService(bytes, version);
}

// The catalog ships with the app; updating it means publishing a new app version.
export function loadWorkbookService(): Promise<WorkbookService> {
  service ??= loadTemplate().catch(error => {
    service = null;
    throw error;
  });
  return service;
}
