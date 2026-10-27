export type StorageState = {
  // The native build includes SQLCipher; without it PRAGMA key is silently ignored.
  cipher: boolean;
  // Unencrypted database written by versions up to 1.1.2.
  legacy: boolean;
  encrypted: boolean;
  key: boolean;
  // The encrypted copy was verified against the legacy file and became the authoritative one.
  ready: boolean;
};

export type StoragePlan =
  | { action: 'create' }
  | { action: 'open'; removeLegacy: boolean }
  | { action: 'migrate'; discardEncrypted: boolean }
  | { action: 'plain' }
  | { action: 'cipher-missing' }
  | { action: 'key-missing' };

// Decides how to open local storage without ever deleting the only readable copy of the inventories.
export function storagePlan(state: StorageState): StoragePlan {
  if (!state.cipher) {
    // An encrypted copy that already replaced the legacy file must never be swapped for an empty plain one.
    return state.encrypted && (state.ready || !state.legacy) ? { action: 'cipher-missing' } : { action: 'plain' };
  }
  if (state.ready && state.encrypted) return state.key ? { action: 'open', removeLegacy: state.legacy } : { action: 'key-missing' };
  // Until the copy is verified, the legacy file is the source and an encrypted file is an interrupted export.
  if (state.legacy) return { action: 'migrate', discardEncrypted: state.encrypted };
  if (state.encrypted) return state.key ? { action: 'open', removeLegacy: false } : { action: 'key-missing' };
  return { action: 'create' };
}

// Only the app on screen creates or migrates storage. A background run starting at the same moment could
// otherwise generate a second key or export over the copy being verified, and inventories would be lost.
export function openableInBackground(plan: StoragePlan): boolean {
  return plan.action === 'open' || plan.action === 'plain';
}
