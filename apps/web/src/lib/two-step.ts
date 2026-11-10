/*
 * Two-step sign-in, the words and files the browser makes itself
 * (docs/two-step-design.md 2): the setup key as it is read aloud or typed, the
 * backup codes as a text file, and how many are left. Nothing here talks to the
 * server; lib/two-step-status.ts does.
 */

import { useSyncExternalStore } from 'react';

/* An authenticator secret for typing by hand: base32 in groups of four. */
export function groupSecret(secret: string) {
    return (
        secret
            .replace(/\s+/g, '')
            .match(/.{1,4}/g)
            ?.join(' ') ?? ''
    );
}

/* How many backup codes are left, as the settings row and the sign-in screen say it. */
export function codesLeft(count: number) {
    if (count <= 0) return 'No backup codes left';
    return `${count} backup ${count === 1 ? 'code' : 'codes'} left`;
}

/*
 * When a method was last used. The server gives the day only, and it is the server's day
 * (UTC): every session of the account reads this, and a time of day would say when the owner
 * signs in. So it is compared with today's date in UTC, never read as a moment in the
 * browser's own timezone, where midnight UTC is the evening before or the morning after.
 */
const usedDay = new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
});
const usedDayYear = new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
});
export function usedOn(value: string | Date, now = new Date()) {
    // A string from the server's own render, a Date from the API client, which parses them.
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    const dayOf = (moment: Date) => moment.toISOString().slice(0, 10);
    const day = dayOf(date);
    if (day === dayOf(now)) return 'today';
    if (day === dayOf(new Date(now.getTime() - 86_400_000))) return 'yesterday';
    return (day.slice(0, 4) === dayOf(now).slice(0, 4) ? usedDay : usedDayYear).format(date);
}

/*
 * When a method was added: the same calendar as its last use (UTC), so the two never
 * disagree, and the server's render and the browser's say the same day wherever each is.
 */
export function addedOn(value: string | Date, now = new Date()) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    const sameYear = date.getUTCFullYear() === now.getUTCFullYear();
    return (sameYear ? usedDay : usedDayYear).format(date);
}

/* At two or fewer the account is close to having none: both screens suggest a new set. */
export const FEW_CODES = 2;

/*
 * The backup codes as a text file, made on the device: which account and which
 * HushOS they are for, what they do, and the codes, numbered. The codes are
 * shown once, so this file is often the only copy.
 */
export function backupCodesText(
    account: { email: string },
    codes: readonly string[],
    host: string,
    madeOn = new Date(),
) {
    return [
        'HushOS backup codes',
        `Saved ${madeOn.toISOString().slice(0, 10)}`,
        '',
        `Account:  ${account.email}`,
        `Server:   ${host}`,
        '',
        'Each code signs you in once, after your password, when you can’t use',
        'your authenticator app. Keep this file private, and keep it apart from',
        'your password.',
        '',
        ...codes.map((code, index) => `${String(index + 1).padStart(2, ' ')}. ${code}`),
        '',
        'Making a new set of codes in your account settings stops these working.',
        '',
    ].join('\n');
}

/*
 * Signing in with the recovery phrase opens Account on Two-step sign-in, which then says what
 * to do next. Kept in memory for this page's life: the sign-in page sets it on every sign-in
 * that answered a step, and the section reads it. A reload forgets it.
 */
let phraseSignIn = false;
const watchers = new Set<() => void>();
export function notePhraseSignIn(value: boolean) {
    if (phraseSignIn === value) return;
    phraseSignIn = value;
    for (const watcher of watchers) watcher();
}
function watch(watcher: () => void) {
    watchers.add(watcher);
    return () => void watchers.delete(watcher);
}
export function usePhraseSignIn() {
    return useSyncExternalStore(
        watch,
        () => phraseSignIn,
        () => false,
    );
}
