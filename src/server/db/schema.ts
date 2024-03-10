import { relations } from 'drizzle-orm';
import {
    AnyPgColumn,
    boolean,
    integer,
    jsonb,
    pgTable,
    serial,
    text,
    timestamp,
    uniqueIndex,
    varchar,
} from 'drizzle-orm/pg-core';
import { z } from 'zod';

import { userKeysInput } from '@/server/api/schemas/auth';

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
            length: 255,
        }),
        opaqueRecord: varchar('opaque_record', {
            length: 512,
        }),
        userKeysId: integer('user_keys_id').references((): AnyPgColumn => userKeys.id),
    },
    table => {
        return {
            normalizedEmailIdx: uniqueIndex('normalized_email_idx').on(table.normalizedEmail),
        };
    }
);

export const usersRelations = relations(users, ({ many, one }) => ({
    emailVerificationCodes: many(emailVerificationCodes),
    sessions: many(sessions),
    userKeys: one(userKeys, {
        fields: [users.userKeysId],
        references: [userKeys.id],
    }),
}));

export const emailVerificationCodes = pgTable('email_verification_codes', {
    id: serial('id').primaryKey(),
    userId: varchar('user_id')
        .notNull()
        .references(() => users.id),
    code: varchar('code', {
        length: 8,
    }).notNull(),
    expiresAt: timestamp('expires_at', {
        withTimezone: true,
        mode: 'date',
    }).notNull(),
});

export const emailVerificationCodesRelations = relations(emailVerificationCodes, ({ one }) => ({
    users: one(users, {
        fields: [emailVerificationCodes.userId],
        references: [users.id],
    }),
}));

export const sessions = pgTable('sessions', {
    id: text('id').primaryKey(),
    userId: varchar('user_id')
        .notNull()
        .references(() => users.id),
    expiresAt: timestamp('expires_at', {
        withTimezone: true,
        mode: 'date',
    }).notNull(),
});

export const sessionsRelations = relations(sessions, ({ one }) => ({
    users: one(users, {
        fields: [sessions.userId],
        references: [users.id],
    }),
}));

export const userKeys = pgTable('user_keys', {
    id: serial('id').primaryKey(),
    userId: varchar('user_id')
        .notNull()
        .references(() => users.id),
    salt: varchar('salt').notNull(),
    mainKeyBundle: jsonb('main_key_bundle')
        .notNull()
        .$type<z.infer<typeof userKeysInput>['mainKeyBundle']>(),
    recoveryMainKeyBundle: jsonb('recovery_main_key_bundle')
        .notNull()
        .$type<z.infer<typeof userKeysInput>['recoveryMainKeyBundle']>(),
    recoveryKeyBundle: jsonb('recovery_key_bundle')
        .notNull()
        .$type<z.infer<typeof userKeysInput>['recoveryKeyBundle']>(),
    signingKeyBundle: jsonb('signing_key_bundle')
        .notNull()
        .$type<z.infer<typeof userKeysInput>['signingKeyBundle']>(),
    asymmetricKeyBundle: jsonb('asymmetric_key_bundle')
        .notNull()
        .$type<z.infer<typeof userKeysInput>['asymmetricKeyBundle']>(),
});

export const userKeysRelations = relations(userKeys, ({ one }) => ({
    users: one(users, {
        fields: [userKeys.userId],
        references: [users.id],
    }),
}));

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
