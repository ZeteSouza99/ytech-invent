import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { InventoryRepository, type Draft, type LocalDatabase } from '../src/repository';
import { Outbox, type Delivery } from '../src/outbox';
import type { TransmitResult } from '../shared/gmail';
import { inventorySchema, itemSchema, MAX_PAYLOAD_BYTES, type Inventory, type InventoryItem } from '../shared/model';
import { YTECH_CNPJ, YTECH_NAME } from '../shared/company';

function connect(path = ':memory:') {
  const sqlite = new DatabaseSync(path);
  const db: LocalDatabase = {
    async execAsync(sql) { sqlite.exec(sql); },
    async runAsync(sql, ...params) { return { changes: Number(sqlite.prepare(sql).run(...params).changes) }; },
    async getFirstAsync<T>(sql: string, ...params: (string | number | null)[]) { return (sqlite.prepare(sql).get(...params) as T | undefined) ?? null; },
    async getAllAsync<T>(sql: string, ...params: (string | number | null)[]) { return sqlite.prepare(sql).all(...params) as T[]; },
  };
  return { sqlite, repository: new InventoryRepository(db) };
}

function draft(): Draft {
  return { id: randomUUID(), owner: '123', title: 'Coleta', location: 'MZ01-E01-N01', startedAt: '2026-01-01T00:00:00.000Z', completedAt: null, catalogVersion: 'v1', state: 'draft', lastError: '', receipt: null };
}
function item(ns = '00123'): InventoryItem {
  return { id: randomUUID(), pn: 'MC3401-0G1R64SS-A6', ns, location: 'MZ01-E01-N01', quantity: 1, capturedAt: new Date().toISOString(), source: 'barcode', rawPn: 'MC3401-0G1R64SS-A6', rawNs: ns, confirmed: true };
}

const sent: TransmitResult = { status: 'sent', messageId: 'gmail-123' };

function fakeDelivery(transmit: (raw: string, token: string) => Promise<TransmitResult>, overrides: Partial<Delivery> = {}) {
  const calls = { tokens: [] as boolean[], transmit: [] as string[] };
  const delivery: Delivery = {
    async prepare(_owner, inventory) { return { raw: `raw:${inventory.title}`, warnings: ['aviso'] }; },
    async accessToken(_owner, refresh) { calls.tokens.push(refresh); return refresh ? 'fresh' : 'cached'; },
    async transmit(raw, token) { calls.transmit.push(`${raw}|${token}`); return transmit(raw, token); },
    ...overrides,
  };
  return { delivery, calls };
}

async function queued(repository: InventoryRepository, overrides: Partial<Draft> = {}): Promise<Draft> {
  const d = { ...draft(), ...overrides };
  await repository.create(d);
  await repository.add(d.owner, d.id, item());
  await repository.finish(d.owner, d.id);
  return d;
}

function fullPayload(d: Draft): Inventory {
  const payload: Inventory = {
    id: d.id, title: d.title, location: d.location, startedAt: d.startedAt,
    completedAt: new Date().toISOString(), catalogVersion: d.catalogVersion,
    items: Array.from({ length: 2200 }, (_, index) => itemSchema.parse({ ...item(`SERIAL-${index}`), rawPn: '', rawNs: '' })),
  };
  payload.completedAt = new Date().toISOString();
  let remaining = MAX_PAYLOAD_BYTES - Buffer.byteLength(JSON.stringify(payload));
  for (const entry of payload.items) {
    for (const key of ['rawPn', 'rawNs'] as const) {
      const length = Math.min(2048, remaining);
      entry[key] = 'A'.repeat(length);
      remaining -= length;
    }
  }
  expect(remaining).toBe(0);
  return payload;
}

