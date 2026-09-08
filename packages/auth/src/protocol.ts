export type { AccountKeyEnvelope, SecurityAction } from '@hushos/crypto';
export type AuthUser = { id: string; name: string; email: string };

export type SessionUser = AuthUser & { credentialVersion: number };
