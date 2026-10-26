import { LoginTicket, OAuth2Client, type TokenPayload } from 'google-auth-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { authenticate, createGoogleTokenVerifier } from '../server/auth.ts';

const clientId = 'configured-audience';
const claims: TokenPayload = {
  sub: 'google-sub', email: 'pessoa@ytechsolucoes.com', name: 'Pessoa', email_verified: true,
  hd: 'ytechsolucoes.com', aud: clientId, iss: 'https://accounts.google.com',
  exp: Math.floor(Date.now() / 1000) + 3600, iat: Math.floor(Date.now() / 1000),
};

afterEach(() => vi.restoreAllMocks());

describe('Google ID token e política corporativa', () => {
  it('usa verifyIdToken com audience do servidor, nunca apenas decodificação', async () => {
    const verify = vi.spyOn(OAuth2Client.prototype, 'verifyIdToken')
      .mockImplementation(async () => new LoginTicket('', claims));
    const verifier = createGoogleTokenVerifier(clientId);
    expect(await authenticate('Bearer signed-token', verifier, clientId)).toEqual({
      sub: claims.sub, email: claims.email, name: claims.name,
    });
    expect(verify).toHaveBeenCalledExactlyOnceWith({ idToken: 'signed-token', audience: clientId });
  });

  it.each([
    ['email não verificado', { email_verified: false }, 403],
    ['hd externo', { hd: 'attacker.test' }, 403],
    ['hd ausente', { hd: undefined }, 403],
    ['hd com sufixo', { hd: 'ytechsolucoes.com.attacker.test' }, 403],
    ['domínio externo', { email: 'person@attacker.test' }, 403],
    ['subdomínio', { email: 'person@sub.ytechsolucoes.com' }, 403],
    ['sufixo no domínio', { email: 'person@ytechsolucoes.com.attacker.test' }, 403],
    ['email malformado', { email: 'person@ytechsolucoes.com@attacker.test' }, 403],
    ['subject vazio', { sub: '' }, 403],
    ['nome com quebra de linha', { name: 'Pessoa\r\nBcc: attacker@test.com' }, 403],
    ['audience errada', { aud: 'different-audience' }, 401],
    ['issuer errado', { iss: 'https://attacker.test' }, 401],
    ['token expirado', { exp: 0 }, 401],
  ])('rejeita %s', async (_name, changes, status) => {
    await expect(authenticate('Bearer token', async () => ({ ...claims, ...changes }), clientId))
      .rejects.toMatchObject({ status });
  });

  it('falha fechada se a verificação de assinatura rejeitar ou não retornar claims', async () => {
    await expect(authenticate('Bearer token', async () => { throw new Error('signature'); }, clientId))
      .rejects.toMatchObject({ status: 401 });
    await expect(authenticate('Bearer token', async () => undefined, clientId)).rejects.toMatchObject({ status: 401 });
    const verify = vi.fn(async () => claims);
    await expect(authenticate('Basic token', verify, clientId)).rejects.toMatchObject({ status: 401 });
    expect(verify).not.toHaveBeenCalled();
  });
});
