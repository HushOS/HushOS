/*
 * One prompt before leaving the page, for everything that would be lost: uploads
 * on their way and a tool's results waiting to upload (lib/drive/transfers/transfers.ts), a
 * tool's results not yet handed to the save path (lib/tools/run.ts). Each says
 * whether it holds something now; a single `beforeunload` listener asks while any
 * does, so the browser shows one prompt, never two.
 */

const holders = new Set<() => boolean>();
let listening = false;

/* What the listener asks: the page may go only when nothing holds it. */
export function leaving(event: BeforeUnloadEvent) {
    for (const holds of holders)
        if (holds()) {
            event.preventDefault();
            // Chrome still requires returnValue to be set for the prompt to show.
            event.returnValue = '';
            return;
        }
}

/* Holds the page while `holds` says so; the listener goes on once, at the first. */
export function holdPageWhile(holds: () => boolean) {
    holders.add(holds);
    if (!listening && typeof window !== 'undefined') {
        listening = true;
        window.addEventListener('beforeunload', leaving);
    }
    return () => void holders.delete(holds);
}
