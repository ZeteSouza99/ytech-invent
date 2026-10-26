import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

const port = z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().min(1).max(65535));
const configurationSchema = z.object({
  GOOGLE_WEB_CLIENT_ID: z.string().trim().min(1),
  SMTP_HOST: z.string().trim().min(1).regex(/^[a-zA-Z0-9.-]+$/),
  SMTP_PORT: port,
  SMTP_SECURE: z.enum(['true', 'false']).transform(value => value === 'true'),
  SMTP_USER: z.string().trim().min(1),
  SMTP_PASSWORD: z.string().min(1),
  SMTP_FROM: z.email().max(254),
  PORT: port.default(3000),
  HOST: z.string().trim().min(1).default('127.0.0.1'),
  DATA_DIR: z.string().trim().min(1).default('data'),
  TEMPLATE_PATH: z.string().trim().min(1).optional(),
});

export type ServerConfig = ReturnType<typeof readConfig>;

export function readConfig(environment: Readonly<Record<string, string | undefined>> = process.env, root = process.cwd()) {
  const parsed = configurationSchema.safeParse(environment);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map(issue => issue.path.join('.')))].join(', ');
    throw new Error(`Configuração ausente ou inválida: ${fields}. Revise o arquivo .env.`);
  }
  const values = parsed.data;
  let templatePath = values.TEMPLATE_PATH;
  if (!templatePath) {
    const candidates = readdirSync(root, { withFileTypes: true })
      .filter(entry => entry.isFile() && /\.xlsx$/i.test(entry.name) && !entry.name.startsWith('~$'));
    if (candidates.length !== 1) {
      throw new Error('Defina TEMPLATE_PATH: a raiz deve conter exatamente uma planilha .xlsx.');
    }
    templatePath = candidates[0]!.name;
  }
  return {
    clientId: values.GOOGLE_WEB_CLIENT_ID,
    host: values.HOST,
    port: values.PORT,
    dataDir: resolve(root, values.DATA_DIR),
    templatePath: resolve(root, templatePath),
    smtp: {
      host: values.SMTP_HOST,
      port: values.SMTP_PORT,
      secure: values.SMTP_SECURE,
      user: values.SMTP_USER,
      password: values.SMTP_PASSWORD,
      from: values.SMTP_FROM,
    },
  };
}
