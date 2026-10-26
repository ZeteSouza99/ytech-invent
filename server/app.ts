import express, { type ErrorRequestHandler, type Express, type Request, type Response } from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { MAX_PAYLOAD_BYTES, catalogSchema, inventorySchema, type Catalog, type Inventory, type Receipt, type User } from '../shared/model.ts';
import { authenticate, AuthenticationError, type TokenVerifier } from './auth.ts';
import type { Attachment, Mailer } from './mailer.ts';
import { InventoryConflictError, InventoryNotFoundError, InventoryRetryError, InventoryStore } from './store.ts';

export type WorkbookService = {
  catalog: Catalog;
  export(inventory: Inventory, user: User): Promise<{ attachments: Attachment[]; warnings: string[] }>;
};

export type AppDependencies = {
  clientId: string;
  verifyToken: TokenVerifier;
  mailer: Mailer;
  workbook: WorkbookService;
  store: InventoryStore;
  rateLimitMax?: number;
};

export function createApp(dependencies: AppDependencies): Express {
  const { clientId, verifyToken, mailer, workbook, store } = dependencies;
  const catalog = catalogSchema.parse(workbook.catalog);
  if (!clientId.trim()) throw new Error('GOOGLE_WEB_CLIENT_ID não configurado.');
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet());
  app.get('/health', (_request, response) => {
    const ready = store.ready();
    response.status(ready ? 200 : 503).json({
      status: ready ? 'ready' : 'unavailable',
      checks: { configuration: true, template: true, database: ready },
      smtp: 'not_probed',
    });
  });
  app.use(rateLimit({
    windowMs: 60000,
    limit: dependencies.rateLimitMax ?? 120,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'Muitas solicitações. Aguarde um minuto e tente novamente.' },
  }));
  app.use((_request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use(async (request, response, next) => {
    response.locals.user = await authenticate(request.get('authorization'), verifyToken, clientId);
    next();
  });
  app.use(express.json({ limit: MAX_PAYLOAD_BYTES, strict: true }));

  app.get('/bootstrap', (_request, response) => {
    response.json({ user: response.locals.user as User, catalog });
  });

  async function processInventory(id: string, owner: string, retry = false): Promise<Receipt> {
    const claimed = store.claim(id, owner, retry);
    if (!claimed) return store.get(id, owner).receipt;
    let warnings = claimed.inventory.catalogVersion === catalog.version
      ? []
      : ['O catálogo mudou desde a coleta offline. Os itens foram reavaliados com o catálogo atual, sem descartar leituras.'];
    let attachments: Attachment[];
    try {
      const exported = await workbook.export(claimed.inventory, claimed.user);
      attachments = exported.attachments;
      warnings = [...warnings, ...exported.warnings];
    } catch {
      store.settle(id, 'failed', warnings);
      return store.get(id, owner).receipt;
    }
    warnings = [...new Set(warnings)].slice(0, 100000);
    store.annotateSending(id, warnings);
    let status: 'sent' | 'failed' | 'uncertain';
    try {
      status = await mailer({ inventory: claimed.inventory, user: claimed.user, attachments });
    } catch {
      // Um adaptador que lançou sem resultado pode já ter transmitido DATA.
      status = 'uncertain';
    }
    store.settle(id, status, warnings);
    return store.get(id, owner).receipt;
  }

  app.post('/inventories', async (request, response) => {
    const parsed = inventorySchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: 'Inventário inválido. Revise os campos e as leituras.' });
      return;
    }
    const user = response.locals.user as User;
    const stored = store.accept(parsed.data, user);
    const receipt = stored.receipt.status === 'accepted'
      ? await processInventory(parsed.data.id, user.sub)
      : stored.receipt;
    response.status(receipt.status === 'accepted' || receipt.status === 'sending' ? 202 : 200).json(receipt);
  });

  function inventoryId(request: Request, response: Response): string | undefined {
    const parsed = z.uuid().safeParse(request.params.id);
    if (!parsed.success) response.status(400).json({ error: 'Identificador de inventário inválido.' });
    return parsed.success ? parsed.data : undefined;
  }

  app.get('/inventories/:id', (request, response) => {
    const id = inventoryId(request, response);
    if (!id) return;
    response.json(store.get(id, (response.locals.user as User).sub).receipt);
  });

  app.post('/inventories/:id/retry', async (request, response) => {
    const id = inventoryId(request, response);
    if (!id) return;
    if (request.body !== undefined &&
        (!request.body || Array.isArray(request.body) || Object.keys(request.body as object).length > 0)) {
      response.status(400).json({ error: 'A repetição não aceita alterações no inventário.' });
      return;
    }
    const receipt = await processInventory(id, (response.locals.user as User).sub, true);
    response.status(receipt.status === 'sending' ? 202 : 200).json(receipt);
  });

  app.use((_request, response) => response.status(404).json({ error: 'Recurso não encontrado.' }));
  const errors: ErrorRequestHandler = (error: unknown, _request, response, _next) => {
    if (error instanceof AuthenticationError) {
      if (error.status === 401) response.setHeader('WWW-Authenticate', 'Bearer');
      response.status(error.status).json({ error: error.message });
    } else if (error instanceof InventoryNotFoundError) {
      response.status(404).json({ error: 'Inventário não encontrado.' });
    } else if (error instanceof InventoryConflictError) {
      response.status(409).json({ error: 'Este identificador já foi usado com outro conteúdo.' });
    } else if (error instanceof InventoryRetryError) {
      response.status(409).json({ error: 'Só é permitido repetir um envio com falha segura. Envio incerto nunca é repetido automaticamente.' });
    } else if (error && typeof error === 'object' && 'type' in error && error.type === 'entity.too.large') {
      response.status(413).json({ error: 'Inventário excede o limite de 8 MB.' });
    } else if (error && typeof error === 'object' && 'type' in error &&
        ['entity.parse.failed', 'encoding.unsupported', 'charset.unsupported'].includes(String(error.type))) {
      response.status(400).json({ error: 'Corpo JSON inválido ou codificação não suportada.' });
    } else {
      response.status(500).json({ error: 'Falha interna. Seus dados permanecem salvos; consulte o status antes de tentar novamente.' });
    }
  };
  app.use(errors);
  return app;
}
