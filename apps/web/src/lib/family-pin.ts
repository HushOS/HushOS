import type { Pin } from '@hushos/drive/trust';

/*
 * Pins taken on a family's word ("Trust as Lindqvist family does", design
 * 2.8): the keys are the member list's, and the name and address the
 * server's (decision D10). Wherever such a pin appears (People, the share
 * picker, who wrote what) it says so, never passing for someone whose words
 * this person compared, and a typed address never matches it.
 */

/* The family whose word a pin is, or null for a pin from this person's own words check. */
export function familyWord(pin: Pick<Pin, 'trustedVia' | 'trustedViaFamily'>) {
    if (!pin.trustedVia) return null;
    return pin.trustedViaFamily || 'A family';
}

/* "The member list of Lindqvist family vouches for these keys", for a pin on a family's word; null otherwise. */
export function vouchLine(pin: Pick<Pin, 'trustedVia' | 'trustedViaFamily'>) {
    const family = familyWord(pin);
    return family ? `The member list of ${family} vouches for these keys` : null;
}

/* A pin's name as a sentence may say it: a family's word always carries the address and the family. */
export function pinName(pin: Pick<Pin, 'name' | 'email' | 'trustedVia' | 'trustedViaFamily'>) {
    const family = familyWord(pin);
    return family
        ? `${pin.name} (${pin.email}), whom the member list of ${family} vouches for`
        : pin.name;
}

/*
 * Every pin by lowercased user id. Two pins whose ids differ only in case (a
 * server serving an id in other letters at some point) are one person: the
 * pin from this person's own words check wins over one on a family's word.
 */
export function pinsById<P extends Pick<Pin, 'userId' | 'trustedVia'>>(
    contacts: Record<string, P>,
) {
    const out = new Map<string, P>();
    for (const pin of Object.values(contacts)) {
        const id = pin.userId.toLowerCase();
        const held = out.get(id);
        if (!held || (held.trustedVia && !pin.trustedVia)) out.set(id, pin);
    }
    return out;
}

/* A person's pin, whatever case their id is written in (see pinsById), with the key it is stored under. */
export function pinOf<P extends Pick<Pin, 'userId' | 'trustedVia'>>(
    contacts: Record<string, P>,
    userId: string,
) {
    const pin = pinsById(contacts).get(userId.toLowerCase());
    if (!pin) return null;
    const key = Object.keys(contacts).find((at) => contacts[at] === pin)!;
    return { key, pin };
}
