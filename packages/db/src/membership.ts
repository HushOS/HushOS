import { and, eq, or, sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { db } from './client';
import type { Tx } from './drive';
import { groupMemberships, workspaceKeys, workspaces } from './schema';

/*
 * Who counts as a member of a workspace, in one place (docs/groups-server.md
 * 3). A member holds the workspace's key (a `workspace_keys` row) and may use
 * it: the workspace is their own, or it is an area of a group they are an
 * active member of. A key the server still holds for someone who left opens
 * nothing through it. isMember and Drive's authorization walk both ask this.
 */
export async function holdsWorkspace(tx: Tx | typeof db, userId: string, workspaceId: string) {
    const [row] = await tx
        .select({ userId: workspaceKeys.userId })
        .from(workspaceKeys)
        .innerJoin(workspaces, eq(workspaces.id, workspaceKeys.workspaceId))
        .leftJoin(
            groupMemberships,
            and(
                eq(groupMemberships.groupId, workspaces.groupId),
                eq(groupMemberships.userId, workspaceKeys.userId),
            ),
        )
        .where(
            and(
                eq(workspaceKeys.workspaceId, workspaceId),
                eq(workspaceKeys.userId, userId),
                or(eq(workspaces.ownerKind, 'personal'), eq(groupMemberships.state, 'active')),
            ),
        );
    return row !== undefined;
}

/*
 * Whether a share or link's granter still stands behind it: always in a
 * personal workspace (only its owner grants there), and in a group area only
 * while the granter is an active member of the group. A rotation re-seals only
 * what this holds for, so a departed member's grants that escaped revocation
 * die with the next rotation instead of following it.
 */
export function grantedByMember(granter: AnyPgColumn, workspaceId: AnyPgColumn): SQL {
    return sql`exists (select 1 from ${workspaces} gw left join ${groupMemberships} gm on gm.group_id = gw.group_id and gm.user_id = ${granter} where gw.id = ${workspaceId} and (gw.owner_kind = 'personal' or gm.state = 'active'))`;
}
