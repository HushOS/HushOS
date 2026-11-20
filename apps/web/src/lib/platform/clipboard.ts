/* How long a copied secret may sit on the clipboard before this page clears it. */
const SECRET_TTL_MS = 120_000;

/*
 * Copies a secret (a recovery phrase, a key, a link with its key) and clears
 * it two minutes later if the clipboard still holds it, so it does not linger
 * in clipboard history or sync to the person's other devices for good. Reading
 * the clipboard back needs the page focused and allowed; without that the
 * copy simply stays, as any copy would.
 */
export async function copySecret(text: string) {
    await navigator.clipboard.writeText(text);
    window.setTimeout(() => {
        void (async () => {
            try {
                if ((await navigator.clipboard.readText()) === text)
                    await navigator.clipboard.writeText('');
            } catch {
                /* Not allowed to look: leave the clipboard alone. */
            }
        })();
    }, SECRET_TTL_MS);
}
