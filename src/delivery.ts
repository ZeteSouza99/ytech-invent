import { transmitGmail } from '../shared/gmail';
import { buildInventoryMessage, type MailAttachment } from '../shared/mime';
import type { Catalog, Inventory, User } from '../shared/model';
import type { WorkbookService } from '../shared/workbook';
import type { Delivery } from './outbox';

export function createGmailDelivery(options: {
  workbook: () => Promise<WorkbookService>;
  reportPdf: (inventory: Inventory, catalog: Catalog) => Promise<MailAttachment>;
  // Resolved on every attempt: in the background there is no screen state to read the account from.
  user: (owner: string) => User | null | Promise<User | null>;
  accessToken: (owner: string, refresh: boolean) => Promise<string>;
}): Delivery {
  return {
    async prepare(owner, inventory, recipient, resend = 0) {
      const user = await options.user(owner);
      if (!user) throw new Error('Entre com a conta responsável por este inventário para enviá-lo.');
      const service = await options.workbook();
      // The same report as the manual PDF export. Failure to create it must stop preparation,
      // before any request reaches Gmail.
      const pdf = await options.reportPdf(inventory, service.catalog);
      if (pdf.mimeType !== 'application/pdf' || pdf.content.length === 0) {
        throw new Error('Não foi possível gerar o relatório PDF completo. Tente o envio novamente.');
      }
      const spreadsheet = await service.spreadsheet([{ inventory, partial: false }]);
      return { raw: buildInventoryMessage({ inventory, user, recipient, resend, attachments: [pdf, spreadsheet] }), warnings: [] };
    },
    accessToken: options.accessToken,
    transmit: (raw, token) => transmitGmail(raw, token),
  };
}
