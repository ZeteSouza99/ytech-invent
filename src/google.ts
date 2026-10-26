import { GoogleSignin, isSuccessResponse } from '@react-native-google-signin/google-signin';
import * as SecureStore from 'expo-secure-store';
import { z } from 'zod';
import { companyUser } from '../shared/account';
import { GMAIL_SEND_SCOPE } from '../shared/gmail';
import { COMPANY_DOMAIN, userSchema, type User } from '../shared/model';

const clientId = process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID ?? '';
const SESSION_KEY = 'ytech.session.v1';
const savedSessionSchema = z.object({ user: userSchema, verifiedAt: z.iso.datetime() }).strict();

export function configurationError(): string | null {
  return clientId.endsWith('.apps.googleusercontent.com') ? null : 'Configure EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID antes de usar o login.';
}

function configureGoogle(): void {
  const error = configurationError();
  if (error) throw new Error(error);
  GoogleSignin.configure({ webClientId: clientId, hostedDomain: COMPANY_DOMAIN, scopes: [GMAIL_SEND_SCOPE], offlineAccess: false });
}

export async function restoreSession(): Promise<User | null> {
  const saved = await SecureStore.getItemAsync(SESSION_KEY);
  if (!saved) return null;
  try {
    const { user } = savedSessionSchema.parse(JSON.parse(saved));
    return companyUser({ id: user.sub, email: user.email, name: user.name });
  } catch {
    // Corrupt session metadata must not make the inventory database inaccessible.
    await SecureStore.deleteItemAsync(SESSION_KEY);
    return null;
  }
}

export async function login(): Promise<User> {
  configureGoogle();
  await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
  const result = await GoogleSignin.signIn();
  if (!isSuccessResponse(result)) throw new Error('Login cancelado. Nenhuma conta foi alterada.');
  let user: User;
  try {
    user = companyUser(result.data.user);
  } catch (error) {
    await GoogleSignin.signOut();
    throw error;
  }
  if (!result.data.scopes.includes(GMAIL_SEND_SCOPE)) {
    const granted = await GoogleSignin.addScopes({ scopes: [GMAIL_SEND_SCOPE] });
    if (!granted || !isSuccessResponse(granted) || !granted.data.scopes.includes(GMAIL_SEND_SCOPE)) {
      throw new Error('Para enviar o inventário, permita que o Ytech Invent envie e-mails pela sua conta. Toque em Entrar novamente e aceite a permissão.');
    }
  }
  await SecureStore.setItemAsync(SESSION_KEY, JSON.stringify({ user, verifiedAt: new Date().toISOString() }));
  return user;
}

export async function logout(): Promise<void> {
  if (clientId) {
    GoogleSignin.configure({ webClientId: clientId });
    await GoogleSignin.signOut();
  }
  await SecureStore.deleteItemAsync(SESSION_KEY);
}

export async function accessToken(owner: string, refresh: boolean): Promise<string> {
  configureGoogle();
  let current = GoogleSignin.getCurrentUser();
  if (!current) {
    const restored = await GoogleSignin.signInSilently();
    if (restored.type !== 'success') throw new Error('Entre novamente com Google para enviar os inventários pendentes.');
    current = restored.data;
  }
  if (current.user.id !== owner) {
    throw new Error('A conta Google atual é diferente da responsável por este inventário. Entre com a conta original.');
  }
  let { accessToken: token } = await GoogleSignin.getTokens();
  if (refresh) {
    await GoogleSignin.clearCachedAccessToken(token);
    ({ accessToken: token } = await GoogleSignin.getTokens());
  }
  if (!token) throw new Error('O Google não forneceu autorização de envio. Entre novamente com sua conta.');
  return token;
}
