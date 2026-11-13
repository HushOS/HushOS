import { authClient } from '@/lib/auth-client';
import { keepNewPhrase, whenLocked, type NewPhrase } from '@/lib/new-phrase';

/*
 * Hands a rotation's new recovery phrase to the gate that shows it (lib/new-phrase.ts), tied
 * to this browser's auth state: the words are forgotten the moment it is locked or signed
 * out, here or in another tab. Apart from new-phrase.ts so the gate, which every page loads,
 * does not load the auth client with it.
 */
export function showNewPhrase(made: NewPhrase) {
    keepNewPhrase(made, authClient.store);
}

/*
 * Runs `gone` the moment this browser is locked or signed out, here or in another tab; for a
 * page that shows a new phrase from its own memory (the reset page). Returns what stops it.
 */
export function whenBrowserLocks(gone: () => void) {
    return whenLocked(authClient.store, gone);
}
