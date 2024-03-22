import { relations } from 'drizzle-orm';
import {
    AnyPgColumn,
    bigint,
    boolean,
    integer,
    jsonb,
    pgEnum,
    pgTable,
    serial,
    text,
    timestamp,
    uniqueIndex,
    uuid,
    varchar,
} from 'drizzle-orm/pg-core';

import { UserKeys } from '@/schemas/auth';

export const waitlist = pgTable('waitlist', {
    id: serial('id').primaryKey(),
    email: varchar('email', {
        length: 255,
    })
        .notNull()
        .unique(),
    joinedAt: timestamp('joined_at', {
        withTimezone: true,
        mode: 'date',
    }).notNull(),
});

export const users = pgTable(
    'users',
    {
        id: varchar('id', {
            length: 255,
        }).primaryKey(),
        email: varchar('email', {
            length: 255,
        }).notNull(),
        normalizedEmail: varchar('normalized_email', {
            length: 255,
        }).notNull(),
        emailVerified: boolean('email_verified').default(false),
        agreedToTerms: boolean('agreed_to_terms').default(false),
        opaqueSecret: varchar('opaque_secret', {
            length: 512,
        }),
        opaqueRecord: varchar('opaque_record', {
            length: 512,
        }),

        workspaceId: uuid('workspace_id').references((): AnyPgColumn => workspaces.id),
        userKeysId: integer('user_keys_id').references((): AnyPgColumn => userKeys.id),
    },
    table => {
        return {
            normalizedEmailIdx: uniqueIndex('normalized_email_idx').on(table.normalizedEmail),
        };
    }
);

export const emailVerificationCodes = pgTable('email_verification_codes', {
    id: serial('id').primaryKey(),
    code: varchar('code', {
        length: 8,
    }).notNull(),
    expiresAt: timestamp('expires_at', {
        withTimezone: true,
        mode: 'date',
    }).notNull(),

    userId: varchar('user_id')
        .notNull()
        .references(() => users.id),
});

export const sessions = pgTable('sessions', {
    id: text('id').primaryKey(),
    expiresAt: timestamp('expires_at', {
        withTimezone: true,
        mode: 'date',
    }).notNull(),

    userId: varchar('user_id')
        .notNull()
        .references(() => users.id),
});

export const workspaces = pgTable('workspaces', {
    id: uuid('id').defaultRandom().primaryKey(),
    storageSize: bigint('bigint', { mode: 'number' }).default(2147483648),

    userId: varchar('user_id')
        .notNull()
        .references(() => users.id),
});

export const userKeys = pgTable('user_keys', {
    id: serial('id').primaryKey(),
    salt: varchar('salt').notNull(),
    mainKeyBundle: jsonb('main_key_bundle').notNull().$type<UserKeys['mainKeyBundle']>(),
    recoveryMainKeyBundle: jsonb('recovery_main_key_bundle')
        .notNull()
        .$type<UserKeys['recoveryMainKeyBundle']>(),
    recoveryKeyBundle: jsonb('recovery_key_bundle')
        .notNull()
        .$type<UserKeys['recoveryKeyBundle']>(),
    signingKeyBundle: jsonb('signing_key_bundle').notNull().$type<UserKeys['signingKeyBundle']>(),
    asymmetricKeyBundle: jsonb('asymmetric_key_bundle')
        .notNull()
        .$type<UserKeys['asymmetricKeyBundle']>(),

    userId: varchar('user_id')
        .notNull()
        .references(() => users.id),
});

export const directoryStatusEnum = pgEnum('directory_status', [
    'normal',
    'deleted',
    'permanently_deleted',
]);

