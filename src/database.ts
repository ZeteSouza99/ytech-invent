import { defaultDatabaseDirectory, deleteDatabaseAsync, openDatabaseAsync, type SQLiteDatabase } from 'expo-sqlite';
import * as SecureStore from 'expo-secure-store';
import { getRandomBytes } from 'expo-crypto';
import { File } from 'expo-file-system';
import { errorMessage } from '../shared/model';
import { openableInBackground, storagePlan, type StoragePlan } from './storagePlan';

const LEGACY_NAME = 'ytech-invent.db';
const ENCRYPTED_NAME = 'ytech-invent-secure.db';
const KEY_ITEM = 'ytech.database.key.v1';
const READY_ITEM = 'ytech.database.encrypted.v1';
const KEY_MISSING = 'A chave do banco criptografado não está disponível neste aparelho. As coletas não foram apagadas, mas não podem ser abertas. Não desinstale nem limpe os dados do app; procure o suporte.';
const CIPHER_MISSING = 'Este APK não inclui a criptografia do banco (SQLCipher), mas as coletas deste aparelho já estão criptografadas. Nada foi apagado; instale o APK correto do Ytech Invent.';

export type OpenedDatabase = { database: SQLiteDatabase; warning: string | null };
type Counts = { inventories: number; items: number };

