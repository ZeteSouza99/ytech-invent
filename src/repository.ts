import { z } from 'zod';
import { organizationSchema, type Organization } from '../shared/company';
import {
  DEFAULT_RECIPIENT, errorMessage, inventorySchema, inventoryTextSchema, itemSchema, MAX_BACKUP_INVENTORIES, MAX_ITEMS, MAX_PAYLOAD_BYTES,
  partNumberSchema, receiptSchema, recipientSchema, utf8ByteLength, type Inventory, type InventoryItem, type Receipt,
} from '../shared/model';

type SqlValue = string | number | null;
export interface LocalDatabase {
  execAsync(sql: string): Promise<void>;
  runAsync(sql: string, ...values: SqlValue[]): Promise<{ changes: number }>;
  getFirstAsync<T>(sql: string, ...values: SqlValue[]): Promise<T | null>;
  getAllAsync<T>(sql: string, ...values: SqlValue[]): Promise<T[]>;
}

export const INVENTORY_STATES = ['draft', 'queued', 'sending', 'sent', 'failed', 'uncertain'] as const;
export type InventoryState = typeof INVENTORY_STATES[number];

export type Draft = {
  id: string;
  owner: string;
  title: string;
  location: string;
  startedAt: string;
  completedAt: string | null;
  catalogVersion: string;
  state: InventoryState;
  lastError: string;
  receipt: string | null;
  organization?: Organization;
  // E-mail chosen when the inventory was concluded; absent for inventories concluded before 1.1.2.
  recipient?: string;
  // Present when stored data can no longer be read; the inventory stays visible so it can be repaired or deleted.
  problem?: string;
};
export type InventorySummary = Draft & { count: number };
export type DeliveryOutcome = { status: 'sent' | 'failed' | 'uncertain'; message: string; warnings: string[] };
export type UnitChanges = { location: string; patrimony?: string };

// Reading is more tolerant than writing: validation rules may tighten in later versions, and data saved
// under older rules must stay visible for repair instead of making every inventory of the account unreadable.
// Writes, conclusion, export and submission always use the current contract.
const storedLabelSchema = z.string().min(1).max(120);
const storedOrganizationSchema = z.object({
  kind: z.enum(['internal', 'external']),
  name: z.string().min(1).max(200),
  cnpj: z.string().min(1).max(18),
});
const rowSchema = z.object({
  id: z.string().min(1).max(64), owner: z.string().min(1), title: storedLabelSchema, location: storedLabelSchema,
  startedAt: z.iso.datetime(), completedAt: z.iso.datetime().nullable(), catalogVersion: z.string().min(1),
  state: z.enum(INVENTORY_STATES), lastError: z.string(), receipt: z.string().nullable(),
  organization: z.string().nullable().optional(), recipient: z.string().nullable().optional(),
});
const storedItemSchema = z.object({
  id: z.string().min(1).max(64), pn: z.string().min(1).max(120), ns: z.string().min(1).max(80),
  location: z.string().min(1).max(120), quantity: z.literal(1), capturedAt: z.iso.datetime(),
  source: z.enum(['barcode', 'manual', 'ocr']), rawPn: z.string().max(2048), rawNs: z.string().max(2048),
  confirmed: z.literal(true), patrimony: z.string().min(1).max(80).optional(),
});
const metadataSchema = z.object({ title: inventoryTextSchema, location: inventoryTextSchema, organization: organizationSchema.optional() }).strict();
const newDraftSchema = z.object({ id: z.uuid(), owner: z.string().min(1), startedAt: z.iso.datetime(), catalogVersion: z.string().min(1) });

const ORGANIZATION_PROBLEM = 'A identificação da empresa salva neste inventário está ilegível. Edite a identificação antes de concluir ou exportar; as unidades estão preservadas.';
const DAMAGED_PROBLEM = 'Os dados deste inventário não puderam ser lidos neste aparelho. Nada foi apagado; exporte as demais coletas e procure o suporte antes de excluí-lo.';
const CLOCK_BEHIND = 'A data e a hora do aparelho estão antes do início desta coleta. Corrija o relógio do aparelho e salve de novo; esta unidade não foi gravada.';
const RECIPIENT_SETTING = 'recipient';

