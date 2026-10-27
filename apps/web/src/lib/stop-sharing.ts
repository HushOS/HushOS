/*
 * Stop sharing with Maya (docs/optional-verification.md 6.6, 4.4): every
 * share this account made with one person is revoked, and each item it
 * covered is re-keyed, so a key she was sent opens nothing added afterwards.
 * The remedy for words that did not match, where removing a contact would
 * only forget the pin.
 *
 * What it covers is the union of the owner's own ledger and the server's
 * list, resolved node by node rather than through the server's list alone: a
 * shared folder now in Trash, or a share the server leaves out of its list,
 * is still named by the ledger, and its shares are looked up and revoked and
 * its keys changed like any other's. Restoring it from Trash opens nothing to
 * her.
 *
 * Durable before anything reaches the server (StopWork, the settings in the
 * app): one save takes her out of every ledger entry, so no rotation anywhere
 * seals to her again, and records each item as owed a revocation and a
 * re-key. Each item's revocations are crossed off as they land and each
 * re-key once it has finished, so a failure, a closed tab or a retry (here or
 * on opening Drive, resumeStopping) carries on from what is still owed and
 * never loses an item it already revoked.
 */

/* What the owner's settings hold of this work, beside the ledger. */
export type StopRecord = {
    shares: Record<string, string[]>;
    /* Per person, the items whose shares to them are still to be revoked. */
    stopping?: Record<string, string[]>;
    /* Items owed a re-key, oldest first. */
    rekey?: string[];
};

export type StopWork = {
    read(): Promise<StopRecord>;
    /* Applies one of the changes below to the record as stored, in one save. */
    save(change: (record: StopRecord) => void): Promise<void>;
};

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const union = (a: string[] | undefined, b: string[]) => [...new Set([...(a ?? []), ...b])];

/* `contactId` out of every ledger entry, and `nodeIds` owed their revocations and a re-key. */
export function begin(record: StopRecord, contactId: string, nodeIds: string[]) {
    for (const [nodeId, people] of Object.entries(record.shares)) {
        const kept = people.filter((person) => !same(person, contactId));
        if (kept.length) record.shares[nodeId] = kept;
        else delete record.shares[nodeId];
    }
    if (!nodeIds.length) return;
    record.stopping ??= {};
    const key = Object.keys(record.stopping).find((person) => same(person, contactId)) ?? contactId;
    record.stopping[key] = union(record.stopping[key], nodeIds);
    record.rekey = union(record.rekey, nodeIds);
}
/* Every share of `nodeId` to `contactId` is revoked. */
export function revoked(record: StopRecord, contactId: string, nodeId: string) {
    if (!record.stopping) return;
    const key = Object.keys(record.stopping).find((person) => same(person, contactId));
    if (!key) return;
    const left = record.stopping[key]!.filter((id) => id !== nodeId);
    if (left.length) record.stopping[key] = left;
    else delete record.stopping[key];
    if (!Object.keys(record.stopping).length) delete record.stopping;
}
/* Items a stopped share or link leaves owed a re-key, recorded before it is stopped. */
export function owe(record: StopRecord, nodeIds: string[]) {
    record.rekey = union(record.rekey, nodeIds);
}
/* One re-key finished, or its item gone for good. */
export function rekeyed(record: StopRecord, nodeId: string) {
    const left = (record.rekey ?? []).filter((id) => id !== nodeId);
    if (left.length) record.rekey = left;
    else delete record.rekey;
}

/*
 * Every re-key owed, oldest first, each crossed off only once it finished
 * (`rotate` answers false for an item gone for good, which is crossed off
 * too). A failure stops the walk with that item and everything after it still
 * owed, for the next run.
 */
export async function rekeyAll(
    work: StopWork,
    rotate: (nodeId: string) => Promise<boolean>,
    finished: () => void = () => {},
) {
    let rotated = 0;
    for (;;) {
        const nodeId = (await work.read()).rekey?.[0];
        if (!nodeId) return { rotated };
        if (await rotate(nodeId)) {
            rotated++;
            finished();
        }
        await work.save((record) => rekeyed(record, nodeId));
    }
}

export type StopSharingParts = {
    work: StopWork;
    /* What the server lists this account as sharing, by item and person. */
    listed: () => Promise<{ nodeId: string; granteeId: string }[]>;
    /* An item's shares as the server keeps them, in Trash too; empty once it is gone for good. */
    sharesOf: (nodeId: string) => Promise<{ id: string; granteeId: string }[]>;
    /* Ends one share on the server; one already ended is not an error. */
    revoke: (nodeId: string, shareId: string) => Promise<void>;
    /* Runs every re-key owed, in order; settles once they all have. */
    rekey: () => Promise<unknown>;
};

/* The revocations owed to one person, item by item, each crossed off once it landed. */
async function revokeOwed(contactId: string, parts: StopSharingParts) {
    const record = await parts.work.read();
    const owed = Object.entries(record.stopping ?? {}).find(([person]) => same(person, contactId));
    let count = 0;
    for (const nodeId of owed?.[1] ?? []) {
        for (const share of await parts.sharesOf(nodeId))
            if (same(share.granteeId, contactId)) {
                await parts.revoke(nodeId, share.id);
                count++;
            }
        await parts.work.save((record) => revoked(record, owed![0], nodeId));
    }
    return count;
}

export async function stopSharingWith(contactId: string, parts: StopSharingParts) {
    const [record, listed] = await Promise.all([parts.work.read(), parts.listed()]);
    const nodes = new Set<string>();
    for (const [nodeId, people] of Object.entries(record.shares))
        if (people.some((person) => same(person, contactId))) nodes.add(nodeId);
    for (const share of listed) if (same(share.granteeId, contactId)) nodes.add(share.nodeId);
    // Recorded before the server is asked anything: from here a failure leaves work owed, not lost.
    await parts.work.save((record) => begin(record, contactId, [...nodes]));
    try {
        return { stopped: await revokeOwed(contactId, parts), rotated: parts.rekey() };
    } catch (error) {
        // What did land is re-keyed now; the rest is revoked and re-keyed on the next attempt.
        void parts.rekey();
        throw error;
    }
}

/* On opening Drive: whatever a Stop sharing left owed, revocations first, then the re-keys. */
export async function resumeStopping(parts: StopSharingParts) {
    const record = await parts.work.read();
    let failed: unknown = null;
    for (const person of Object.keys(record.stopping ?? {}))
        await revokeOwed(person, parts).catch((error: unknown) => {
            failed ??= error;
        });
    await parts.rekey();
    if (failed) throw failed;
}
