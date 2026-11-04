export type { AccountKeyEnvelope, SecurityAction } from '@hushos/crypto';
export { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@hushos/crypto/protocol';
export type AuthUser = { id: string; name: string; email: string };

export type SessionUser = AuthUser & { credentialVersion: number; role: 'member' | 'admin' };

/* Carried from a pricing or referral link into the account being created. */
/*
 * What a signup carries from the page it began on: the plan chosen, a code, where it came from,
 * and the currency a family tier was shown in (three lowercase letters).
 */
export type SignupIntent = { plan?: string; referral?: string; source?: string; currency?: string };

export type DeviceKind = 'web' | 'ios' | 'android';
export type DeviceApproval =
    | 'enrolment'
    | 'password'
    | 'device'
    | 'phrase'
    | 'email-wait'
    | 'guardian'
    | 'existing';

/* One of the account's devices, as the device list shows it. Dates are ISO strings. */
export type AccountDevice = {
    id: string;
    /* Null until the device described itself: listed as an unknown device. */
    kind: DeviceKind | null;
    name: string | null;
    approvedBy: DeviceApproval | null;
    approvedByDeviceId: string | null;
    createdAt: string;
    lastSeenAt: string;
    /* The device asking. */
    current: boolean;
    /* Whether it has a live session. */
    signedIn: boolean;
};

/* The session's device: which one, and whether it has described itself yet. */
export type SessionDevice = { id: string; registered: boolean };
