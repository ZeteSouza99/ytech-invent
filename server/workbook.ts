import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Catalog, Inventory, User } from '../shared/model.ts';
import { createWorkbookService as createSharedWorkbookService } from '../src/workbook.ts';

export interface WorkbookService {
  catalog: Catalog;
  export(inventory: Inventory, user: User): Promise<{
    attachments: { filename: string; content: Buffer }[];
    warnings: string[];
  }>;
}

export async function createWorkbookService(templatePath: string): Promise<WorkbookService> {
  let template: Buffer;
  try {
    template = await readFile(templatePath);
  } catch {
    throw new Error('Não foi possível ler o arquivo XLSX do catálogo. Verifique o caminho e a permissão de leitura.');
  }
  const version = createHash('sha256').update(template).digest('hex');
  const shared = await createSharedWorkbookService(new Uint8Array(template), version);
  return {
    catalog: shared.catalog,
    async export(inventory, user) {
      const result = await shared.export(inventory, user);
      return {
        attachments: result.attachments.map(({ filename, content }) => ({ filename, content: Buffer.from(content) })),
        warnings: result.warnings,
      };
    },
  };
}
