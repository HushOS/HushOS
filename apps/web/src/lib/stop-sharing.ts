import type { DriveNode, SharingLedger } from '@hushos/drive/client';

/*
 * Stop sharing with Maya (docs/optional-verification.md 6.6, 4.4): every
 * share this account made with one person is revoked, and each item it
 * covered is re-keyed, so a key she was sent opens nothing added afterwards.
 * The remedy for words that did not match, where removing a contact would
 * only forget the pin.
 *
 * What is revoked is the union of the owner's own ledger and the server's
 * list: a share the server lists is ended whether or not the ledger knew it,
 * and a ledger entry the server no longer lists is dropped from the ledger,
 * so no later rotation seals to her again. Each revocation takes her out of
 * the ledger before the server is asked (the Drive client's revokeShare), and
 * every rotation is started only once all of them are done.
 */
export type StopSharingParts = {
    ledger: SharingLedger;
    /* What this account shares, its items opened (the Drive client's mySharing). */
    shares: () => Promise<{ shares: { id: string; node: DriveNode; grantee: { id: string } }[] }>;
    revoke: (node: DriveNode, shareId: string) => Promise<void>;
    /* Re-keys an item after a revocation; `rotated` settles once every one has. */
    rotate: (node: DriveNode) => Promise<unknown> | void;
};

export async function stopSharingWith(contactId: string, parts: StopSharingParts) {
    const id = contactId.toLowerCase();
    const [ledger, { shares }] = await Promise.all([parts.ledger.read(), parts.shares()]);
    const theirs = shares.filter((share) => share.grantee.id.toLowerCase() === id);
    for (const share of theirs) await parts.revoke(share.node, share.id);
    // The ledger's own entries for them that the server did not list: nothing to revoke there,
    // but nothing may be sealed to them again either.
    const listed = new Set(theirs.map((share) => share.node.id));
    for (const [nodeId, people] of Object.entries(ledger.shares))
        for (const person of people)
            if (person.toLowerCase() === id && !listed.has(nodeId))
                await parts.ledger.removeShare(nodeId, person);
    // Once each, after every revocation: the re-keying seals to whoever is still shared with.
    const rotations = new Map<string, Promise<unknown>>();
    for (const share of theirs)
        if (!rotations.has(share.node.id))
            rotations.set(share.node.id, Promise.resolve(parts.rotate(share.node)));
    return { stopped: theirs.length, rotated: Promise.all(rotations.values()) };
}
