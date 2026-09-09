import { defineRelations } from 'drizzle-orm';
import * as auth from './auth';
import * as storage from './storage';
import { workspaces } from './workspaces';
import { workspaceKeys } from './workspace-keys';

const schema = { ...auth, ...storage, workspaces, workspaceKeys };

export const relations = defineRelations(schema, (r) => ({
    workspaces: {
        personalOwner: r.one.personalWorkspaces({
            from: r.workspaces.id,
            to: r.personalWorkspaces.workspaceId,
        }),
        storage: r.one.workspaceStorage({
            from: r.workspaces.id,
            to: r.workspaceStorage.workspaceId,
        }),
        entitlements: r.many.storageEntitlements({
            from: r.workspaces.id,
            to: r.storageEntitlements.workspaceId,
        }),
        keys: r.many.workspaceKeys({ from: r.workspaces.id, to: r.workspaceKeys.workspaceId }),
    },
    workspaceKeys: {
        workspace: r.one.workspaces({
            from: r.workspaceKeys.workspaceId,
            to: r.workspaces.id,
            optional: false,
        }),
        user: r.one.users({ from: r.workspaceKeys.userId, to: r.users.id, optional: false }),
    },
    personalWorkspaces: {
        user: r.one.users({ from: r.personalWorkspaces.userId, to: r.users.id, optional: false }),
        workspace: r.one.workspaces({
            from: r.personalWorkspaces.workspaceId,
            to: r.workspaces.id,
            optional: false,
        }),
    },
    workspaceStorage: {
        workspace: r.one.workspaces({
            from: r.workspaceStorage.workspaceId,
            to: r.workspaces.id,
            optional: false,
        }),
    },
    storageEntitlements: {
        workspace: r.one.workspaces({
            from: r.storageEntitlements.workspaceId,
            to: r.workspaces.id,
            optional: false,
        }),
    },
    accountRecoveryKeys: {
        user: r.one.users({ from: r.accountRecoveryKeys.userId, to: r.users.id, optional: false }),
    },
    accountIdentities: {
        user: r.one.users({ from: r.accountIdentities.userId, to: r.users.id, optional: false }),
    },
    accountRecoveryAttempts: {
        user: r.one.users({
            from: r.accountRecoveryAttempts.userId,
            to: r.users.id,
            optional: false,
        }),
        enrollment: r.one.accountEnrollments({
            from: r.accountRecoveryAttempts.enrollmentId,
            to: r.accountEnrollments.id,
            optional: false,
        }),
    },
    users: {
        personalWorkspace: r.one.personalWorkspaces({
            from: r.users.id,
            to: r.personalWorkspaces.userId,
        }),
        recoveryKey: r.one.accountRecoveryKeys({
            from: r.users.id,
            to: r.accountRecoveryKeys.userId,
        }),
        identity: r.one.accountIdentities({ from: r.users.id, to: r.accountIdentities.userId }),
        workspaceKeys: r.many.workspaceKeys({ from: r.users.id, to: r.workspaceKeys.userId }),
        credential: r.one.opaqueCredentials({ from: r.users.id, to: r.opaqueCredentials.userId }),
        accountKey: r.one.accountKeys({ from: r.users.id, to: r.accountKeys.userId }),
        sessions: r.many.sessions({ from: r.users.id, to: r.sessions.userId }),
        loginAttempts: r.many.opaqueLoginAttempts({
            from: r.users.id,
            to: r.opaqueLoginAttempts.userId,
        }),
    },
    opaqueCredentials: {
        user: r.one.users({ from: r.opaqueCredentials.userId, to: r.users.id, optional: false }),
    },
    accountKeys: {
        user: r.one.users({ from: r.accountKeys.userId, to: r.users.id, optional: false }),
    },
    sessions: {
        user: r.one.users({ from: r.sessions.userId, to: r.users.id, optional: false }),
    },
    opaqueLoginAttempts: {
        user: r.one.users({ from: r.opaqueLoginAttempts.userId, to: r.users.id }),
    },
}));
