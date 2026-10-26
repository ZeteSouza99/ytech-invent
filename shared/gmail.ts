export const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';
const SEND_URL = 'https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=media';
const TIMEOUT_MS = 120000;

export type TransmitResult =
  | { status: 'sent'; messageId: string }
  | { status: 'unauthorized'; message: string }
  | { status: 'failed'; message: string }
  | { status: 'uncertain'; message: string };

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

async function googleError(response: Response): Promise<string> {
  try {
    const body = await response.json() as { error?: { message?: unknown } };
    if (typeof body.error?.message === 'string') return body.error.message.slice(0, 300);
  } catch {
    // The status code alone still explains the failure.
  }
  return `HTTP ${response.status}`;
}

// Sends one RFC 2822 message through the user's own Gmail account.
export async function transmitGmail(raw: string, accessToken: string, fetchImpl: Fetch = fetch): Promise<TransmitResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetchImpl(SEND_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'message/rfc822' },
      body: raw,
      signal: controller.signal,
    });
  } catch {
    // The request may have reached Gmail before the connection dropped.
    return { status: 'uncertain', message: 'A conexão caiu durante o envio. Confira a pasta Enviados do seu Gmail antes de reenviar.' };
  } finally {
    clearTimeout(timeout);
  }
  if (response.status === 401) return { status: 'unauthorized', message: await googleError(response) };
  if (response.status >= 500 || response.status === 408) {
    return { status: 'uncertain', message: `O Gmail respondeu HTTP ${response.status}, sem confirmar o resultado. Confira a pasta Enviados antes de reenviar.` };
  }
  if (!response.ok) {
    const detail = await googleError(response);
    if (response.status === 403) {
      return { status: 'failed', message: `O Gmail recusou o envio (${detail}). Confirme a permissão de envio e se a Gmail API está ativada no projeto Google.` };
    }
    return { status: 'failed', message: `O Gmail recusou o envio (${detail}). Nada foi enviado; tente novamente.` };
  }
  try {
    const body = await response.json() as { id?: unknown };
    if (typeof body.id === 'string' && body.id) return { status: 'sent', messageId: body.id };
  } catch {
    // Fall through: success status without a readable message id.
  }
  return { status: 'uncertain', message: 'O Gmail respondeu sem identificar a mensagem. Confira a pasta Enviados antes de reenviar.' };
}
