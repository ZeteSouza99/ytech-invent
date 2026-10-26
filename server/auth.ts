import { OAuth2Client, type TokenPayload } from 'google-auth-library';
import { COMPANY_DOMAIN, userSchema, type User } from '../shared/model.ts';

export type TokenVerifier = (idToken: string) => Promise<TokenPayload | undefined>;

export class AuthenticationError extends Error {
  constructor(readonly status: 401 | 403, message: string) {
    super(message);
  }
}

export function createGoogleTokenVerifier(clientId: string): TokenVerifier {
  const client = new OAuth2Client(clientId);
  return async idToken => {
    const ticket = await client.verifyIdToken({ idToken, audience: clientId });
    return ticket.getPayload();
  };
}

export async function authenticate(
  authorization: string | undefined,
  verifyToken: TokenVerifier,
  clientId: string,
): Promise<User> {
  const match = authorization?.match(/^Bearer ([^\s]+)$/i);
  if (!match?.[1] || match[1].length > 16384) {
    throw new AuthenticationError(401, 'Entre com sua conta Google corporativa.');
  }
  let claims: TokenPayload | undefined;
  try {
    claims = await verifyToken(match[1]);
  } catch {
    throw new AuthenticationError(401, 'Sessão inválida ou expirada. Entre novamente.');
  }
  if (!claims || claims.aud !== clientId ||
      !['accounts.google.com', 'https://accounts.google.com'].includes(claims.iss) ||
      !Number.isFinite(claims.exp) || claims.exp <= Date.now() / 1000) {
    throw new AuthenticationError(401, 'Sessão inválida ou expirada. Entre novamente.');
  }
  if (claims.email_verified !== true || claims.hd !== COMPANY_DOMAIN ||
      claims.email?.split('@')[1]?.toLowerCase() !== COMPANY_DOMAIN) {
    throw new AuthenticationError(403, 'Acesso restrito a contas verificadas da Ytech Soluções.');
  }
  const user = userSchema.safeParse({
    sub: claims.sub,
    email: claims.email,
    name: claims.name || claims.email,
  });
  if (!user.success || [...user.data.name].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
    throw new AuthenticationError(403, 'A conta corporativa não possui identificação válida.');
  }
  return user.data;
}