// Applied in order; PRAGMA user_version records how many already ran. Never edit a released step: append a new one.
const MIGRATIONS: ((db: LocalDatabase) => Promise<void>)[] = [
  async db => {
    await db.execAsync(`
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
  },
  // Version 1.1.0 added the column without recording a schema version; databases created by it already have it.
  async db => {
    const columns = await db.getAllAsync<{ name: string }>('PRAGMA table_info(inventories)');
    if (!columns.some(column => column.name === 'organization')) {
      await db.execAsync('ALTER TABLE inventories ADD COLUMN organization TEXT');
    }
  },
  // Recipient chosen when concluding, and per-account settings such as the default recipient.
  async db => {
    await db.execAsync(`
      ALTER TABLE inventories ADD COLUMN recipient TEXT;
      CREATE TABLE IF NOT EXISTS settings (owner TEXT NOT NULL, name TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (owner, name));
    `);
  },
];

function parseOrganization(text: string): Organization | null {
  try {
    const parsed = storedOrganizationSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function toDraft(row: unknown): Draft {
  const { organization: stored, recipient, ...fields } = rowSchema.parse(row);
  const draft: Draft = { ...fields, ...(recipient ? { recipient } : {}) };
  if (stored) {
    const organization = parseOrganization(stored);
    if (organization) draft.organization = organization;
    else draft.problem = ORGANIZATION_PROBLEM;
  }
  return draft;
}

// Keeps a row that no longer matches the schema visible, flagged, and out of the submission path.
function damagedSummary(row: Record<string, unknown>): InventorySummary {
  const text = (value: unknown, fallback: string) => typeof value === 'string' && value.trim() ? value.slice(0, 120) : fallback;
  const startedAt = typeof row.startedAt === 'string' && !Number.isNaN(Date.parse(row.startedAt)) ? row.startedAt : new Date(0).toISOString();
  return {
    id: String(row.id), owner: String(row.owner), title: text(row.title, 'Inventário ilegível'), location: text(row.location, '—'),
    startedAt, completedAt: null, catalogVersion: text(row.catalogVersion, '—'),
    state: INVENTORY_STATES.find(state => state === row.state) ?? 'failed',
    lastError: '', receipt: null, problem: DAMAGED_PROBLEM, count: Number(row.count) || 0,
  };
}

function readStoredItem(row: { id: string; json: string }): InventoryItem {
  try {
    return storedItemSchema.parse(JSON.parse(row.json));
  } catch {
    throw new Error(`Uma leitura salva neste inventário está ilegível (registro ${row.id}). Nada foi apagado; procure o suporte.`);
  }
}

// The device clock may be corrected backwards after the readings. The conclusion never precedes a reading,
// so a clock change cannot make an inventory impossible to conclude or export.
function completionTime(startedAt: string, items: readonly { capturedAt: string }[]): string {
  let latest = Math.max(Date.now(), Date.parse(startedAt));
  for (const item of items) latest = Math.max(latest, Date.parse(item.capturedAt));
  return new Date(latest).toISOString();
}

function basePayload(draft: Draft, completedAt: string) {
  return { id: draft.id, title: draft.title, location: draft.location, startedAt: draft.startedAt, completedAt, catalogVersion: draft.catalogVersion, ...(draft.organization ? { organization: draft.organization } : {}) };
}

export class InventoryRepository {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly db: LocalDatabase) {}

  // Every write goes through this queue so validations and the write that depends on them are never interleaved.
  private serialize<T>(action: () => Promise<T>): Promise<T> {
    const result = this.tail.then(action);
    // Keep the write queue usable after an error; the caller still receives the rejection.
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  // Runs inside the write queue; never call another serialized method from `action`.
  private async transaction<T>(name: string, action: () => Promise<T>): Promise<T> {
    await this.db.execAsync(`SAVEPOINT ${name}`);
    try {
      const result = await action();
      await this.db.execAsync(`RELEASE ${name}`);
      return result;
    } catch (failure) {
      await this.db.execAsync(`ROLLBACK TO ${name}; RELEASE ${name}`);
      throw failure;
    }
  }

  initialize(): Promise<void> {
    return this.serialize(async () => {
      await this.db.execAsync('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
      const current = (await this.db.getFirstAsync<{ user_version: number }>('PRAGMA user_version'))?.user_version ?? 0;
      if (current > MIGRATIONS.length) {
        throw new Error('Os dados foram gravados por uma versão mais nova do Ytech Invent. Instale a versão mais recente; nada foi alterado.');
      }
      for (let version = current; version < MIGRATIONS.length; version += 1) {
        await this.transaction('migration', async () => {
          await MIGRATIONS[version]!(this.db);
          await this.db.execAsync(`PRAGMA user_version = ${version + 1}`);
        });
      }
    });
  }

  create(input: Draft): Promise<void> {
    return this.serialize(async () => {
      const metadata = metadataSchema.parse({ title: input.title, location: input.location, organization: input.organization });
      const draft = newDraftSchema.parse(input);
      if (input.state !== 'draft' || input.completedAt) throw new Error('Um inventário novo deve estar em coleta.');
      await this.db.runAsync('INSERT INTO inventories(id,owner,title,location,startedAt,catalogVersion,organization) VALUES (?,?,?,?,?,?,?)',
        draft.id, draft.owner, metadata.title, metadata.location, draft.startedAt, draft.catalogVersion,
        metadata.organization ? JSON.stringify(metadata.organization) : null);
    });
  }

  updateMetadata(owner: string, id: string, input: { title: string; location: string; organization?: Organization }): Promise<void> {
    return this.serialize(async () => {
      const metadata = metadataSchema.parse(input);
      const draft = await this.get(owner, id);
      if (draft.state !== 'draft') throw new Error('Inventário concluído não pode ser alterado.');
      const totals = await this.itemTotals(id);
      const organization = metadata.organization ?? draft.organization;
      const envelope = JSON.stringify({ ...basePayload({ ...draft, ...metadata, ...(organization ? { organization } : {}) }, new Date().toISOString()), items: [] });
      if (utf8ByteLength(envelope) + totals.bytes + Math.max(0, totals.count - 1) > MAX_PAYLOAD_BYTES) {
        throw new Error('A identificação aumentaria o inventário além de 8 MB. Use um nome mais curto.');
      }
      await this.db.runAsync("UPDATE inventories SET title=?,location=?,organization=? WHERE id=? AND owner=? AND state='draft'",
        metadata.title, metadata.location, organization ? JSON.stringify(organization) : null, id, owner);
    });
  }

  async list(owner: string): Promise<InventorySummary[]> {
    const rows = await this.db.getAllAsync<Record<string, unknown>>(
      'SELECT inventories.*, (SELECT COUNT(*) FROM items WHERE inventoryId=inventories.id) AS count FROM inventories WHERE owner=? ORDER BY startedAt DESC', owner);
    return rows.map(row => {
      try {
        return { ...toDraft(row), count: Number(row.count) };
      } catch {
        return damagedSummary(row);
      }
    });
  }

  async get(owner: string, id: string): Promise<Draft> {
    const row = await this.db.getFirstAsync<Record<string, unknown>>('SELECT * FROM inventories WHERE id=? AND owner=?', id, owner);
    if (!row) throw new Error('Inventário não encontrado nesta conta.');
    try {
      return toDraft(row);
    } catch {
      throw new Error(DAMAGED_PROBLEM);
    }
  }

  async items(owner: string, id: string): Promise<InventoryItem[]> {
    await this.get(owner, id);
    return this.readItems(id);
  }

  private async readItems(id: string): Promise<InventoryItem[]> {
    const rows = await this.db.getAllAsync<{ id: string; json: string }>('SELECT id, json FROM items WHERE inventoryId=? ORDER BY rowid DESC', id);
    return rows.map(readStoredItem);
  }

  // Every part number this account has saved on this device; unreadable rows are skipped, not fatal.
  async partNumbers(owner: string): Promise<string[]> {
    // Nested CASE keeps json_type away from malformed JSON, which would make the whole query fail.
    const rows = await this.db.getAllAsync<{ pn: unknown }>(
      `SELECT DISTINCT CASE WHEN json_valid(items.json) THEN
         CASE WHEN json_type(items.json, '$.pn') = 'text' THEN json_extract(items.json, '$.pn') END END AS pn
       FROM items JOIN inventories ON inventories.id = items.inventoryId WHERE inventories.owner = ?`, owner);
    return [...new Set(rows.flatMap(row => {
      const parsed = partNumberSchema.safeParse(row.pn);
      return parsed.success ? [parsed.data] : [];
    }))];
  }

  add(owner: string, id: string, input: InventoryItem): Promise<InventoryItem> {
    return this.serialize(async () => {
      const draft = await this.get(owner, id);
      if (draft.state !== 'draft') throw new Error('Inventário concluído. Inicie outra coleta para novos itens.');
      const item = itemSchema.parse(input);
      if (Date.parse(item.capturedAt) < Date.parse(draft.startedAt)) throw new Error(CLOCK_BEHIND);
      const duplicate = await this.db.getFirstAsync<{ id: string }>('SELECT id FROM items WHERE inventoryId=? AND ns=?', id, item.ns);
      if (duplicate) throw new Error(`NS ${item.ns} já foi contado neste inventário.`);
      const totals = await this.itemTotals(id);
      if (totals.count >= MAX_ITEMS) throw new Error(`Limite de ${MAX_ITEMS} itens atingido. Conclua este inventário e inicie outro.`);
      const json = JSON.stringify(item);
      const envelope = JSON.stringify({ ...basePayload(draft, new Date().toISOString()), items: [] });
      const projectedBytes = utf8ByteLength(envelope) + totals.bytes + utf8ByteLength(json) + totals.count;
      if (projectedBytes > MAX_PAYLOAD_BYTES) {
        throw new Error('Limite de 8 MB atingido. Esta unidade não foi salva. Conclua a coleta atual e inicie outra para continuar.');
      }
      await this.db.runAsync('INSERT INTO items(id,inventoryId,ns,json) VALUES (?,?,?,?)', item.id, id, item.ns, json);
      return item;
    });
  }

  // PN and NS are not editable: a wrong reading is removed and read again from the label.
  updateItem(owner: string, id: string, itemId: string, changes: UnitChanges): Promise<InventoryItem> {
    return this.serialize(async () => {
      const draft = await this.get(owner, id);
      if (draft.state !== 'draft') throw new Error('Inventário concluído não pode ser alterado.');
      const row = await this.db.getFirstAsync<{ id: string; json: string }>('SELECT id, json FROM items WHERE id=? AND inventoryId=?', itemId, id);
      if (!row) throw new Error('O item não foi encontrado.');
      const { patrimony: _previous, ...current } = readStoredItem(row);
      const patrimony = changes.patrimony?.trim();
      const item = itemSchema.parse({ ...current, location: changes.location, ...(patrimony ? { patrimony } : {}) });
      const json = JSON.stringify(item);
      const totals = await this.itemTotals(id);
      const envelope = JSON.stringify({ ...basePayload(draft, new Date().toISOString()), items: [] });
      const projectedBytes = utf8ByteLength(envelope) + totals.bytes - utf8ByteLength(row.json) + utf8ByteLength(json) + Math.max(0, totals.count - 1);
      if (projectedBytes > MAX_PAYLOAD_BYTES) throw new Error('A alteração aumentaria o inventário além de 8 MB. Use um texto mais curto.');
      await this.db.runAsync('UPDATE items SET json=? WHERE id=? AND inventoryId=?', json, itemId, id);
      return item;
    });
  }

  importInventories(owner: string, inputs: Inventory[]): Promise<{ imported: number; skipped: number }> {
    return this.serialize(async () => {
      if (!owner || !inputs.length || inputs.length > MAX_BACKUP_INVENTORIES) throw new Error('Backup inválido.');
      const inventories = inputs.map(input => inventorySchema.parse(input));
      return this.transaction('restore_backup', async () => {
        let imported = 0;
        let skipped = 0;
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
        return { imported, skipped };
      });
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

  // Checks only ownership and state, so an inventory whose data can no longer be read can still be deleted.
  deleteInventory(owner: string, id: string): Promise<void> {
    return this.serialize(() => this.transaction('delete_inventory', async () => {
      const row = await this.db.getFirstAsync<{ owner: string; state: string }>('SELECT owner, state FROM inventories WHERE id=?', id);
      if (!row || row.owner !== owner) throw new Error('Inventário não encontrado nesta conta.');
      if (row.state === 'sending') throw new Error('Aguarde o envio terminar antes de excluir este inventário.');
      await this.db.runAsync('DELETE FROM items WHERE inventoryId=?', id);
      const result = await this.db.runAsync("DELETE FROM inventories WHERE id=? AND owner=? AND state<>'sending'", id, owner);
      if (!result.changes) throw new Error('O inventário não pode ser excluído no estado atual.');
    }));
  }

  // The recipient is fixed with the inventory, so a later change of the default never redirects a queued send.
  finish(owner: string, id: string, recipient: string = DEFAULT_RECIPIENT): Promise<void> {
    return this.serialize(async () => {
      const to = recipientSchema.parse(recipient);
      const draft = await this.get(owner, id);
      if (draft.state !== 'draft') throw new Error('Este inventário já está concluído.');
      const inventory = await this.validated(draft, null);
      await this.db.runAsync("UPDATE inventories SET completedAt=?,state='queued',lastError='',recipient=? WHERE id=? AND owner=? AND state='draft'",
        inventory.completedAt, to, id, owner);
    });
  }

  // Allowed while nothing was transmitted: waiting in the queue or after a refused send.
  updateRecipient(owner: string, id: string, recipient: string): Promise<void> {
    return this.serialize(async () => {
      const to = recipientSchema.parse(recipient);
      await this.get(owner, id);
      const result = await this.db.runAsync("UPDATE inventories SET recipient=? WHERE id=? AND owner=? AND state IN ('queued','failed')", to, id, owner);
      if (!result.changes) throw new Error('O destinatário só pode ser alterado enquanto o envio está pendente ou depois de uma falha.');
    });
  }

  async defaultRecipient(owner: string): Promise<string> {
    const row = await this.db.getFirstAsync<{ value: string }>('SELECT value FROM settings WHERE owner=? AND name=?', owner, RECIPIENT_SETTING);
    const parsed = recipientSchema.safeParse(row?.value);
    return parsed.success ? parsed.data : DEFAULT_RECIPIENT;
  }

  setDefaultRecipient(owner: string, recipient: string): Promise<string> {
    return this.serialize(async () => {
      if (!owner) throw new Error('Conta não disponível.');
      const to = recipientSchema.parse(recipient);
      await this.db.runAsync('INSERT INTO settings(owner,name,value) VALUES (?,?,?) ON CONFLICT(owner,name) DO UPDATE SET value=excluded.value',
        owner, RECIPIENT_SETTING, to);
      return to;
    });
  }

  // Builds the inventory exactly as it will be sent or exported, with the current validation rules.
  private async validated(draft: Draft, completedAt: string | null): Promise<Inventory> {
    if (draft.problem) throw new Error(draft.problem);
    const items = await this.readItems(draft.id);
    for (const item of items) {
      const parsed = itemSchema.safeParse(item);
      if (!parsed.success) throw new Error(`NS ${item.ns}: ${errorMessage(parsed.error)}`);
    }
    return inventorySchema.parse({ ...basePayload(draft, completedAt ?? completionTime(draft.startedAt, items)), items });
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
    return this.validated(draft, draft.completedAt);
  }

  // A serialized snapshot allows offline backup without freezing a draft or
  // changing the queue. The owner is checked exactly as for normal submission.
  snapshot(owner: string, id: string): Promise<Inventory> {
    return this.serialize(async () => {
      const draft = await this.get(owner, id);
      return this.validated(draft, draft.completedAt);
    });
  }

  // Persisted before any network call, so an interrupted send is never retried silently.
  // With `recipient`, the claim also fails when the recipient changed after the message was built.
  markSending(owner: string, id: string, recipient?: string): Promise<boolean> {
    return this.serialize(async () => {
      const result = recipient === undefined
        ? await this.db.runAsync("UPDATE inventories SET state='sending',lastError='' WHERE id=? AND owner=? AND state='queued'", id, owner)
        : await this.db.runAsync("UPDATE inventories SET state='sending',lastError='' WHERE id=? AND owner=? AND state='queued' AND COALESCE(NULLIF(recipient,''),?)=?",
          id, owner, DEFAULT_RECIPIENT, recipient);
      // A queued inventory may have been deleted or redirected while its email was prepared.
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

  saveError(owner: string, id: string, message: string): Promise<void> {
    return this.serialize(async () => {
      await this.db.runAsync('UPDATE inventories SET lastError=? WHERE id=? AND owner=?', message, id, owner);
    });
  }
}
