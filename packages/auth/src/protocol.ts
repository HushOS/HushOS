export type { AccountKeyEnvelope } from '@hushos/crypto';
export type AuthUser = { id: string; name: string; email: string };

export type SessionUser = AuthUser & { credentialVersion: number };
