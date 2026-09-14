export type { AccountKeyEnvelope, SecurityAction } from '@hushos/crypto';
export { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@hushos/crypto/protocol';
export type AuthUser = { id: string; name: string; email: string };

export type SessionUser = AuthUser & { credentialVersion: number; role: 'member' | 'admin' };

/* Carried from a pricing or referral link into the account being created. */
export type SignupIntent = { plan?: string; referral?: string; source?: string };
