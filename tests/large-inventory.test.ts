import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { InventoryRepository, type LocalDatabase } from '../src/repository';
import { inventoriesCsv, inventoriesHtml, inventoriesJson, parseInventoryBackup } from '../src/exportFormats';
import { buildInventoryMessage } from '../shared/mime';
import { MAX_ITEMS, type InventoryItem } from '../shared/model';
import { describeFrom } from '../shared/report';
import { createWorkbookService } from '../shared/workbook';

// Gmail accepts up to 25 MB of attachments per message; the base64 message must stay below it.
const GMAIL_LIMIT_BYTES = 25 * 1024 * 1024;

function connect() {
  const sqlite = new DatabaseSync(':memory:');
  const db: LocalDatabase = {
    async execAsync(sql) { sqlite.exec(sql); },
    async runAsync(sql, ...params) { return { changes: Number(sqlite.prepare(sql).run(...params).changes) }; },
    async getFirstAsync<T>(sql: string, ...params: (string | number | null)[]) { return (sqlite.prepare(sql).get(...params) as T | undefined) ?? null; },
    async getAllAsync<T>(sql: string, ...params: (string | number | null)[]) { return sqlite.prepare(sql).all(...params) as T[]; },
  };
  return { sqlite, repository: new InventoryRepository(db) };
}

function unit(index: number, pn: string): InventoryItem {
  const ns = `NS${String(index).padStart(8, '0')}`;
  return {
    id: randomUUID(), pn, ns, rawPn: pn, rawNs: ns, location: `MZ01-E${String(index % 40).padStart(2, '0')}-N01`, quantity: 1,
    capturedAt: new Date().toISOString(), source: index % 3 ? 'barcode' : 'ocr', confirmed: true,
    ...(index % 5 ? {} : { patrimony: `PAT-${index}` }),
  };
}

describe('coleta no limite de 10.000 unidades', () => {
  it('grava, conclui, gera planilhas, relatório e e-mail com todas as unidades', async () => {
    const { repository, sqlite } = connect();
    try {
      const template = new Uint8Array(await readFile('assets/catalog/sb1-produtos.xlsx'));
      const service = await createWorkbookService(template, 'carga');
      const pns = service.catalog.products.slice(0, 50).map(product => product.pn);
      const user = { sub: '123', email: 'ana@ytechsolucoes.com', name: 'Ana' };
      await repository.initialize();
      const id = randomUUID();
      await repository.create({
        id, owner: user.sub, title: 'Carga máxima', location: 'MZ01', startedAt: '2026-01-01T00:00:00.000Z', completedAt: null,
        catalogVersion: 'carga', state: 'draft', lastError: '', receipt: null,
      });
      // Direct inserts keep the test fast; the last unit goes through add() with every check.
      const insert = sqlite.prepare('INSERT INTO items(id,inventoryId,ns,json) VALUES (?,?,?,?)');
      sqlite.exec('BEGIN');
      for (let index = 0; index < MAX_ITEMS - 1; index += 1) {
        const item = unit(index, pns[index % pns.length]!);
        insert.run(item.id, id, item.ns, JSON.stringify(item));
      }
      sqlite.exec('COMMIT');
      await repository.add(user.sub, id, unit(MAX_ITEMS - 1, pns[0]!));
      await expect(repository.add(user.sub, id, unit(MAX_ITEMS, pns[0]!))).rejects.toThrow(`Limite de ${MAX_ITEMS}`);
      expect(await repository.items(user.sub, id)).toHaveLength(MAX_ITEMS);

      await repository.finish(user.sub, id);
      const inventory = await repository.payload(user.sub, id);
      expect(inventory.items).toHaveLength(MAX_ITEMS);

      const entries = [{ inventory, partial: false }];
      const spreadsheet = await service.spreadsheet(entries);
      const report = new ExcelJS.Workbook();
      await report.xlsx.load(spreadsheet.content.slice().buffer);
      expect(report.getWorksheet('Inventário')!.rowCount).toBe(MAX_ITEMS + 1);
      const summary = report.getWorksheet('Resumo')!;
      expect(summary.getCell(summary.rowCount, 5).value).toBe(MAX_ITEMS);

      const describe = describeFrom(service.catalog.products);
      expect(inventoriesHtml(entries, describe).match(/<tr class="u">/g)).toHaveLength(MAX_ITEMS);
      expect(inventoriesCsv(entries, describe).split('\r\n')).toHaveLength(MAX_ITEMS + 1);
      expect(parseInventoryBackup(inventoriesJson(entries))[0]!.inventory.items).toHaveLength(MAX_ITEMS);

      const raw = buildInventoryMessage({ inventory, user, attachments: [spreadsheet] });
      expect(raw.length).toBeLessThan(GMAIL_LIMIT_BYTES);
    } finally { sqlite.close(); }
  }, 180_000);
});
