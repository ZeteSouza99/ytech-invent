import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { inventorySchema, receiptSchema, userSchema, type Inventory, type Receipt, type User } from '../shared/model.ts';

type StoredRow = { owner: string; payload_hash: string; payload: string; user: string; receipt: string };
export type StoredInventory = { inventory: Inventory; user: User; receipt: Receipt };

export class InventoryConflictError extends Error {}
export class InventoryNotFoundError extends Error {}
export class InventoryRetryError extends Error {}

const messages: Record<Receipt['status'], string> = {
  accepted: 'Inventário salvo no servidor, aguardando envio.',
  sending: 'Envio em andamento. Aguarde a confirmação do servidor.',
  sent: 'O servidor SMTP aceitou a mensagem para Lorena. Isso não confirma entrega ou leitura.',
  failed: 'Não foi possível enviar. O inventário está salvo; tente novamente explicitamente.',
  uncertain: 'O envio pode ter sido aceito, mas não foi confirmado. Consulte Lorena ou o administrador antes de qualquer novo envio.',
};

export class InventoryStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS inventories (
        id TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        payload TEXT NOT NULL,
        user TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('accepted','sending','sent','failed','uncertain')),
        receipt TEXT NOT NULL
      );
    `);
    // Apenas uma instância da API deve abrir este banco; envio interrompido não é repetido.
    const interrupted = this.db.prepare("SELECT id, receipt FROM inventories WHERE status = 'sending'")
      .all() as { id: string; receipt: string }[];
    for (const row of interrupted) {
      const receipt = receiptSchema.parse(JSON.parse(row.receipt));
      this.settle(row.id, 'uncertain', receipt.warnings);
    }
  }

  accept(inventory: Inventory, user: User): StoredInventory {
    inventory = { ...inventory, id: inventory.id.toLowerCase() };
    const payload = JSON.stringify(inventory);
    const hash = createHash('sha256').update(payload).digest('hex');
    const receipt = this.makeReceipt(inventory.id, 'accepted', []);
    this.db.prepare(`
      INSERT INTO inventories (id, owner, payload_hash, payload, user, status, receipt)
      VALUES (?, ?, ?, ?, ?, 'accepted', ?) ON CONFLICT(id) DO NOTHING
    `).run(inventory.id, user.sub, hash, payload, JSON.stringify(user), JSON.stringify(receipt));
    const row = this.readRow(inventory.id, user.sub);
    if (row.payload_hash !== hash) throw new InventoryConflictError();
    return this.decode(row);
  }

  get(id: string, owner: string): StoredInventory {
    return this.decode(this.readRow(id, owner));
  }

  claim(id: string, owner: string, retry = false): StoredInventory | undefined {
    id = id.toLowerCase();
    const current = this.get(id, owner);
    if (retry && current.receipt.status !== 'failed') throw new InventoryRetryError();
    const expected = retry ? 'failed' : 'accepted';
    const next = this.makeReceipt(id, 'sending', current.receipt.warnings);
    const result = this.db.prepare(`
      UPDATE inventories SET status = 'sending', receipt = ?
      WHERE id = ? AND owner = ? AND status = ?
    `).run(JSON.stringify(next), id, owner, expected);
    if (result.changes === 0) return undefined;
    return { ...current, receipt: next };
  }

  settle(id: string, status: 'sent' | 'failed' | 'uncertain', warnings: string[]): void {
    id = id.toLowerCase();
    const receipt = receiptSchema.parse(this.makeReceipt(id, status, warnings));
    this.db.prepare(`
      UPDATE inventories SET status = ?, receipt = ? WHERE id = ? AND status = 'sending'
    `).run(status, JSON.stringify(receipt), id);
  }

  annotateSending(id: string, warnings: string[]): void {
    id = id.toLowerCase();
    const receipt = receiptSchema.parse(this.makeReceipt(id, 'sending', warnings));
    this.db.prepare("UPDATE inventories SET receipt = ? WHERE id = ? AND status = 'sending'")
      .run(JSON.stringify(receipt), id);
  }

  ready(): boolean {
    try {
      this.db.prepare('SELECT 1').get();
      return true;
    } catch {
      return false;
    }
  }

  close(): void {
    this.db.close();
  }

  private makeReceipt(id: string, status: Receipt['status'], warnings: string[]): Receipt {
    return { id, status, message: messages[status], updatedAt: new Date().toISOString(), warnings };
  }

  private readRow(id: string, owner: string): StoredRow {
    const row = this.db.prepare('SELECT owner, payload_hash, payload, user, receipt FROM inventories WHERE id = ?')
      .get(id.toLowerCase()) as StoredRow | undefined;
    if (!row || row.owner !== owner) throw new InventoryNotFoundError();
    return row;
  }

  private decode(row: StoredRow): StoredInventory {
    return {
      inventory: inventorySchema.parse(JSON.parse(row.payload)),
      user: userSchema.parse(JSON.parse(row.user)),
      receipt: receiptSchema.parse(JSON.parse(row.receipt)),
    };
  }
}