describe('armazenamento local e fila', () => {
  it.each(['draft', 'queued', 'sent', 'failed', 'uncertain'] as const)('exclui inventário %s e suas unidades sem afetar outra coleta', async state => {
    const { repository, sqlite } = connect();
    try {
      await repository.initialize();
      const d = draft();
      await repository.create(d);
      await repository.add(d.owner, d.id, item());
      const other = await queued(repository);
      if (state !== 'draft') await repository.finish(d.owner, d.id);
      if (state !== 'draft' && state !== 'queued') {
        await repository.markSending(d.owner, d.id);
        await repository.settle(d.owner, d.id, { status: state, message: 'Resultado', warnings: [] });
      }
      await repository.deleteInventory(d.owner, d.id);
      await expect(repository.get(d.owner, d.id)).rejects.toThrow('não encontrado');
      expect(sqlite.prepare('SELECT COUNT(*) AS count FROM items WHERE inventoryId=?').get(d.id)?.count).toBe(0);
      expect((await repository.list(d.owner)).map(entry => entry.id)).toEqual([other.id]);
      expect(await repository.items(other.owner, other.id)).toHaveLength(1);
    } finally { sqlite.close(); }
  });

  it('protege outra conta e envios em andamento contra exclusão', async () => {
    const { repository, sqlite } = connect();
    try {
      await repository.initialize();
      const d = await queued(repository);
      await expect(repository.deleteInventory('outra-conta', d.id)).rejects.toThrow('conta');
      expect(await repository.markSending(d.owner, d.id)).toBe(true);
      await expect(repository.deleteInventory(d.owner, d.id)).rejects.toThrow('Aguarde o envio');
      expect((await repository.get(d.owner, d.id)).state).toBe('sending');
      expect(await repository.items(d.owner, d.id)).toHaveLength(1);
    } finally { sqlite.close(); }
  });

  it('restaura unidades se a exclusão do inventário falhar e mantém a fila de operações utilizável', async () => {
    const { repository, sqlite } = connect();
    try {
      await repository.initialize();
      const d = await queued(repository);
      sqlite.exec("CREATE TRIGGER refuse_delete BEFORE DELETE ON inventories BEGIN SELECT RAISE(ABORT, 'Falha simulada'); END");
      await expect(repository.deleteInventory(d.owner, d.id)).rejects.toThrow('Falha simulada');
      expect(await repository.items(d.owner, d.id)).toHaveLength(1);
      expect((await repository.get(d.owner, d.id)).state).toBe('queued');
      sqlite.exec('DROP TRIGGER refuse_delete');
      await repository.deleteInventory(d.owner, d.id);
      expect(await repository.list(d.owner)).toEqual([]);
    } finally { sqlite.close(); }
  });

  it.each(['prepare', 'token', 'prepare-failure'] as const)('não transmite coleta excluída durante %s e continua enviando as demais', async phase => {
    const { repository, sqlite } = connect();
    try {
      await repository.initialize();
      const deleted = await queued(repository, { title: 'Excluir', startedAt: '2026-01-02T00:00:00.000Z' });
      const retained = await queued(repository, { title: 'Manter' });
      let firstToken = true;
      const { delivery, calls } = fakeDelivery(async () => sent, {
        async prepare(owner, inventory) {
          if (inventory.id === deleted.id && phase !== 'token') {
            await repository.deleteInventory(owner, inventory.id);
            if (phase === 'prepare-failure') throw new Error('Preparação interrompida');
          }
          return { raw: `raw:${inventory.title}`, warnings: [] };
        },
        async accessToken(owner) {
          if (phase === 'token' && firstToken) await repository.deleteInventory(owner, deleted.id);
          firstToken = false;
          return 'cached';
        },
      });
      await new Outbox(repository, delivery).sync(deleted.owner);
      expect(calls.transmit).toEqual(['raw:Manter|cached']);
      expect((await repository.get(retained.owner, retained.id)).state).toBe('sent');
      expect(await repository.markSending(deleted.owner, deleted.id)).toBe(false);
    } finally { sqlite.close(); }
  });

  it('migra banco antigo sem inventar a empresa das coletas existentes', async () => {
    const { repository, sqlite } = connect();
    try {
      sqlite.exec(`CREATE TABLE inventories (
        id TEXT PRIMARY KEY, owner TEXT NOT NULL, title TEXT NOT NULL, location TEXT NOT NULL,
        startedAt TEXT NOT NULL, completedAt TEXT, catalogVersion TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'draft', lastError TEXT NOT NULL DEFAULT '', receipt TEXT
      )`);
      const d = draft();
      sqlite.prepare('INSERT INTO inventories(id,owner,title,location,startedAt,catalogVersion) VALUES (?,?,?,?,?,?)')
        .run(d.id, d.owner, d.title, d.location, d.startedAt, d.catalogVersion);
      await repository.initialize();
      await repository.initialize();
      expect((await repository.get(d.owner, d.id)).organization).toBeUndefined();
      await repository.add(d.owner, d.id, item());
      const organization = { kind: 'internal' as const, name: YTECH_NAME, cnpj: YTECH_CNPJ };
      await repository.updateMetadata(d.owner, d.id, { title: d.title, location: d.location, organization });
      await repository.updateMetadata(d.owner, d.id, { title: 'Renomeado', location: d.location });
      expect((await repository.snapshot(d.owner, d.id)).organization).toEqual(organization);
      await repository.finish(d.owner, d.id);
      expect((await repository.payload(d.owner, d.id)).organization).toEqual(organization);
      await expect(repository.updateMetadata(d.owner, d.id, { title: 'Alterado', location: d.location, organization })).rejects.toThrow('concluído');
    } finally { sqlite.close(); }
  });

  it('restaura backups como rascunhos e não sobrescreve inventários ou agenda envios', async () => {
    const { repository, sqlite } = connect();
    try {
      await repository.initialize();
      const d = draft();
      const payload: Inventory = { id: d.id, title: d.title, location: d.location, startedAt: d.startedAt,
        completedAt: new Date().toISOString(), catalogVersion: d.catalogVersion, items: [item()],
        organization: { kind: 'external', name: 'Cliente de teste', cnpj: YTECH_CNPJ } };
      payload.completedAt = new Date().toISOString();
      expect(await repository.importInventories(d.owner, [payload])).toEqual({ imported: 1, skipped: 0 });
      const restored = await repository.get(d.owner, d.id);
      expect(restored.state).toBe('draft');
      expect(restored.completedAt).toBeNull();
      expect(restored.organization).toEqual(payload.organization);
      expect(await repository.importInventories(d.owner, [payload])).toEqual({ imported: 0, skipped: 1 });
      await expect(repository.importInventories('different', [payload])).rejects.toThrow('identificador');
      // A colliding item in the second inventory must roll back the first insert too.
      const first = { ...payload, id: randomUUID(), items: [item('NEW')] };
      first.completedAt = new Date().toISOString();
      await expect(repository.importInventories(d.owner, [first, { ...payload, id: randomUUID() }])).rejects.toThrow();
      expect(await repository.list(d.owner)).toHaveLength(1);
    } finally { sqlite.close(); }
  });

  it('exporta cópia consistente sem concluir, alterar a fila ou permitir outra conta', async () => {
    const { repository, sqlite } = connect();
    try {
      await repository.initialize();
      const d = draft();
      await repository.create(d);
      const addition = repository.add(d.owner, d.id, item());
      const snapshot = await repository.snapshot(d.owner, d.id);
      await addition;
      expect(snapshot.items).toHaveLength(1);
      expect((await repository.get(d.owner, d.id)).state).toBe('draft');
      await expect(repository.snapshot('another', d.id)).rejects.toThrow('conta');
      await repository.finish(d.owner, d.id);
      expect(await repository.snapshot(d.owner, d.id)).toEqual(await repository.payload(d.owner, d.id));
      expect((await repository.get(d.owner, d.id)).state).toBe('queued');
    } finally { sqlite.close(); }
  });
  it('persiste leituras, congela o envio e mantém o mesmo UUID após reiniciar', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ytech-mobile-'));
    const path = join(directory, 'local.sqlite');
    const first = connect(path);
    const d = draft();
    try {
      await first.repository.initialize();
      await first.repository.create(d);
      await first.repository.add(d.owner, d.id, item());
      await first.repository.finish(d.owner, d.id);
      const payload = await first.repository.payload(d.owner, d.id);
      first.sqlite.close();
      const second = connect(path);
      try {
        await second.repository.initialize();
        expect(await second.repository.payload(d.owner, d.id)).toEqual(payload);
        await expect(second.repository.add(d.owner, d.id, item('999'))).rejects.toThrow('concluído');
        await expect(second.repository.items('another-owner', d.id)).rejects.toThrow('conta');
        expect((await second.repository.list(d.owner))[0]?.count).toBe(1);
      } finally { second.sqlite.close(); }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it('bloqueia duplo toque, duplicata e conclusão vazia', async () => {
    const { repository, sqlite } = connect();
    try {
      await repository.initialize();
      const d = draft();
      await repository.create(d);
      await expect(repository.finish(d.owner, d.id)).rejects.toThrow();
      const results = await Promise.allSettled([repository.add(d.owner, d.id, item()), repository.add(d.owner, d.id, item())]);
      expect(results.map(result => result.status).sort()).toEqual(['fulfilled', 'rejected']);
      expect(await repository.items(d.owner, d.id)).toHaveLength(1);
    } finally { sqlite.close(); }
  });
  it('mantém na fila sem transmitir quando a conta Google não está disponível e não duplica envio concorrente', async () => {
    const { repository, sqlite } = connect();
    try {
      await repository.initialize();
      const d = await queued(repository);
      let offline = true;
      const { delivery, calls } = fakeDelivery(async () => sent, {
        async accessToken() { if (offline) throw new Error('Sem rede'); return 'cached'; },
      });
      const outbox = new Outbox(repository, delivery);
      await expect(outbox.sync(d.owner)).rejects.toThrow('Sem rede');
      expect(calls.transmit).toEqual([]);
      expect((await repository.get(d.owner, d.id)).state).toBe('queued');
      expect((await repository.get(d.owner, d.id)).lastError).toBe('Sem rede');
      offline = false;
      await Promise.all([outbox.sync(d.owner), outbox.sync(d.owner)]);
      expect(calls.transmit).toEqual(['raw:Coleta|cached']);
      const saved = await repository.get(d.owner, d.id);
      expect(saved.state).toBe('sent');
      expect(saved.lastError).toBe('');
      expect(JSON.parse(saved.receipt ?? '{}')).toMatchObject({ status: 'sent', warnings: ['aviso'] });
      expect(JSON.parse(saved.receipt ?? '{}').message).toContain('gmail-123');
      expect(await repository.items(d.owner, d.id)).toHaveLength(1);
    } finally { sqlite.close(); }
  });
  it('envio incerto nunca é repetido automaticamente; reenviar exige pedido explícito', async () => {
    const { repository, sqlite } = connect();
    try {
      await repository.initialize();
      const d = await queued(repository);
      let result: TransmitResult = { status: 'uncertain', message: 'Conexão caiu' };
      const { delivery, calls } = fakeDelivery(async () => result);
      const outbox = new Outbox(repository, delivery);
      await expect(outbox.sync(d.owner)).rejects.toThrow('Conexão caiu');
      await outbox.sync(d.owner);
      expect(calls.transmit).toHaveLength(1);
      expect((await repository.get(d.owner, d.id)).state).toBe('uncertain');
      await expect(outbox.retry(d.owner, d.id)).rejects.toThrow('não pode ser repetido');
      result = sent;
      await outbox.retry(d.owner, d.id, true);
      expect(calls.transmit).toHaveLength(2);
      expect((await repository.get(d.owner, d.id)).state).toBe('sent');
      await expect(outbox.retry(d.owner, d.id, true)).rejects.toThrow('não pode ser repetido');
    } finally { sqlite.close(); }
  });
  it('marca como incerto um envio interrompido pelo fechamento do app', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ytech-mobile-'));
    const path = join(directory, 'local.sqlite');
    try {
      const first = connect(path);
      let d: Draft;
      try {
        await first.repository.initialize();
        d = await queued(first.repository);
        await first.repository.markSending(d.owner, d.id);
      } finally { first.sqlite.close(); }
      const second = connect(path);
      try {
        await second.repository.initialize();
        expect(await second.repository.recoverInterrupted()).toBe(1);
        const saved = await second.repository.get(d.owner, d.id);
        expect(saved.state).toBe('uncertain');
        expect(saved.lastError).toContain('Enviados');
        const { delivery, calls } = fakeDelivery(async () => sent);
        await new Outbox(second.repository, delivery).sync(d.owner);
        expect(calls.transmit).toEqual([]);
      } finally { second.sqlite.close(); }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it('renova o token uma única vez quando o Gmail responde 401', async () => {
    const { repository, sqlite } = connect();
    try {
      await repository.initialize();
      const d = await queued(repository);
      const { delivery, calls } = fakeDelivery(async (_raw, token) => token === 'fresh' ? sent : { status: 'unauthorized', message: 'expired' });
      await new Outbox(repository, delivery).sync(d.owner);
      expect(calls.tokens).toEqual([false, true]);
      expect(calls.transmit).toEqual(['raw:Coleta|cached', 'raw:Coleta|fresh']);
      expect((await repository.get(d.owner, d.id)).state).toBe('sent');
      const other = await queued(repository, { title: 'Outra' });
      const rejected = fakeDelivery(async () => ({ status: 'unauthorized', message: 'expired' }));
      await expect(new Outbox(repository, rejected.delivery).sync(other.owner)).rejects.toThrow('Entre novamente');
      expect(rejected.calls.transmit).toHaveLength(2);
      expect((await repository.get(other.owner, other.id)).state).toBe('failed');
    } finally { sqlite.close(); }
  });
  it('rejeita título e localização inválidos antes de criar a coleta', async () => {
    const { repository, sqlite } = connect();
    try {
      await repository.initialize();
      await expect(repository.create({ ...draft(), title: 'Sala\tA' })).rejects.toThrow('controle');
      await expect(repository.create({ ...draft(), location: 'Sala\nA' })).rejects.toThrow('controle');
      expect(await repository.list('123')).toEqual([]);
      const d = draft();
      await repository.create({ ...d, title: 'Sala A' });
      await repository.add(d.owner, d.id, { ...item(), pn: 'HMC3200-LI(H)' });
      await repository.finish(d.owner, d.id);
      expect((await repository.payload(d.owner, d.id)).items[0]?.pn).toBe('HMC3200-LI(H)');
    } finally { sqlite.close(); }
  });
  it('aceita exatamente 8 MiB e bloqueia o próximo item sem congelar ou perder a coleta', async () => {
    const { repository, sqlite } = connect();
    try {
      await repository.initialize();
      const d = draft();
      const payload = fullPayload(d);
      expect(Buffer.byteLength(JSON.stringify(payload))).toBe(MAX_PAYLOAD_BYTES);
      expect(inventorySchema.safeParse(payload).success).toBe(true);
      const last = payload.items.at(-1);
      if (!last) throw new Error('Fixture sem último item.');
      last.rawNs += 'B';
      expect(inventorySchema.safeParse(payload).success).toBe(false);
      last.rawNs = last.rawNs.slice(0, -1);
      await repository.create(d);
      const insert = sqlite.prepare('INSERT INTO items(id,inventoryId,ns,json) VALUES (?,?,?,?)');
      sqlite.exec('BEGIN');
      for (const entry of payload.items.slice(0, -1)) insert.run(entry.id, d.id, entry.ns, JSON.stringify(entry));
      sqlite.exec('COMMIT');
      await repository.add(d.owner, d.id, last);
      await expect(repository.add(d.owner, d.id, item('EXTRA'))).rejects.toThrow('Esta unidade não foi salva');
      await expect(repository.updateMetadata(d.owner, d.id, { title: `${d.title} maior`, location: d.location })).rejects.toThrow('8 MB');
      expect((await repository.get(d.owner, d.id)).state).toBe('draft');
      await repository.finish(d.owner, d.id);
      const saved = await repository.payload(d.owner, d.id);
      expect(saved.items).toHaveLength(2200);
      expect(Buffer.byteLength(JSON.stringify(saved))).toBe(MAX_PAYLOAD_BYTES);
    } finally { sqlite.close(); }
  });
  it('falha ao gerar ou ser recusado pelo Gmail não impede enviar os próximos inventários', async () => {
    const { repository, sqlite } = connect();
    try {
      await repository.initialize();
      const broken = await queued(repository, { title: 'Quebrado', startedAt: '2026-01-03T00:00:00.000Z' });
      const refused = await queued(repository, { title: 'Recusado', startedAt: '2026-01-02T00:00:00.000Z' });
      const good = await queued(repository, { title: 'Normal' });
      const { delivery, calls } = fakeDelivery(async raw => raw === 'raw:Recusado'
        ? { status: 'failed', message: 'O Gmail recusou o envio (HTTP 400).' } : sent, {
        async prepare(_owner, inventory) {
          if (inventory.id === broken.id) throw new Error('Modelo inválido');
          return { raw: `raw:${inventory.title}`, warnings: [] };
        },
      });
      const outbox = new Outbox(repository, delivery);
      await expect(outbox.sync(good.owner)).rejects.toThrow(/Quebrado[\s\S]*Recusado/);
      expect(calls.transmit.map(entry => entry.split('|')[0])).toEqual(['raw:Recusado', 'raw:Normal']);
      expect((await repository.get(good.owner, good.id)).state).toBe('sent');
      expect((await repository.get(broken.owner, broken.id)).state).toBe('failed');
      expect((await repository.get(broken.owner, broken.id)).lastError).toContain('Modelo inválido');
      expect((await repository.get(refused.owner, refused.id)).state).toBe('failed');
      await outbox.sync(good.owner);
      expect(calls.transmit).toHaveLength(2);
    } finally { sqlite.close(); }
  });
  it('permite corrigir rascunho antigo sem bloquear a fila nem reescrever locais dos itens', async () => {
    const { repository, sqlite } = connect();
    try {
      await repository.initialize();
      const legacy = draft();
      const normal = draft();
      for (const d of [legacy, normal]) {
        await repository.create(d);
        await repository.add(d.owner, d.id, item());
      }
      sqlite.prepare('UPDATE inventories SET title=? WHERE id=?').run('Sala\tA', legacy.id);
      await repository.finish(normal.owner, normal.id);
      const { delivery, calls } = fakeDelivery(async () => sent);
      const outbox = new Outbox(repository, delivery);
      expect(await repository.list(legacy.owner)).toHaveLength(2);
      await outbox.sync(normal.owner);
      expect(calls.transmit).toEqual(['raw:Coleta|cached']);
      await expect(repository.finish(legacy.owner, legacy.id)).rejects.toThrow('controle');
      await expect(repository.updateMetadata(legacy.owner, legacy.id, { title: 'Ainda\tinválido', location: legacy.location })).rejects.toThrow('controle');
      await expect(repository.updateMetadata('outra-conta', legacy.id, { title: 'Sala A', location: legacy.location })).rejects.toThrow('conta');
      await repository.updateMetadata(legacy.owner, legacy.id, { title: 'Sala A', location: 'MZ01-E02-N01' });
      expect((await repository.items(legacy.owner, legacy.id))[0]?.location).toBe(legacy.location);
      await repository.finish(legacy.owner, legacy.id);
      const saved = await repository.payload(legacy.owner, legacy.id);
      expect(saved.title).toBe('Sala A');
      expect(saved.items).toHaveLength(1);
      await expect(repository.updateMetadata(legacy.owner, legacy.id, { title: 'Outra sala', location: legacy.location })).rejects.toThrow('concluído');
    } finally { sqlite.close(); }
  });
});

describe('leitura tolerante, relógio, migrações e edição de unidades', () => {
  const internal = { kind: 'internal' as const, name: YTECH_NAME, cnpj: YTECH_CNPJ };

  it('mantém a lista e a fila utilizáveis quando a empresa salva fica ilegível e exige reparo antes de concluir', async () => {
    const { repository, sqlite } = connect();
    try {
      await repository.initialize();
      const broken = { ...draft(), organization: internal };
      await repository.create(broken);
      await repository.add(broken.owner, broken.id, item());
      const ready = await queued(repository, { title: 'Pronto' });
      sqlite.prepare('UPDATE inventories SET organization=? WHERE id=?').run('{não é json', broken.id);

      const listed = await repository.list(broken.owner);
      expect(listed).toHaveLength(2);
      expect(listed.find(entry => entry.id === broken.id)?.problem).toContain('identificação da empresa');
      expect(listed.find(entry => entry.id === ready.id)?.problem).toBeUndefined();
      const { delivery } = fakeDelivery(async () => sent);
      await new Outbox(repository, delivery).sync(ready.owner);
      expect((await repository.get(ready.owner, ready.id)).state).toBe('sent');

      await expect(repository.finish(broken.owner, broken.id)).rejects.toThrow('identificação da empresa');
      await expect(repository.snapshot(broken.owner, broken.id)).rejects.toThrow('identificação da empresa');
      expect(await repository.items(broken.owner, broken.id)).toHaveLength(1);
      await repository.updateMetadata(broken.owner, broken.id, { title: broken.title, location: broken.location, organization: internal });
      await repository.finish(broken.owner, broken.id);
      expect((await repository.payload(broken.owner, broken.id)).organization).toEqual(internal);
    } finally { sqlite.close(); }
  });

  it('lê empresa gravada sob regras antigas e só exige a regra atual ao concluir', async () => {
    const { repository, sqlite } = connect();
    try {
      await repository.initialize();
      const d = { ...draft(), organization: internal };
      await repository.create(d);
      await repository.add(d.owner, d.id, item());
      sqlite.prepare('UPDATE inventories SET organization=? WHERE id=?').run(JSON.stringify({ ...internal, name: 'YTECH ANTIGA' }), d.id);
      const [summary] = await repository.list(d.owner);
      expect(summary?.problem).toBeUndefined();
      expect(summary?.organization?.name).toBe('YTECH ANTIGA');
      await expect(repository.finish(d.owner, d.id)).rejects.toThrow('Ytech Soluções');
    } finally { sqlite.close(); }
  });

  it('mostra e permite excluir um inventário com dados ilegíveis sem bloquear os demais', async () => {
    const { repository, sqlite } = connect();
    try {
      await repository.initialize();
      const healthy = draft();
      await repository.create(healthy);
      const damagedId = randomUUID();
      sqlite.prepare('INSERT INTO inventories(id,owner,title,location,startedAt,catalogVersion,state) VALUES (?,?,?,?,?,?,?)')
        .run(damagedId, healthy.owner, 'Coleta corrompida', 'MZ01', 'ontem', 'v1', 'queued');
      const listed = await repository.list(healthy.owner);
      expect(listed.map(entry => entry.id).sort()).toEqual([healthy.id, damagedId].sort());
      expect(listed.find(entry => entry.id === damagedId)?.problem).toContain('não puderam ser lidos');
      await expect(repository.get(healthy.owner, damagedId)).rejects.toThrow('não puderam ser lidos');
      const { delivery, calls } = fakeDelivery(async () => sent);
      await expect(new Outbox(repository, delivery).sync(healthy.owner)).rejects.toThrow('não puderam ser lidos');
      expect(calls.transmit).toEqual([]);
      await repository.deleteInventory(healthy.owner, damagedId);
      expect((await repository.list(healthy.owner)).map(entry => entry.id)).toEqual([healthy.id]);
    } finally { sqlite.close(); }
  });

  it('recusa leitura anterior ao início da coleta e conclui mesmo após o relógio voltar', async () => {
    const { repository, sqlite } = connect();
    try {
      await repository.initialize();
      const d = draft();
      await repository.create(d);
      await expect(repository.add(d.owner, d.id, { ...item(), capturedAt: '2025-12-31T23:59:00.000Z' })).rejects.toThrow('relógio');
      expect(await repository.items(d.owner, d.id)).toEqual([]);
      // Read while the clock was two hours ahead; the clock was corrected before concluding.
      const ahead = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
      const saved = await repository.add(d.owner, d.id, { ...item(), capturedAt: ahead });
      expect(saved.capturedAt).toBe(ahead);
      expect((await repository.snapshot(d.owner, d.id)).completedAt).toBe(ahead);
      await repository.finish(d.owner, d.id);
      expect((await repository.payload(d.owner, d.id)).completedAt).toBe(ahead);
    } finally { sqlite.close(); }
  });

  it('registra a versão do esquema e não abre dados de uma versão mais nova do app', async () => {
    const { repository, sqlite } = connect();
    try {
      await repository.initialize();
      expect(sqlite.prepare('PRAGMA user_version').get()?.user_version).toBe(2);
      await repository.initialize();
      expect(sqlite.prepare('PRAGMA user_version').get()?.user_version).toBe(2);
      sqlite.exec('PRAGMA user_version = 99');
      await expect(repository.initialize()).rejects.toThrow('versão mais nova');
    } finally { sqlite.close(); }
  });

  it('edita localização e patrimônio de uma unidade sem alterar PN, NS ou horário', async () => {
    const { repository, sqlite } = connect();
    try {
      await repository.initialize();
      const d = draft();
      await repository.create(d);
      const original = await repository.add(d.owner, d.id, item('00777'));
      const edited = await repository.updateItem(d.owner, d.id, original.id, { location: 'MZ02-E01-N01', patrimony: 'pat-9' });
      expect(edited).toMatchObject({ id: original.id, pn: original.pn, ns: '00777', capturedAt: original.capturedAt, location: 'MZ02-E01-N01', patrimony: 'PAT-9' });
      expect(await repository.items(d.owner, d.id)).toEqual([edited]);
      const cleared = await repository.updateItem(d.owner, d.id, original.id, { location: 'MZ02-E01-N01', patrimony: '  ' });
      expect(cleared.patrimony).toBeUndefined();
      await expect(repository.updateItem(d.owner, d.id, original.id, { location: 'Sala\tB' })).rejects.toThrow('controle');
      await expect(repository.updateItem(d.owner, d.id, randomUUID(), { location: 'MZ02' })).rejects.toThrow('não foi encontrado');
      await expect(repository.updateItem('outra-conta', d.id, original.id, { location: 'MZ02' })).rejects.toThrow('conta');
      await repository.finish(d.owner, d.id);
      await expect(repository.updateItem(d.owner, d.id, original.id, { location: 'MZ03' })).rejects.toThrow('concluído');
    } finally { sqlite.close(); }
  });

  it('lista os PN já contados da conta, de todos os inventários, sem falhar com registro ilegível', async () => {
    const { repository, sqlite } = connect();
    try {
      await repository.initialize();
      const first = draft();
      const second = draft();
      const other = { ...draft(), owner: 'outra-conta' };
      for (const d of [first, second, other]) await repository.create(d);
      await repository.add(first.owner, first.id, item('0001'));
      await repository.add(second.owner, second.id, { ...item('0002'), pn: 'DS2278-SR00007ZZWW' });
      await repository.add(second.owner, second.id, item('0003'));
      await repository.add(other.owner, other.id, { ...item('0004'), pn: 'SO-DA-OUTRA' });
      sqlite.prepare('INSERT INTO items(id,inventoryId,ns,json) VALUES (?,?,?,?)').run(randomUUID(), first.id, '0009', '{quebrado');
      expect((await repository.partNumbers(first.owner)).sort()).toEqual(['DS2278-SR00007ZZWW', 'MC3401-0G1R64SS-A6']);
      expect(await repository.partNumbers('ninguem')).toEqual([]);
    } finally { sqlite.close(); }
  });

  it('em segundo plano deixa na fila o que depende do ambiente e informa se algo mudou', async () => {
    const { repository, sqlite } = connect();
    try {
      await repository.initialize();
      const d = await queued(repository);
      const unavailablePdf = fakeDelivery(async () => sent, { async prepare() { throw new Error('Sem tela para o PDF'); } });
      expect(await new Outbox(repository, unavailablePdf.delivery).sync(d.owner, { background: true })).toBe(false);
      const afterPrepare = await repository.get(d.owner, d.id);
      expect([afterPrepare.state, afterPrepare.lastError]).toEqual(['queued', '']);
      const noAccount = fakeDelivery(async () => sent, { async accessToken() { throw new Error('Sem sessão'); } });
      expect(await new Outbox(repository, noAccount.delivery).sync(d.owner, { background: true })).toBe(false);
      const afterToken = await repository.get(d.owner, d.id);
      expect([afterToken.state, afterToken.lastError]).toEqual(['queued', '']);
      expect(unavailablePdf.calls.transmit.length + noAccount.calls.transmit.length).toBe(0);
      const working = fakeDelivery(async () => sent);
      const outbox = new Outbox(repository, working.delivery);
      expect(await outbox.sync(d.owner, { background: true })).toBe(true);
      expect((await repository.get(d.owner, d.id)).state).toBe('sent');
      expect(await outbox.sync(d.owner)).toBe(false);
    } finally { sqlite.close(); }
  });
});
