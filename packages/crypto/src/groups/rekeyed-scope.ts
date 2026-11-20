/*
 * Where re-keyed records are written, checked and read (docs/integrity-design.md,
 * "Re-keyed records"): the one switch both the server and the web follow.
 *
 * Group areas only, for now. Shipped iOS and Android apps rotate personal
 * workspaces in the legacy form and would stall on a row that carries an
 * origin (decision D9), so a personal rotation keeps writing exactly what it
 * wrote before: the legacy statement, no origin. Group areas sit behind
 * GROUPS_ENABLED and native has no family folders. The native PR that reads
 * and writes origins widens this to personal workspaces, and only this.
 */
export type WorkspaceOwner = 'personal' | 'group';
export function rekeyedFor(workspace: { ownerKind: WorkspaceOwner }): boolean {
    return workspace.ownerKind === 'group';
}
