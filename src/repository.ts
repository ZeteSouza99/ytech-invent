import { z } from 'zod';
import { organizationSchema, type Organization } from '../shared/company';
import { inventorySchema, inventoryTextSchema, itemSchema, MAX_ITEMS, MAX_PAYLOAD_BYTES, receiptSchema, utf8ByteLength, type Inventory, type InventoryItem, type Receipt } from '../shared/model';

type SqlValue = string | number | null;
export interface LocalDatabase {
  execAsync(sql: string): Promise<void>;
  runAsync(sql: string, ...values: SqlValue[]): Promise<{ changes: number }>;
  getFirstAsync<T>(sql: string, ...values: SqlValue[]): Promise<T | null>;
  getAllAsync<T>(sql: string, ...values: SqlValue[]): Promise<T[]>;
}

// Keep older stored labels readable for explicit repair; all writes and submissions use the current contract.
const storedLabelSchema = z.string().min(1).max(120);
const metadataSchema = z.object({ title: inventoryTextSchema, location: inventoryTextSchema, organization: organizationSchema.optional() }).strict();
const draftSchema = z.object({
  id: z.uuid(), owner: z.string().min(1), title: storedLabelSchema,
  location: storedLabelSchema, startedAt: z.iso.datetime(),
  completedAt: z.iso.datetime().nullable(), catalogVersion: z.string().min(1),
  state: z.enum(['draft', 'queued', 'sending', 'sent', 'failed', 'uncertain']),
  lastError: z.string(), receipt: z.string().nullable(),
  organization: z.preprocess(value => typeof value === 'string' ? JSON.parse(value) : value === null ? undefined : value, organizationSchema.optional()),
});
export type Draft = z.infer<typeof draftSchema>;
export type InventorySummary = Draft & { count: number };
export type DeliveryOutcome = { status: 'sent' | 'failed' | 'uncertain'; message: string; warnings: string[] };