function directoryPath(): string {
  return String(defaultDatabaseDirectory).replace(/^file:\/\//, '');
}

function fileFor(name: string): File {
  return new File(`file://${directoryPath()}/${name}`);
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

// A raw 256-bit key skips SQLCipher's key derivation, which would only slow every start. SQLCipher recognizes the
// x'…' form in the key text itself, so a plain string literal works both in PRAGMA key and in ATTACH … KEY.
function keyClause(key: string): string {
  return `'x''${key}'''`;
}

async function readKey(): Promise<string | null> {
  const key = await SecureStore.getItemAsync(KEY_ITEM);
  return key && /^[0-9a-f]{64}$/.test(key) ? key : null;
}

async function cipherAvailable(): Promise<boolean> {
  const probe = await openDatabaseAsync(':memory:');
  try {
    return !!(await probe.getFirstAsync<{ cipher_version?: string }>('PRAGMA cipher_version'))?.cipher_version;
  } finally {
    await probe.closeAsync();
  }
}

async function createKey(): Promise<string> {
  const key = toHex(getRandomBytes(32));
  await SecureStore.setItemAsync(KEY_ITEM, key);
  if (await SecureStore.getItemAsync(KEY_ITEM) !== key) throw new Error('não foi possível guardar a chave do banco com segurança');
  return key;
}

async function openEncrypted(key: string): Promise<SQLiteDatabase> {
  const database = await openDatabaseAsync(ENCRYPTED_NAME);
  try {
    await database.execAsync(`PRAGMA key = ${keyClause(key)}`);
    // A wrong key only surfaces on the first read.
    await database.getFirstAsync('SELECT count(*) AS count FROM sqlite_master');
    return database;
  } catch (error) {
    await database.closeAsync();
    throw error;
  }
}

async function removeDatabase(name: string): Promise<void> {
  if (fileFor(name).exists) await deleteDatabaseAsync(name);
  for (const suffix of ['-wal', '-shm', '-journal']) {
    const file = fileFor(`${name}${suffix}`);
    if (file.exists) file.delete();
  }
}

async function countRows(database: SQLiteDatabase): Promise<Counts> {
  const tables = await database.getAllAsync<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('inventories','items')");
  const count = async (table: 'inventories' | 'items') => tables.some(entry => entry.name === table)
    ? (await database.getFirstAsync<{ count: number }>(`SELECT count(*) AS count FROM ${table}`))?.count ?? 0
    : 0;
  return { inventories: await count('inventories'), items: await count('items') };
}

// Exports the legacy file into a new encrypted one and verifies it before it becomes authoritative.
async function migrate(key: string, discardEncrypted: boolean): Promise<SQLiteDatabase> {
  if (discardEncrypted) await removeDatabase(ENCRYPTED_NAME);
  const legacy = await openDatabaseAsync(LEGACY_NAME);
  let expected: Counts;
  try {
    await legacy.execAsync('PRAGMA wal_checkpoint(TRUNCATE)');
    expected = await countRows(legacy);
    const version = (await legacy.getFirstAsync<{ user_version: number }>('PRAGMA user_version'))?.user_version ?? 0;
    const target = `${directoryPath()}/${ENCRYPTED_NAME}`.replace(/'/g, "''");
    await legacy.execAsync(`ATTACH DATABASE '${target}' AS encrypted KEY ${keyClause(key)}`);
    try {
      // sqlcipher_export copies schema and rows but not the schema version used by the migrations.
      await legacy.execAsync(`SELECT sqlcipher_export('encrypted'); PRAGMA encrypted.user_version = ${version};`);
    } finally {
      await legacy.execAsync('DETACH DATABASE encrypted');
    }
  } finally {
    await legacy.closeAsync();
  }
  const encrypted = await openEncrypted(key);
  try {
    const copied = await countRows(encrypted);
    const check = await encrypted.getFirstAsync<{ quick_check: string }>('PRAGMA quick_check');
    if (copied.inventories !== expected.inventories || copied.items !== expected.items || check?.quick_check !== 'ok') {
      throw new Error('a cópia criptografada não confere com os dados originais');
    }
    await SecureStore.setItemAsync(READY_ITEM, 'true');
    return encrypted;
  } catch (error) {
    await encrypted.closeAsync();
    await removeDatabase(ENCRYPTED_NAME);
    throw error;
  }
}

async function removeLegacy(): Promise<string | null> {
  try {
    await removeDatabase(LEGACY_NAME);
    return null;
  } catch (error) {
    return `A cópia antiga do banco, sem criptografia, não pôde ser apagada (${errorMessage(error)}). O app tentará de novo na próxima abertura.`;
  }
}

async function currentPlan(): Promise<{ key: string | null; ready: boolean; plan: StoragePlan }> {
  const key = await readKey();
  const ready = await SecureStore.getItemAsync(READY_ITEM) === 'true';
  const plan = storagePlan({
    cipher: await cipherAvailable(), legacy: fileFor(LEGACY_NAME).exists, encrypted: fileFor(ENCRYPTED_NAME).exists, key: key !== null, ready,
  });
  return { key, ready, plan };
}

export async function storageReadyForBackground(): Promise<boolean> {
  return openableInBackground((await currentPlan()).plan);
}

export async function openInventoryDatabase(): Promise<OpenedDatabase> {
  const { key, ready, plan } = await currentPlan();
  switch (plan.action) {
    case 'key-missing':
      throw new Error(KEY_MISSING);
    case 'cipher-missing':
      throw new Error(CIPHER_MISSING);
    case 'plain':
      return {
        database: await openDatabaseAsync(LEGACY_NAME),
        warning: 'Este APK não inclui a criptografia do banco (SQLCipher). As coletas ficam neste aparelho sem criptografia.',
      };
    case 'open': {
      const database = await openEncrypted(key!);
      if (!ready) await SecureStore.setItemAsync(READY_ITEM, 'true');
      return { database, warning: plan.removeLegacy ? await removeLegacy() : null };
    }
    case 'create': {
      const database = await openEncrypted(key ?? await createKey());
      await SecureStore.setItemAsync(READY_ITEM, 'true');
      return { database, warning: null };
    }
    case 'migrate':
      try {
        const database = await migrate(key ?? await createKey(), plan.discardEncrypted);
        return { database, warning: await removeLegacy() };
      } catch (error) {
        // Availability of the inventories comes first: keep using the unencrypted file and retry on the next start.
        return {
          database: await openDatabaseAsync(LEGACY_NAME),
          warning: `Não foi possível criptografar o banco local (${errorMessage(error)}). As coletas continuam neste aparelho, sem criptografia; o app tentará de novo na próxima abertura.`,
        };
      }
  }
}
