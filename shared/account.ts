import { COMPANY_DOMAIN, userSchema, type User } from './model';

// Google Workspace "Internal" audience blocks other domains at sign-in; this is the app-side check.
export function companyUser(account: { id: string; email: string; name: string | null }): User {
  const email = account.email.trim().toLowerCase();
  const at = email.lastIndexOf('@');
  if (at <= 0 || email.slice(at + 1) !== COMPANY_DOMAIN) {
    throw new Error(`Use uma conta Google @${COMPANY_DOMAIN}. A conta ${account.email} não tem acesso ao inventário.`);
  }
  return userSchema.parse({ sub: account.id, email, name: account.name?.trim() || email });
}
