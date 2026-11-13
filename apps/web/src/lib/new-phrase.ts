/*
 * The recovery phrase a rotation just made, kept in this tab's memory on the way from the
 * dialog that made it to the sign-in page that shows it. A new recovery phrase or a new
 * account key replaces the phrase, and the old one stops working once the server accepts the
 * change. When this browser is then not signed in again, the page that would show the new
 * words is behind a sign-in whose second step may need them: so they are shown first, on the
 * sign-in page itself. Never stored: a reload forgets them, as any page showing a phrase does.
 */
export type NewPhrase = {
    phrase: string;
    /* Whether the change went through: yes, or could not be confirmed. */
    applied: true | 'unknown';
    /* Why this browser was not signed in again, when its own storage was the reason. */
    storage: string | null;
    /* What made it: a reset with the old phrase, or a rotation from Account. */
    from: 'reset' | 'rotation';
};

/* How long the words wait to be shown: the walk from the dialog to the sign-in page, generously. */
const KEPT_MS = 10 * 60_000;

let kept: { made: NewPhrase; until: number } | null = null;

export function keepNewPhrase(made: NewPhrase) {
    kept = { made, until: Date.now() + KEPT_MS };
}
/*
 * Read without forgetting: a page may render more than once before it has shown anything.
 * Words nobody came for are dropped: the browser was signed in after all (its session
 * arrived though the reply did not), and the app shows the phrase itself there.
 */
export function keptNewPhrase() {
    if (kept && Date.now() > kept.until) kept = null;
    return kept?.made ?? null;
}
export function forgetNewPhrase() {
    kept = null;
}
