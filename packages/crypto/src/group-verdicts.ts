import { folderStanding, type AreaLists } from './area-lists';
import {
    folderIntegrityOf,
    groupIntegrityOf,
    groupRekeyedIntegrityOf,
    groupWriterTrust,
    type FolderIntegrity,
    type GroupIntegrity,
    type GroupReading,
    type GroupWriterTrust,
} from './group-trust';
import { decode } from './keys';
import type { GroupWriter, RecordJudge } from './session-groups';
import {
    integrityOf,
    resealForm,
    type Integrity,
    type RekeyedRecord,
    type StatementForms,
    type TrustedSigner,
} from './signatures';

/*
 * A record's verdict in a family folder, and how a copy out of one signs it:
 * the glue between the group session's chain and the readers in group-trust.ts
 * (design 2.8). Moved out of session-groups.ts unchanged so the Rust core has
 * a twin to be held to (crates/hushos-core/src/group_verdicts.rs, which
 * AreaLedger::record_verdict and AreaLedger::copy_form run): the shared
 * fixtures read the nodes each twin rotated with the other's verdicts
 * (area-ledger fixtures, `rotations`).
 */

export type VerdictInput = {
    groupId: string;
    workspaceId: string;
    reading: GroupReading;
    writers: GroupWriter[];
    /* The personal keys trusted for each writer, and this account's own (current and retired). */
    trusted: Map<string, TrustedSigner>;
    /* This account's user id: its own records are judged by its own keys. */
    me: string;
    /* The areas the family opened on this device, at the version opened. */
    areas: Record<string, number>;
    /* The session's succession-link verifications (groupWriterTrust's `verified`). */
    verified?: Map<string, boolean>;
};

/*
 * What a company folder's verdicts are judged against beside (companies-design
 * 2.3, "Who writes"): the folder's list as this device verified it at the
 * chain's latest roster (readAreaLists), null when it did not load, and the
 * colleagues who edit the record's subtree by a share record that verifies.
 */
export type FolderInput = VerdictInput & {
    folder: { lists: AreaLists | null; sharedEditors?: readonly string[] };
};

type Verdict<I> = { integrity: I; via: string | null };
type Checks<I> = ((
    statements: () => Promise<StatementForms>,
    signer: string | null,
    signature: string | null,
) => Promise<Verdict<I>>) & {
    rekeyed: (
        record: RekeyedRecord,
        nodeKey: Uint8Array | null,
        rekeyer: string | null,
    ) => Promise<{ origin: Verdict<I>; rekeyer: Verdict<I>; bound: boolean | null }>;
};
export type RecordVerdicts = Checks<GroupIntegrity>;
export type FolderRecordVerdicts = Checks<FolderIntegrity>;

/*
 * A record's group verdict (design 2.8): this account's own records by its
 * own keys, anyone else's as the roster says, personal keys where the
 * roster does not speak. A check that throws is `unchecked`. A company's
 * folder is read with folderRecordVerdicts: here, with no list to go by, a
 * colleague's record whose signature holds reads `unchecked`.
 */
export function recordVerdicts(input: VerdictInput): RecordVerdicts {
    // Without a list no verdict is `not-on-this-folder`: every one is a group's.
    return verdictsOf(input, null) as RecordVerdicts;
}

/*
 * A record's verdict in a company's folder (companies-design 2.3, "Who
 * writes"): recordVerdicts, and then the folder's own rows for a writer who
 * is active on the roster and whose signature holds, by the list this device
 * verified.
 */
export function folderRecordVerdicts(input: FolderInput): FolderRecordVerdicts {
    return verdictsOf(input, input.folder);
}

