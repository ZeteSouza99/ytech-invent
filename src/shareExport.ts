import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import * as Print from 'expo-print';
import * as DocumentPicker from 'expo-document-picker';
import { randomUUID } from 'expo-crypto';
import { encodeBase64, utf8Encode, type MailAttachment } from '../shared/mime';
import { inventoriesCsv, inventoriesHtml, inventoriesJson, parseInventoryBackup, type ExportEntry, type ExportFormat } from './exportFormats';

export async function createDocument(entries: ExportEntry[], format: Exclude<ExportFormat, 'xlsx'>): Promise<MailAttachment> {
  const prefix = entries.some(entry => entry.partial) ? 'Inventario_PARCIAL' : 'Inventario';
  const company = entries.length === 1 ? `_${entries[0]!.inventory.organization?.cnpj ?? entries[0]!.inventory.id}` : '_todos';
  if (format === 'pdf') {
    const result = await Print.printToFileAsync({ html: inventoriesHtml(entries), base64: false });
    try {
      const file = new (await import('expo-file-system')).File(result.uri);
      return { filename: `${prefix}${company}.pdf`, mimeType: 'application/pdf', content: await file.bytes() };
    } finally { await FileSystem.deleteAsync(result.uri, { idempotent: true }); }
  }
  return {
    filename: `${prefix}${company}.${format}`,
    mimeType: format === 'csv' ? 'text/csv' : 'application/json',
    content: utf8Encode(format === 'csv' ? inventoriesCsv(entries) : inventoriesJson(entries)),
  };
}

export async function shareDocument(attachment: MailAttachment): Promise<void> {
  if (!await Sharing.isAvailableAsync()) throw new Error('Compartilhamento indisponível. Escolha Salvar em uma pasta.');
  if (!FileSystem.cacheDirectory) throw new Error('O armazenamento temporário está indisponível.');
  const directory = `${FileSystem.cacheDirectory}inventory-exports/`;
  await FileSystem.makeDirectoryAsync(directory, { intermediates: true });
  // Keep recent files available while the receiving app reads them; prune older exports.
  for (const name of await FileSystem.readDirectoryAsync(directory)) {
    const path = directory + name;
    const info = await FileSystem.getInfoAsync(path);
    if (info.exists && !info.isDirectory && info.modificationTime < Date.now() / 1000 - 86400) {
      await FileSystem.deleteAsync(path, { idempotent: true });
    }
  }
  const path = `${directory}${randomUUID()}_${attachment.filename}`;
  try {
    await FileSystem.writeAsStringAsync(path, encodeBase64(attachment.content), { encoding: FileSystem.EncodingType.Base64 });
    await Sharing.shareAsync(path, { mimeType: attachment.mimeType, dialogTitle: 'Compartilhar inventário' });
  } catch (failure) {
    await FileSystem.deleteAsync(path, { idempotent: true }).catch(() => undefined);
    throw failure;
  }
}

export async function chooseBackup(): Promise<ExportEntry[] | null> {
  const result = await DocumentPicker.getDocumentAsync({ type: ['application/json', 'application/octet-stream'], copyToCacheDirectory: true });
  if (result.canceled) return null;
  const asset = result.assets[0]!;
  try {
    if (asset.size && asset.size > 32 * 1024 * 1024) throw new Error('O arquivo de backup excede 32 MB.');
    return parseInventoryBackup(await FileSystem.readAsStringAsync(asset.uri));
  } finally { await FileSystem.deleteAsync(asset.uri, { idempotent: true }); }
}
