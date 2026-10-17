import type { AreaRotationInput, GroupWriter, RotatedDocumentWire } from '@hushos/crypto';
import type { DriveApi, RekeyView } from '@hushos/drive/api';
import { DOCUMENT_KINDS } from '@hushos/drive/protocol';
import type { GroupsApi } from './api';
import type { RotationSource } from './context';

/*
 * What a roster call's rotations are built from (the 1c plan, sections 2 and
 * 4; docs/groups-server.md 8): for each family folder, its top folder as
 * route 29 serves it to a holder, a target epoch drawn fresh from the
 * folder's own epochs route, and every workspace document the folder holds,
 * of each kind this client knows and of any kind a 409 document-stale named.
 * Read again on every rebuild (rotating, epoch-stale, root-moved,
 * document-stale), never kept, since each answer says the folder moved.
 *
 * The worker does the rest: it opens each document under the key being
 * replaced and seals it again for its next version under the new key (a
 * document it cannot open goes on empty, with the documents-cleared notice),
 * re-keys the top folder, and refuses to build anything it cannot open again
 * with the new key.
 *
 * Shares and links on a family folder's top folder are not handed to the
 * worker: nothing records who made them on this person's behalf (the sharing
 * ledger is each person's own), so the rotation closes them rather than seal
 * a new key to recipients only the server names. The web offers neither in
 * family folders (1c step 7).
 */

export type AreaRoot = Awaited<ReturnType<GroupsApi['areaRoot']>>;

export type RotationDeps = {
    areaRoot: GroupsApi['areaRoot'];
    allocateEpochs: DriveApi['allocateEpochs'];
    document: DriveApi['document'];
    /* Who wrote what the rotations re-sign, as group verdicts take them. */
    writers(groupId: string): Promise<GroupWriter[]>;
    /* Walks a running Drive rotation in a family folder to its end, with the family's trust. */
    walk(
        groupId: string,
        rotation: { workspaceId: string; rotationId: string; nodeId: string; targetEpoch: number },
    ): Promise<void>;
};

/*
 * The top folder as a roster rotation re-keys it (AreaRootRotationInput in
 * the worker): as served, with the area key version its envelope is under now
 * (`wrappedParentKeyEpoch`) and the one it goes under (`parentKeyEpoch`, one
 * more). The worker checks that against the staged member list's own version.
 */
/* A served origin as the worker takes it, the writer by id (as servedRekeyOf in @hushos/drive/client). */
function servedRekeyOf(view: RekeyView | null | undefined) {
    if (!view) return null;
    return {
        origin: {
            envelope: view.origin.envelope,
            signerId: view.origin.signer?.id ?? null,
            signature: view.origin.signature,
            keyEnvelope: view.origin.keyEnvelope,
        },
        signature: view.signature,
    };
}

export function rootInput(workspaceId: string, served: AreaRoot): AreaRotationInput['root'] {
    return {
        id: served.id,
        kind: 'folder',
        parentId: workspaceId,
        parentKeyEpoch: served.parentKeyEpoch + 1,
        keyEpoch: served.keyEpoch,
        wrappedParentKeyEpoch: served.parentKeyEpoch,
        keyEnvelope: served.keyEnvelope,
        metadataVersion: served.metadataVersion,
        metadataEnvelope: served.metadataEnvelope,
        metadataSigner: served.metadataSigner?.id ?? null,
        metadataSignature: served.metadataSignature ?? null,
        // The origin an earlier rotation kept: the worker carries it, the server copies it.
        metadataRekey: servedRekeyOf(served.metadataRekey),
        versions: served.versions.map((version) => ({
            id: version.id,
            objectId: version.objectId,
            contentKeyEnvelope: version.contentKeyEnvelope,
            contentSuite: version.contentSuite,
            plaintextSize: version.plaintextSize === null ? null : Number(version.plaintextSize),
            signer: version.signer?.id ?? null,
            signature: version.signature ?? null,
            rekey: servedRekeyOf(version.rekey),
        })),
        shares: [],
        links: [],
        changeSeq: served.changeSeq ?? 0,
    };
}

export function createRotationSource(deps: RotationDeps): RotationSource {
    async function readOne(
        groupId: string,
        workspaceId: string,
        named: readonly string[],
    ): Promise<AreaRotationInput> {
        const served = await deps.areaRoot(groupId, workspaceId);
        // Drawn after the root is read: the target must be above every epoch the folder carries.
        const { from } = await deps.allocateEpochs(workspaceId, 1);
        const documents: RotatedDocumentWire[] = [];
        for (const kind of [...new Set([...DOCUMENT_KINDS, ...named])].sort()) {
            const { document } = await deps.document(workspaceId, kind);
            if (document)
                documents.push({
                    kind: document.kind,
                    version: document.version,
                    envelope: document.envelope,
                });
        }
        return { workspaceId, targetEpoch: from, root: rootInput(workspaceId, served), documents };
    }
    return {
        async read(groupId, areas) {
            const out: AreaRotationInput[] = [];
            for (const area of areas)
                out.push(await readOne(groupId, area.workspaceId, area.kinds));
            return out;
        },
        writers: (groupId) => deps.writers(groupId),
        finish: (groupId, rotation) => deps.walk(groupId, rotation),
    };
}
