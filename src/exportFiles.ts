import * as FileSystem from 'expo-file-system/legacy';
import { encodeBase64 } from '../shared/mime';
import { errorMessage } from '../shared/model';
import type { WorkbookAttachment } from './workbook';

// Uses Android's folder picker; no broad storage permission or network needed.
// Exporting is independent of the delivery state and never claims an email was sent.
export async function saveWorkbookFiles(attachments: WorkbookAttachment[], id: string, partial: boolean): Promise<string[] | null> {
  const permission = await FileSystem.StorageAccessFramework.requestDirectoryPermissionsAsync();
  if (!permission.granted) return null;
  const suffix = `${partial ? 'PARCIAL_' : ''}${id}_${Date.now()}`;
  const created: string[] = [];
  const names: string[] = [];
  try {
    for (const attachment of attachments) {
      const name = attachment.filename.replace(/(\.[a-z0-9]+)$/i, `_${suffix}$1`);
      const uri = await FileSystem.StorageAccessFramework.createFileAsync(permission.directoryUri, name, attachment.mimeType);
      created.push(uri);
      await FileSystem.writeAsStringAsync(uri, encodeBase64(attachment.content), { encoding: FileSystem.EncodingType.Base64 });
      names.push(name);
    }
    return names;
  } catch (error) {
    const cleanup = await Promise.allSettled(created.map(uri => FileSystem.deleteAsync(uri, { idempotent: true })));
    const remaining = cleanup.some(result => result.status === 'rejected');
    throw new Error(`Não foi possível salvar os arquivos: ${errorMessage(error)}. A coleta continua no aplicativo.${remaining ? ' Podem ter restado arquivos incompletos na pasta escolhida; exclua-os antes de usar uma nova exportação.' : ''}`);
  }
}
