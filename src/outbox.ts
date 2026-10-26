import { errorMessage, RECIPIENT, type Inventory } from '../shared/model';
import type { TransmitResult } from '../shared/gmail';
import type { DeliveryOutcome, InventoryRepository } from './repository';

export interface Delivery {
  // Builds the whole message on the device; a failure here means nothing was sent.
  prepare(owner: string, inventory: Inventory): Promise<{ raw: string; warnings: string[] }>;
  accessToken(owner: string, refresh: boolean): Promise<string>;
  transmit(raw: string, accessToken: string): Promise<TransmitResult>;
}

export class Outbox {
  private running: Promise<void> | null = null;
  constructor(private readonly repository: InventoryRepository, private readonly delivery: Delivery) {}

  sync(owner: string): Promise<void> {
    this.running ??= this.drain(owner).finally(() => { this.running = null; });
    return this.running;
  }

  async retry(owner: string, id: string, allowUncertain = false): Promise<void> {
    await this.repository.requeue(owner, id, allowUncertain);
    await this.sync(owner);
  }

  private async drain(owner: string): Promise<void> {
    const pending = (await this.repository.list(owner)).filter(item => item.state === 'queued');
    const problems: string[] = [];
    for (const draft of pending) {
      let prepared: { raw: string; warnings: string[] };
      try {
        prepared = await this.delivery.prepare(owner, await this.repository.payload(owner, draft.id));
      } catch (error) {
        // Invalid local data must not block the other inventories in the queue.
        const outcome: DeliveryOutcome = { status: 'failed', message: `Não foi possível gerar o e-mail: ${errorMessage(error)}`, warnings: [] };
        if (!await this.repository.markSending(owner, draft.id)) continue;
        await this.repository.settle(owner, draft.id, outcome);
        problems.push(`${draft.title}: ${outcome.message}`);
        continue;
      }
      let token: string;
      try {
        token = await this.delivery.accessToken(owner, false);
      } catch (error) {
        // Nothing was transmitted: keep the inventory queued and stop until the account is available.
        await this.repository.saveError(owner, draft.id, errorMessage(error));
        throw error;
      }
      if (!await this.repository.markSending(owner, draft.id)) continue;
      let result = await this.transmit(prepared.raw, token);
      if (result.status === 'unauthorized') {
        try {
          result = await this.transmit(prepared.raw, await this.delivery.accessToken(owner, true));
        } catch (error) {
          result = { status: 'failed', message: `A sessão Google expirou: ${errorMessage(error)}` };
        }
      }
      const outcome: DeliveryOutcome = result.status === 'sent'
        ? { status: 'sent', message: `Enviado pelo seu Gmail para ${RECIPIENT}. ID da mensagem: ${result.messageId}.`, warnings: prepared.warnings }
        : result.status === 'unauthorized'
          ? { status: 'failed', message: 'O Google recusou a autorização de envio. Entre novamente com sua conta e tente de novo.', warnings: prepared.warnings }
          : { status: result.status, message: result.message, warnings: prepared.warnings };
      await this.repository.settle(owner, draft.id, outcome);
      if (outcome.status !== 'sent') problems.push(`${draft.title}: ${outcome.message}`);
    }
    if (problems.length) throw new Error(`Há envios que exigem atenção:\n${problems.join('\n')}`);
  }

  private async transmit(raw: string, token: string): Promise<TransmitResult> {
    try {
      return await this.delivery.transmit(raw, token);
    } catch {
      return { status: 'uncertain', message: 'O envio foi interrompido. Confira a pasta Enviados do seu Gmail antes de reenviar.' };
    }
  }
}
