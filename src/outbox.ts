import { DEFAULT_RECIPIENT, errorMessage, type Inventory } from '../shared/model';
import type { TransmitResult } from '../shared/gmail';
import type { DeliveryOutcome, InventoryRepository } from './repository';

export interface Delivery {
  // Builds the whole message on the device; a failure here means nothing was sent.
  prepare(owner: string, inventory: Inventory, recipient: string): Promise<{ raw: string; warnings: string[] }>;
  accessToken(owner: string, refresh: boolean): Promise<string>;
  transmit(raw: string, accessToken: string): Promise<TransmitResult>;
}

export type SyncOptions = {
  // No one is looking at the screen: problems that depend on the environment leave the inventory queued
  // for the next attempt with the app open, and nothing is thrown for a user to read.
  background?: boolean;
};

export class Outbox {
  private running: Promise<boolean> | null = null;
  constructor(private readonly repository: InventoryRepository, private readonly delivery: Delivery) {}

  // Resolves to true when any inventory changed state or error, so callers reload only when needed.
  sync(owner: string, options: SyncOptions = {}): Promise<boolean> {
    this.running ??= this.drain(owner, options.background === true).finally(() => { this.running = null; });
    return this.running;
  }

  async retry(owner: string, id: string, allowUncertain = false): Promise<void> {
    await this.repository.requeue(owner, id, allowUncertain);
    await this.sync(owner);
  }

  private async drain(owner: string, background: boolean): Promise<boolean> {
    const pending = (await this.repository.list(owner)).filter(item => item.state === 'queued');
    const problems: string[] = [];
    let changed = false;
    for (const draft of pending) {
      // Inventories concluded before the recipient could be chosen go to the original default.
      const recipient = draft.recipient ?? DEFAULT_RECIPIENT;
      let prepared: { raw: string; warnings: string[] };
      try {
        prepared = await this.delivery.prepare(owner, await this.repository.payload(owner, draft.id), recipient);
      } catch (error) {
        // Without a screen the PDF renderer, for example, may be unavailable; the foreground attempt decides.
        if (background) continue;
        // Invalid local data must not block the other inventories in the queue.
        const outcome: DeliveryOutcome = { status: 'failed', message: `Não foi possível gerar o e-mail: ${errorMessage(error)}`, warnings: [] };
        if (!await this.repository.markSending(owner, draft.id)) continue;
        changed = true;
        await this.repository.settle(owner, draft.id, outcome);
        problems.push(`${draft.title}: ${outcome.message}`);
        continue;
      }
      let token: string;
      try {
        token = await this.delivery.accessToken(owner, false);
      } catch (error) {
        // Nothing was transmitted: keep the inventory queued and stop until the account is available.
        if (background) return changed;
        await this.repository.saveError(owner, draft.id, errorMessage(error));
        throw error;
      }
      // Fails when the inventory was deleted or its recipient changed while the message was built; the next sync uses the new one.
      if (!await this.repository.markSending(owner, draft.id, recipient)) continue;
      changed = true;
      let result = await this.transmit(prepared.raw, token);
      if (result.status === 'unauthorized') {
        try {
          result = await this.transmit(prepared.raw, await this.delivery.accessToken(owner, true));
        } catch (error) {
          result = { status: 'failed', message: `A sessão Google expirou: ${errorMessage(error)}` };
        }
      }
      const outcome: DeliveryOutcome = result.status === 'sent'
        ? { status: 'sent', message: `Enviado pelo seu Gmail para ${recipient}. ID da mensagem: ${result.messageId}.`, warnings: prepared.warnings }
        : result.status === 'unauthorized'
          ? { status: 'failed', message: 'O Google recusou a autorização de envio. Entre novamente com sua conta e tente de novo.', warnings: prepared.warnings }
          : { status: result.status, message: result.message, warnings: prepared.warnings };
      await this.repository.settle(owner, draft.id, outcome);
      if (outcome.status !== 'sent') problems.push(`${draft.title}: ${outcome.message}`);
    }
    if (problems.length && !background) throw new Error(`Há envios que exigem atenção:\n${problems.join('\n')}`);
    return changed;
  }

  private async transmit(raw: string, token: string): Promise<TransmitResult> {
    try {
      return await this.delivery.transmit(raw, token);
    } catch {
      return { status: 'uncertain', message: 'O envio foi interrompido. Confira a pasta Enviados do seu Gmail antes de reenviar.' };
    }
  }
}
