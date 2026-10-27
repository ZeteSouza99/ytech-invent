import { transmitGmail } from '../shared/gmail';
import { buildInventoryMessage, type MailAttachment } from '../shared/mime';
import type { Inventory, User } from '../shared/model';
import type { WorkbookService } from '../shared/workbook';
import type { Delivery } from './outbox';

export function createGmailDelivery(options: {
  workbook: () => Promise<WorkbookService>;
  reportPdf: (inventory: Inventory) => Promise<MailAttachment>;
  // Resolved on every attempt: in the background there is no screen state to read the account from.
  user: (owner: string) => User | null | Promise<User | null>;
  accessToken: (owner: string, refresh: boolean) => Promise<string>;
}): Delivery {
  return {
    async prepare(owner, inventory) {
      const user = await options.user(owner);
      if (!user) throw new Error('Entre com a conta responsável por este inventário para enviá-lo.');
      const { attachments, warnings } = await (await options.workbook()).export(inventory, user);
      // Use the same complete report as the manual PDF export. Failure to
      // create it must stop preparation, before any request reaches Gmail.
      const pdf = await options.reportPdf(inventory);
      if (pdf.mimeType !== 'application/pdf' || pdf.content.length === 0) {
        throw new Error('Não foi possível gerar o relatório PDF completo. Tente o envio novamente.');
      }
      return { raw: buildInventoryMessage({ inventory, user, warnings, attachments: [pdf, ...attachments] }), warnings };
    },
    accessToken: options.accessToken,
    transmit: (raw, token) => transmitGmail(raw, token),
  };
}