function verdictsOf(input: VerdictInput, folder: FolderInput['folder'] | null) {
    const { groupId, workspaceId, reading, writers, trusted, areas, verified } = input;
    const me = input.me.toLowerCase();
    const byId = new Map(writers.map((writer) => [writer.userId.toLowerCase(), writer]));
    const trust = new Map<string, Promise<GroupWriterTrust | null>>();
    /*
     * A company folder's own rows, after the verdict of 2.8: by the list this device verified.
     * A family has no lists, and a roster that did not load has given its verdict already.
     */
    const onFolder = (
        verdict: { integrity: GroupIntegrity; via: string | null },
        writerTrust: GroupWriterTrust,
        userId: string,
    ) => {
        if (reading.status !== 'accepted' || reading.chain.kind !== 'org') return verdict;
        return folderIntegrityOf(
            verdict,
            writerTrust,
            folderStanding({
                chain: reading.chain,
                lists: folder?.lists ?? null,
                workspaceId,
                writerUserId: userId,
                sharedEditors: folder?.sharedEditors,
            }),
        );
    };
    const trustOf = (userId: string) => {
        let held = trust.get(userId);
        if (!held) {
            const writer = byId.get(userId);
            held = groupWriterTrust({
                groupId,
                areas,
                reading,
                workspaceId,
                writerUserId: userId,
                pinned: writer?.pinned ?? null,
                served: writer?.served ?? null,
                links: writer?.links ?? null,
                verified,
            }).catch(() => null);
            trust.set(userId, held);
        }
        return held;
    };
    /* Whose keys a re-keyed record's signer is judged under: their roster trust, or this account's own. */
    const rekeyedTrustOf = async (
        userId: string | null,
    ): Promise<{ trust: GroupWriterTrust; personal: TrustedSigner | null }> => {
        const id = userId?.toLowerCase() ?? null;
        if (!id) return { trust: { trust: 'outside' }, personal: null };
        if (id === me) return { trust: { trust: 'outside' }, personal: trusted.get(id) ?? null };
        return {
            trust: (await trustOf(id)) ?? { trust: 'unchecked' },
            personal: trusted.get(id) ?? null,
        };
    };
    /*
     * A re-keyed record's verdicts (design 2.8): its origin's, as its writer's
     * trust says, and the re-keyer's, as theirs does. `nodeKey` is the node's
     * key at the record's epoch, null when not held (unchecked).
     */
    const rekeyed = async (
        record: RekeyedRecord,
        nodeKey: Uint8Array | null,
        rekeyer: string | null,
    ) => {
        try {
            const origin = await rekeyedTrustOf(record.origin.signerId);
            const by = await rekeyedTrustOf(rekeyer);
            const checked = await groupRekeyedIntegrityOf(record, nodeKey, {
                origin: origin.trust,
                originPersonal: origin.personal,
                rekeyer: by.trust,
                rekeyerPersonal: by.personal,
            });
            return {
                ...checked,
                origin: onFolder(
                    checked.origin,
                    origin.trust,
                    record.origin.signerId?.toLowerCase() ?? '',
                ),
                rekeyer: onFolder(checked.rekeyer, by.trust, rekeyer?.toLowerCase() ?? ''),
            };
        } catch {
            return {
                origin: { integrity: 'unchecked' as const, via: null },
                rekeyer: { integrity: 'unchecked' as const, via: null },
                bound: null,
            };
        }
    };
    const check = async (
        statements: () => Promise<StatementForms>,
        signer: string | null,
        signature: string | null,
    ): Promise<Verdict<FolderIntegrity>> => {
        let bytes: Uint8Array | null = null;
        if (signature)
            try {
                bytes = decode(signature);
            } catch {
                bytes = new Uint8Array(0);
            }
        // No signature is unsigned before any trust is looked up: a lookup that fails (and
        // reads unchecked) must not hide a stripped one.
        if (!bytes) return { integrity: 'unsigned', via: null };
        try {
            const id = signer?.toLowerCase() ?? null;
            if (!id || id === me)
                return {
                    integrity: await integrityOf(statements, bytes, id ? trusted.get(id) : null),
                    via: null,
                };
            const writerTrust = await trustOf(id);
            if (!writerTrust) return { integrity: 'unchecked', via: null };
            return onFolder(
                await groupIntegrityOf(statements, bytes, writerTrust, trusted.get(id) ?? null),
                writerTrust,
                id,
            );
        } catch {
            return { integrity: 'unchecked', via: null };
        }
    };
    return Object.assign(check, { rekeyed });
}

/*
 * How a copy in a group area signs a record: verified stays ordinary and
 * saved stays saved; a former member's record, a key conflict's and, in a
 * company's folder, one by a colleague who is not on it are re-sealed, as is
 * anything else; an unchecked one is not copied at all
 * (resealForm refuses).
 */
export function judgeWith(verdict: RecordVerdicts | FolderRecordVerdicts): RecordJudge {
    return async (record) => {
        let integrity: FolderIntegrity;
        if (record.rekeyed) {
            const checked = await verdict.rekeyed(
                record.rekeyed.record,
                record.rekeyed.nodeKey,
                record.rekeyed.rekeyer,
            );
            // Bytes that do not bind to the writer's record (a broken wrap, the wrong epoch,
            // a key this device does not hold): the copy is re-sealed, never vouched for.
            if (checked.bound !== true) return 'resealed';
            integrity = checked.origin.integrity;
        } else
            integrity = (await verdict(record.statements, record.signer, record.signature))
                .integrity;
        // (A colleague the folder's list does not name is no writer to vouch for either.)
        if (
            integrity === 'key-conflict' ||
            integrity === 'former-member' ||
            integrity === 'not-on-this-folder'
        )
            return 'resealed';
        return resealForm(integrity as Integrity);
    };
}
