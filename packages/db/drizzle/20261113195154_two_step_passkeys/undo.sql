-- Takes back 20261113195154_two_step_passkeys: "two_step_key_registrations",
-- "two_step_state"."default_kind", and the three notices about keys among the kinds of a
-- notification event. Run it as the role that migrates, and stop at the first error:
--     psql -v ON_ERROR_STOP=1 -f undo.sql
-- It is one transaction, so it applies whole or not at all. Run it before the undo scripts of
-- 20261112174853_two_step_session_guard and 20261112160538_two_step if those are being taken back
-- too.
--
-- What it deletes: every account's choice of default, any key being added at that moment, and the
-- notification events of the three kinds (an older release cannot serve them). What it leaves: the
-- passkeys and security keys themselves, which are rows of "two_step_factors". A release from
-- before this migration does not offer them at sign-in, so an account whose only method is a key
-- signs in there with a backup code or its recovery phrase; the session guard still counts the
-- key, so the password alone never does (docs/self-hosting.md, "Passkeys and the default
-- method"). Not run by drizzle-kit: packages/db/src/two-step.migration.test.ts runs it and checks
-- the schema is back to before.
BEGIN;
SET LOCAL lock_timeout = '5s';
-- Locked before the delete, so no event of a new kind can be stored between it and the older
-- check, which would refuse that row and fail the undo.
LOCK TABLE "notification_events" IN ACCESS EXCLUSIVE MODE;
DELETE FROM "notification_events" WHERE "kind" IN ('two-step-key-added', 'two-step-key-removed', 'key-counter');
ALTER TABLE "notification_events" DROP CONSTRAINT "notification_events_kind_valid", ADD CONSTRAINT "notification_events_kind_valid" CHECK (kind in ('new-device', 'device-removed', 'devices-removed', 'password-attempts', 'two-step-on', 'two-step-off', 'two-step-app-added', 'two-step-app-removed', 'backup-codes-made', 'backup-code-used', 'phrase-used', 'phrase-replaced', 'password-reset', 'account-key-rotated', 'step-failed', 'change-step-failed', 'totp-frozen', 'shared', 'family-invitation', 'family-waiting'));
ALTER TABLE "two_step_state" DROP COLUMN "default_kind";
DROP TABLE "two_step_key_registrations";
DELETE FROM "drizzle"."__drizzle_migrations" WHERE "name" = '20261113195154_two_step_passkeys';
COMMIT;
