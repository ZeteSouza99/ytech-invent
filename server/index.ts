import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createApp } from './app.ts';
import { createGoogleTokenVerifier } from './auth.ts';
import { readConfig } from './config.ts';
import { createSmtpMailer } from './mailer.ts';
import { InventoryStore } from './store.ts';
import { createWorkbookService } from './workbook.ts';

async function main() {
  let config;
  try {
    config = readConfig();
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Configuração inválida.');
    process.exitCode = 1;
    return;
  }
  const workbook = await createWorkbookService(config.templatePath);
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const store = new InventoryStore(join(config.dataDir, 'inventories.sqlite'));
  const smtp = createSmtpMailer(config.smtp);
  const app = createApp({
    clientId: config.clientId,
    verifyToken: createGoogleTokenVerifier(config.clientId),
    mailer: smtp.send,
    workbook,
    store,
  });
  const server = app.listen(config.port, config.host, () => {
    console.info(`API Ytech ouvindo em ${config.host}:${config.port}. SMTP será verificado no envio.`);
  });
  server.once('error', () => {
    console.error('Não foi possível iniciar a API. Verifique HOST, PORT e permissões.');
    smtp.close();
    store.close();
    process.exitCode = 1;
  });
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    const timeout = setTimeout(() => process.exit(1), 90000);
    timeout.unref();
    server.close(() => {
      clearTimeout(timeout);
      smtp.close();
      store.close();
    });
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

main().catch(() => {
  console.error('Falha ao iniciar a API. Verifique planilha, diretório de dados e configuração. Nenhum serviço foi marcado como pronto.');
  process.exitCode = 1;
});
