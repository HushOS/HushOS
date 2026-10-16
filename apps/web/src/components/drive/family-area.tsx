import type { DriveNode } from '@hushos/drive/client';
import { createContext, useContext } from 'react';

/*
 * The family folder a Drive page is showing, when it is one (the family
 * space pages, /app/s/<family>/f/<folder>): which family and folder, whether
 * this device may write in it, and the names the server gives its members,
 * which the verdicts' words need. Outside a family folder there is none, and
 * the page is this account's own Drive.
 *
 * Kept free of the families data layer, so the Drive pages that read it do
 * not load that layer for everyone.
 */

/*
 * Whether this device may add to or change the folder (the F9 rule, plan
 * section 5): `writable`; `read-only`, the keys at the folder's latest
 * version could not be checked here (no grant at that version, or no root),
 * so nothing is written under an older key; `keys-changed`, the server and
 * the member list disagree about the folder's key version, or its top
 * folder is not under the latest key yet, until the family is checked again.
 */
export type AreaWrite = 'writable' | 'read-only' | 'keys-changed';

export type FamilyArea = {
    groupId: string;
    /* The family's name, from the server. */
    family: string;
    workspaceId: string;
    rootId: string;
    /* The folder's own name, sealed in its top folder. */
    name: string;
    write: AreaWrite;
    /*
     * A Drive key change walking the folder (route 25's rotation): items not
     * yet under its target epoch wait for it before anything is added to them.
     */
    rotation: { targetEpoch: number } | null;
    /* Members as the server names them, by user id: a name always goes with its email. */
    members: Record<string, { name: string; email: string | null }>;
    /* Checks the family again: what a "keys changed" folder needs before it is written. */
    recheck: () => void;
};

const FamilyAreaContext = createContext<FamilyArea | null>(null);
export const FamilyAreaProvider = FamilyAreaContext.Provider;

export function useFamilyArea() {
    return useContext(FamilyAreaContext);
}

/* Whether a key change still has to reach `folder` before anything goes into it. */
export function waitsForKeyChange(area: FamilyArea | null, folder: Pick<DriveNode, 'keyEpoch'>) {
    return Boolean(area?.rotation && folder.keyEpoch < area.rotation.targetEpoch);
}

export { FINISHING_KEY_CHANGE } from '@/lib/drive';
