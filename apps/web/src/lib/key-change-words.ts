import { KEY_CHANGE_PENDING } from '@hushos/crypto/protocol';

/*
 * The crypto worker refuses a write in a family folder a key change has not
 * reached yet with KEY_CHANGE_PENDING (docs/groups-design.md 2.10), a sentence
 * both twins match exactly and so can't be reworded where it is thrown. Uploads
 * wait it out ("Finishing a key change…"); anything else (a new folder, a
 * rename, a move or copy) says it in the person's words, with what to do.
 * Kept free of the drive client so the families pages and the join page can
 * use it too.
 */
export const KEY_CHANGE_WAIT =
    'HushOS is finishing a key change for this folder. Try again in a moment.';

/* A worker's sentence as the person reads it: only the exact key-change refusal is reworded. */
export function keyChangeWords(message: string) {
    return message === KEY_CHANGE_PENDING ? KEY_CHANGE_WAIT : message;
}