export class InventoryRepository {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly db: LocalDatabase) {}

  private serialize<T>(action: () => Promise<T>): Promise<T> {
    const result = this.tail.then(action);
    // Keep the write queue usable after an error; the caller still receives the rejection.
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  async initialize(): Promise<void> {
    await this.db.execAsync(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS inventories (
        id TEXT PRIMARY KEY, owner TEXT NOT NULL, title TEXT NOT NULL, location TEXT NOT NULL,
        startedAt TEXT NOT NULL, completedAt TEXT, catalogVersion TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'draft', lastError TEXT NOT NULL DEFAULT '', receipt TEXT
      );
      CREATE INDEX IF NOT EXISTS inventories_owner ON inventories(owner, startedAt);
      CREATE TABLE IF NOT EXISTS items (
        id TEXT PRIMARY KEY, inventoryId TEXT NOT NULL REFERENCES inventories(id),
        ns TEXT NOT NULL, json TEXT NOT NULL, UNIQUE(inventoryId, ns)
      );
      CREATE INDEX IF NOT EXISTS items_inventory ON items(inventoryId);
    `);
    const columns = await this.db.getAllAsync<{ name: string }>('PRAGMA table_info(inventories)');
    if (!columns.some(column => column.name === 'organization')) {
      await this.db.execAsync('ALTER TABLE inventories ADD COLUMN organization TEXT');
    }
  }

  async create(input: Draft): Promise<void> {
    const metadata = metadataSchema.parse({ title: input.title, location: input.location, organization: input.organization });
    const draft = draftSchema.parse({ ...input, ...metadata });
    if (draft.state !== 'draft' || draft.completedAt) throw new Error('Um inventário novo deve estar em coleta.');
    await this.db.runAsync('INSERT INTO inventories(id,owner,title,location,startedAt,catalogVersion,organization) VALUES (?,?,?,?,?,?,?)',
      draft.id, draft.owner, draft.title, draft.location, draft.startedAt, draft.catalogVersion, draft.organization ? JSON.stringify(draft.organization) : null);
  }

  updateMetadata(owner: string, id: string, input: { title: string; location: string; organization?: Organization }): Promise<void> {
    return this.serialize(async () => {
      const metadata = metadataSchema.parse(input);
      const draft = await this.get(owner, id);
      if (draft.state !== 'draft') throw new Error('Inventário concluído não pode ser alterado.');
      const totals = await this.itemTotals(id);
      const envelope = JSON.stringify({ ...this.basePayload({ ...draft, ...metadata, organization: metadata.organization ?? draft.organization }, new Date().toISOString()), items: [] });
      if (utf8ByteLength(envelope) + totals.bytes + Math.max(0, totals.count - 1) > MAX_PAYLOAD_BYTES) {
        throw new Error('A identificação aumentaria o inventário além de 8 MB. Use um nome mais curto.');
      }
      const organization = metadata.organization ?? draft.organization;
      await this.db.runAsync("UPDATE inventories SET title=?,location=?,organization=? WHERE id=? AND owner=? AND state='draft'", metadata.title, metadata.location, organization ? JSON.stringify(organization) : null, id, owner);
    });
  }

  async list(owner: string): Promise<InventorySummary[]> {
    const rows = await this.db.getAllAsync<Draft & { count: number }>(
      'SELECT inventories.*, (SELECT COUNT(*) FROM items WHERE inventoryId=inventories.id) AS count FROM inventories WHERE owner=? ORDER BY startedAt DESC', owner);
    return rows.map(row => ({ ...draftSchema.parse(row), count: row.count }));
  }

  async get(owner: string, id: string): Promise<Draft> {
    const row = await this.db.getFirstAsync<Draft>('SELECT * FROM inventories WHERE id=? AND owner=?', id, owner);
    if (!row) throw new Error('Inventário não encontrado nesta conta.');
    return draftSchema.parse(row);
  }

  async items(owner: string, id: string): Promise<InventoryItem[]> {
    await this.get(owner, id);
    const rows = await this.db.getAllAsync<{ json: string }>('SELECT json FROM items WHERE inventoryId=? ORDER BY rowid DESC', id);
    return rows.map(row => itemSchema.parse(JSON.parse(row.json)));
  }

  add(owner: string, id: string, input: InventoryItem): Promise<void> {
    return this.serialize(async () => {
      const draft = await this.get(owner, id);
      if (draft.state !== 'draft') throw new Error('Inventário concluído. Inicie outra coleta para novos itens.');
      const item = itemSchema.parse(input);
      const duplicate = await this.db.getFirstAsync<{ id: string }>('SELECT id FROM items WHERE inventoryId=? AND ns=?', id, item.ns);
      if (duplicate) throw new Error(`NS ${item.ns} já foi contado neste inventário.`);
      const totals = await this.itemTotals(id);
      if (totals.count >= MAX_ITEMS) throw new Error(`Limite de ${MAX_ITEMS} itens atingido. Conclua este inventário e inicie outro.`);
      const json = JSON.stringify(item);
      const envelope = JSON.stringify({ ...this.basePayload(draft, new Date().toISOString()), items: [] });
      const projectedBytes = utf8ByteLength(envelope) + totals.bytes + utf8ByteLength(json) + totals.count;
      if (projectedBytes > MAX_PAYLOAD_BYTES) {
        throw new Error('Limite de 8 MB atingido. Esta unidade não foi salva. Conclua a coleta atual e inicie outra para continuar.');
      }
      await this.db.runAsync('INSERT INTO items(id,inventoryId,ns,json) VALUES (?,?,?,?)', item.id, id, item.ns, json);
    });
  }

  importInventories(owner: string, inputs: Inventory[]): Promise<{ imported: number; skipped: number }> {
    return this.serialize(async () => {
      if (!owner || !inputs.length || inputs.length > 1000) throw new Error('Backup inválido.');
      const inventories = inputs.map(input => inventorySchema.parse(input));
      let imported = 0;
      let skipped = 0;
      await this.db.execAsync('SAVEPOINT restore_backup');
      try {
        for (const inventory of inventories) {
          const existing = await this.db.getFirstAsync<{ owner: string }>('SELECT owner FROM inventories WHERE id=?', inventory.id);
          if (existing) {
            if (existing.owner !== owner) throw new Error('Um identificador do backup já está em uso neste aparelho. Nenhum dado foi importado.');
            skipped++;
            continue;
          }
          await this.db.runAsync('INSERT INTO inventories(id,owner,title,location,startedAt,catalogVersion,organization) VALUES (?,?,?,?,?,?,?)',
            inventory.id, owner, inventory.title, inventory.location, inventory.startedAt, inventory.catalogVersion,
            inventory.organization ? JSON.stringify(inventory.organization) : null);
          for (const item of inventory.items) {
            await this.db.runAsync('INSERT INTO items(id,inventoryId,ns,json) VALUES (?,?,?,?)', item.id, inventory.id, item.ns, JSON.stringify(item));
          }
          imported++;
        }
        await this.db.execAsync('RELEASE restore_backup');
        return { imported, skipped };
      } catch (failure) {
        await this.db.execAsync('ROLLBACK TO restore_backup; RELEASE restore_backup');
        throw failure;
      }
    });
  }

  remove(owner: string, id: string, itemId: string): Promise<void> {
    return this.serialize(async () => {
      const draft = await this.get(owner, id);
      if (draft.state !== 'draft') throw new Error('Inventário concluído não pode ser alterado.');
      const result = await this.db.runAsync('DELETE FROM items WHERE id=? AND inventoryId=?', itemId, id);
      if (!result.changes) throw new Error('O item não foi encontrado.');
    });
  }

  deleteInventory(owner: string, id: string): Promise<void> {
    return this.serialize(async () => {
      await this.db.execAsync('SAVEPOINT delete_inventory');
      try {
        const draft = await this.get(owner, id);
        if (draft.state === 'sending') throw new Error('Aguarde o envio terminar antes de excluir este inventário.');
        await this.db.runAsync('DELETE FROM items WHERE inventoryId=?', id);
        const result = await this.db.runAsync("DELETE FROM inventories WHERE id=? AND owner=? AND state<>'sending'", id, owner);
        if (!result.changes) throw new Error('O inventário não pode ser excluído no estado atual.');
        await this.db.execAsync('RELEASE delete_inventory');
      } catch (failure) {
        await this.db.execAsync('ROLLBACK TO delete_inventory; RELEASE delete_inventory');
        throw failure;
      }
    });
  }

  finish(owner: string, id: string): Promise<void> {
    return this.serialize(async () => {
      const draft = await this.get(owner, id);
      if (draft.state !== 'draft') throw new Error('Este inventário já está concluído.');
      const completedAt = new Date().toISOString();
      inventorySchema.parse({ ...this.basePayload(draft, completedAt), items: await this.items(owner, id) });
      await this.db.runAsync("UPDATE inventories SET completedAt=?,state='queued',lastError='' WHERE id=? AND owner=? AND state='draft'", completedAt, id, owner);
    });
  }

  private basePayload(draft: Draft, completedAt: string) {
    return { id: draft.id, title: draft.title, location: draft.location, startedAt: draft.startedAt, completedAt, catalogVersion: draft.catalogVersion, ...(draft.organization ? { organization: draft.organization } : {}) };
  }

  private async itemTotals(id: string) {
    const totals = await this.db.getFirstAsync<{ count: number; bytes: number }>(
      'SELECT COUNT(*) AS count, COALESCE(SUM(LENGTH(CAST(json AS BLOB))),0) AS bytes FROM items WHERE inventoryId=?', id);
    if (!totals) throw new Error('Não foi possível conferir o tamanho da coleta.');
    return totals;
  }

  async payload(owner: string, id: string): Promise<Inventory> {
    const draft = await this.get(owner, id);
    if (!draft.completedAt || draft.state === 'draft') throw new Error('Conclua o inventário antes de enviar.');
    return inventorySchema.parse({ ...this.basePayload(draft, draft.completedAt), items: await this.items(owner, id) });
  }

  // A serialized snapshot allows offline backup without freezing a draft or
  // changing the queue. The owner is checked exactly as for normal submission.
  snapshot(owner: string, id: string): Promise<Inventory> {
    return this.serialize(async () => {
      const draft = await this.get(owner, id);
      return inventorySchema.parse({
        ...this.basePayload(draft, draft.completedAt ?? new Date().toISOString()),
        items: await this.items(owner, id),
      });
    });

  }

  // Persisted before any network call, so an interrupted send is never retried silently.
  markSending(owner: string, id: string): Promise<boolean> {
    return this.serialize(async () => {
      const result = await this.db.runAsync("UPDATE inventories SET state='sending',lastError='' WHERE id=? AND owner=? AND state='queued'", id, owner);
      // A queued inventory may have been deleted while its email was prepared.
      // Only the caller that claims it may transmit anything.
      return result.changes > 0;
    });
  }

  settle(owner: string, id: string, outcome: DeliveryOutcome): Promise<void> {
    return this.serialize(async () => {
      const receipt: Receipt = receiptSchema.parse({
        id, status: outcome.status, message: outcome.message.slice(0, 2000),
        updatedAt: new Date().toISOString(), warnings: outcome.warnings.slice(0, 100000),
      });
      const lastError = outcome.status === 'sent' ? '' : receipt.message;
      const result = await this.db.runAsync("UPDATE inventories SET state=?,receipt=?,lastError=? WHERE id=? AND owner=? AND state='sending'",
        outcome.status, JSON.stringify(receipt), lastError, id, owner);
      if (!result.changes) throw new Error('Não foi possível registrar o resultado do envio no aparelho.');
    });
  }

  requeue(owner: string, id: string, allowUncertain: boolean): Promise<void> {
    return this.serialize(async () => {
      const states = allowUncertain ? "('failed','uncertain')" : "('failed')";
      const result = await this.db.runAsync(`UPDATE inventories SET state='queued',lastError='' WHERE id=? AND owner=? AND state IN ${states}`, id, owner);
      if (!result.changes) throw new Error('Este envio não pode ser repetido no estado atual.');
    });
  }

  // A send interrupted by app termination may or may not have reached Gmail.
  recoverInterrupted(): Promise<number> {
    return this.serialize(async () => {
      const rows = await this.db.getAllAsync<{ id: string }>("SELECT id FROM inventories WHERE state='sending'");
      for (const row of rows) {
        const receipt: Receipt = receiptSchema.parse({
          id: row.id, status: 'uncertain', updatedAt: new Date().toISOString(), warnings: [],
          message: 'O aplicativo foi fechado durante o envio. Confira a pasta Enviados do seu Gmail antes de reenviar.',
        });
        await this.db.runAsync("UPDATE inventories SET state='uncertain',receipt=?,lastError=? WHERE id=? AND state='sending'",
          JSON.stringify(receipt), receipt.message, row.id);
      }
      return rows.length;
    });
  }

  async saveError(owner: string, id: string, message: string): Promise<void> {
    await this.db.runAsync('UPDATE inventories SET lastError=? WHERE id=? AND owner=?', message, id, owner);
  }
}