export const directoryNodes = pgTable('directory_nodes', {
    id: uuid('id').defaultRandom().primaryKey(),
    materializedPath: text('materializedPath').notNull(),
    isShared: boolean('is_shared').default(false),
    directoryStatus: directoryStatusEnum('directory_status').default('normal'),
    keyBundle: jsonb('secret_key_bundle').notNull().$type<{
        nonce: string;
        encryptedKey: string;
    }>(),
    metadataBundle: jsonb('metadata_bundle').notNull().$type<{
        nonce: string;
        encryptedMetadata: string;
    }>(),

    workspaceId: uuid('workspace_id')
        .notNull()
        .references(() => workspaces.id),
    parentDirectoryId: uuid('parent_directory_id').references((): AnyPgColumn => directoryNodes.id),
});

export const fileStatusEnum = pgEnum('file_status', [
    'upload_started',
    'upload_failed',
    'upload_cancelled',
    'upload_finished',
    'deleted',
    'permanently_deleted',
    'size_mismatch',
    'malicious_upload',
    'old_version',
]);

export const fileNodes = pgTable('file_nodes', {
    id: uuid('id').defaultRandom().primaryKey(),
    materializedPath: text('materializedPath').notNull(),
    isShared: boolean('is_shared'),
    encryptedSize: bigint('encrypted_size', { mode: 'bigint' }).notNull(),
    fileStatus: fileStatusEnum('file_status').default('upload_started'),
    keyBundle: jsonb('secret_key_bundle').notNull().$type<{
        nonce: string;
        encryptedKey: string;
    }>(),
    metadataBundle: jsonb('metadata_bundle').notNull().$type<{
        nonce: string;
        encryptedMetadata: string;
    }>(),
    s3Config: jsonb('s3_config').notNull().$type<{
        region: string;
        bucketName: string;
        key: string;
        uploadId: string;
    }>(),

    workspaceId: uuid('workspace_id')
        .notNull()
        .references(() => workspaces.id),
    parentDirectoryId: uuid('parent_directory_id')
        .notNull()
        .references((): AnyPgColumn => directoryNodes.id),
    previousVersionId: uuid('previous_version_id').references((): AnyPgColumn => fileNodes.id),
});

export const usersRelations = relations(users, ({ many, one }) => ({
    emailVerificationCodes: many(emailVerificationCodes),
    sessions: many(sessions),
    workspace: one(workspaces, {
        fields: [users.id],
        references: [workspaces.userId],
    }),
    userKeys: one(userKeys, {
        fields: [users.userKeysId],
        references: [userKeys.id],
    }),
}));

export const emailVerificationCodesRelations = relations(emailVerificationCodes, ({ one }) => ({
    users: one(users, {
        fields: [emailVerificationCodes.userId],
        references: [users.id],
    }),
}));

export const sessionsRelations = relations(sessions, ({ one }) => ({
    users: one(users, {
        fields: [sessions.userId],
        references: [users.id],
    }),
}));

export const workspacesRelations = relations(workspaces, ({ one }) => ({
    users: one(users, {
        fields: [workspaces.userId],
        references: [users.id],
    }),
}));

export const userKeysRelations = relations(userKeys, ({ one }) => ({
    users: one(users, {
        fields: [userKeys.userId],
        references: [users.id],
    }),
}));

export const directoryNodesRelations = relations(directoryNodes, ({ many, one }) => ({
    workspace: one(workspaces, {
        fields: [directoryNodes.workspaceId],
        references: [workspaces.id],
    }),
    parentDirectory: one(directoryNodes, {
        fields: [directoryNodes.parentDirectoryId],
        references: [directoryNodes.id],
    }),
    folders: many(directoryNodes),
    files: many(fileNodes),
}));

export const fileNodesRelations = relations(fileNodes, ({ one }) => ({
    workspace: one(workspaces, {
        fields: [fileNodes.workspaceId],
        references: [workspaces.id],
    }),
    parentDirectory: one(directoryNodes, {
        fields: [fileNodes.parentDirectoryId],
        references: [directoryNodes.id],
    }),
    previousVersion: one(fileNodes, {
        fields: [fileNodes.previousVersionId],
        references: [fileNodes.id],
    }),
}));
