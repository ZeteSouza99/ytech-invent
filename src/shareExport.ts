import { Directory, File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import * as Print from 'expo-print';
import * as DocumentPicker from 'expo-document-picker';
import { randomUUID } from 'expo-crypto';
import { utf8Encode, type MailAttachment } from '../shared/mime';
import { MAX_BACKUP_BYTES } from '../shared/model';
import { reportFilename, type Describe } from '../shared/report';
import { inventoriesCsv, inventoriesHtml, inventoriesJson, parseInventoryBackup, type ExportEntry, type ExportFormat } from './exportFormats';

const EXPORT_RETENTION_MS = 24 * 60 * 60 * 1000;

export async function createDocument(entries: ExportEntry[], format: Exclude<ExportFormat, 'xlsx'>, describe: Describe): Promise<MailAttachment> {
  const filename = reportFilename(entries, format);
  if (format === 'pdf') {
    const result = await Print.printToFileAsync({ html: inventoriesHtml(entries, describe), base64: false });
    const file = new File(result.uri);
    try {
      return { filename, mimeType: 'application/pdf', content: await file.bytes() };
    } finally {
      if (file.exists) file.delete();
    }
  }
  return {
    filename,
    mimeType: format === 'csv' ? 'text/csv' : 'application/json',
    content: utf8Encode(format === 'csv' ? inventoriesCsv(entries, describe) : inventoriesJson(entries)),
  };
}

// Bytes are written as they are; there is no base64 round trip in JavaScript.
export async function shareDocument(attachment: MailAttachment): Promise<void> {
  if (!await Sharing.isAvailableAsync()) throw new Error('Compartilhamento indisponível. Escolha Salvar em uma pasta.');
  const directory = new Directory(Paths.cache, 'inventory-exports');
  if (!directory.exists) directory.create({ intermediates: true });
  // Keep recent files available while the receiving app reads them; prune older exports.
  for (const entry of directory.list()) {
    if (entry instanceof File && entry.lastModified !== null && entry.lastModified < Date.now() - EXPORT_RETENTION_MS) entry.delete();
  }
  const file = new File(directory, `${randomUUID()}_${attachment.filename}`);
  try {
    file.create();
    file.write(attachment.content);
    await Sharing.shareAsync(file.uri, { mimeType: attachment.mimeType, dialogTitle: 'Compartilhar inventário' });
  } catch (failure) {
    if (file.exists) file.delete();
    throw failure;
  }
}

export async function chooseBackup(): Promise<ExportEntry[] | null> {
  const result = await DocumentPicker.getDocumentAsync({ type: ['application/json', 'application/octet-stream'], copyToCacheDirectory: true });
  if (result.canceled) return null;
  const asset = result.assets[0]!;
  const file = new File(asset.uri);
  try {
    if (asset.size && asset.size > MAX_BACKUP_BYTES) throw new Error('O arquivo de backup excede 32 MB.');
    return parseInventoryBackup(await file.text());
  } finally {
    if (file.exists) file.delete();
  }
}
