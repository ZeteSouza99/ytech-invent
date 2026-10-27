import { loadWorkbookService } from './catalog';
import { openInventoryDatabase } from './database';
import { createGmailDelivery } from './delivery';
import { accessToken, restoreSession } from './google';
import { Outbox } from './outbox';
import { InventoryRepository } from './repository';
import { createDocument } from './shareExport';

export type Services = { repository: InventoryRepository; outbox: Outbox; storageWarning: string | null };

let opening: Promise<Services> | null = null;
let recovery: Promise<void> | null = null;

// One connection, write queue and outbox per JavaScript runtime, shared by the screens and the background
// task, so the same inventory is never claimed or settled twice.
export function openServices(): Promise<Services> {
  opening ??= open().catch(error => {
    opening = null;
    throw error;
  });
  return opening;
}

// Only the app on screen decides, once per runtime, that a send left in 'sending' was interrupted. A background
// run must not take over a send that the app on screen may still be finishing.
export async function openForegroundServices(): Promise<Services> {
  const services = await openServices();
  recovery ??= services.repository.recoverInterrupted().then(() => undefined, error => {
    recovery = null;
    throw error;
  });
  await recovery;
  return services;
}

async function open(): Promise<Services> {
  const { database, warning } = await openInventoryDatabase();
  const repository = new InventoryRepository(database);
  await repository.initialize();
  const outbox = new Outbox(repository, createGmailDelivery({
    workbook: loadWorkbookService,
    reportPdf: inventory => createDocument([{ inventory, partial: false }], 'pdf'),
    user: async owner => {
      const user = await restoreSession();
      return user?.sub === owner ? user : null;
    },
    accessToken,
  }));
  return { repository, outbox, storageWarning: warning };
}
