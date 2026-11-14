-- Takes back 20261114015359_two_step_device: "two_step_device_requests", the kind 'device' of a
-- second-step method, of a security log line's method and of an account's default, and the three
-- notification kinds. Run it as the role that migrates, and stop at the first error:
--     psql -v ON_ERROR_STOP=1 -f undo.sql
-- It is one transaction, so it applies whole or not at all. Run it before the undo scripts of the
-- earlier two-step migrations if those are being taken back too.
--
-- What it deletes: every account's "Approve on another device" method, every request to approve,
-- the notification events of the three kinds, and the method named on security log lines that
-- name 'device' (the lines stay, without it). An account whose default was 'device' is offered
-- another kind it has first.
--
-- An account whose ONLY method was another device has no method left afterwards: its step is off,
-- and its backup codes are deleted with it, as when the last method is removed in the app. So
-- while any such account exists this stops, changing nothing, until the session says it is meant:
--     PGOPTIONS="-c hushos.delete_two_step=yes" psql -v ON_ERROR_STOP=1 -f undo.sql
-- or, where a pooler refuses startup options, in the same session:
--     psql -v ON_ERROR_STOP=1 -c "set hushos.delete_two_step = 'yes'" -f undo.sql
-- Tell those people first (docs/self-hosting.md, "Approve on another device"). Not run by
-- drizzle-kit: packages/db/src/two-step.migration.test.ts runs it and checks the schema is back
-- to before.
BEGIN;
SET LOCAL lock_timeout = '5s';
-- Locked before the deletes, so nothing of a new kind can be stored between them and the older
-- checks, which would refuse that row and fail the undo.
LOCK TABLE "notification_events", "two_step_factors", "account_security_events", "two_step_state" IN ACCESS EXCLUSIVE MODE;
DO $undo$
DECLARE
	only_device bigint;
BEGIN
	SELECT count(*) INTO only_device
	FROM public."two_step_factors" AS device
	WHERE device."kind" = 'device' AND device."confirmed_at" IS NOT NULL AND NOT EXISTS (
		SELECT 1 FROM public."two_step_factors" AS other
		WHERE other."user_id" = device."user_id" AND other."kind" <> 'device' AND other."confirmed_at" IS NOT NULL
	);
	IF only_device > 0 AND current_setting('hushos.delete_two_step', true) IS DISTINCT FROM 'yes' THEN
		RAISE EXCEPTION 'HushOS: % account(s) have another device as their only second step, and this turns their two-step sign-in off.', only_device
			USING HINT = 'Tell them, then run it again with PGOPTIONS="-c hushos.delete_two_step=yes" (docs/self-hosting.md, "Approve on another device").';
	END IF;
END
$undo$;
DELETE FROM "notification_events" WHERE "kind" IN ('two-step-device-added', 'two-step-device-removed', 'approval-request');
ALTER TABLE "notification_events" DROP CONSTRAINT "notification_events_kind_valid", ADD CONSTRAINT "notification_events_kind_valid" CHECK (kind in ('new-device', 'device-removed', 'devices-removed', 'password-attempts', 'two-step-on', 'two-step-off', 'two-step-app-added', 'two-step-app-removed', 'backup-codes-made', 'backup-code-used', 'phrase-used', 'phrase-replaced', 'password-reset', 'account-key-rotated', 'step-failed', 'change-step-failed', 'totp-frozen', 'two-step-key-added', 'two-step-key-removed', 'key-counter', 'shared', 'family-invitation', 'family-waiting'));
UPDATE "account_security_events" SET "method" = NULL WHERE "method" = 'device';
ALTER TABLE "account_security_events" DROP CONSTRAINT "account_security_events_method_valid", ADD CONSTRAINT "account_security_events_method_valid" CHECK ("method" is null or "method" in ('totp', 'webauthn', 'backup', 'phrase'));
DELETE FROM "two_step_factors" WHERE "kind" = 'device';
UPDATE "two_step_state" SET "default_kind" = NULL WHERE "default_kind" = 'device';
-- An account left with no confirmed method has the step off: what belonged to the step goes, as
-- the app does it when the last method is removed.
DELETE FROM "two_step_backup_codes" AS codes WHERE NOT EXISTS (SELECT 1 FROM "two_step_factors" AS factor WHERE factor."user_id" = codes."user_id" AND factor."confirmed_at" IS NOT NULL);
DELETE FROM "two_step_attempts" AS attempt WHERE NOT EXISTS (SELECT 1 FROM "two_step_factors" AS factor WHERE factor."user_id" = attempt."user_id" AND factor."confirmed_at" IS NOT NULL);
UPDATE "sessions" AS session SET "two_step_at" = NULL WHERE session."two_step_at" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "two_step_factors" AS factor WHERE factor."user_id" = session."user_id" AND factor."confirmed_at" IS NOT NULL);
ALTER TABLE "two_step_factors" DROP CONSTRAINT "two_step_factors_device_valid";
ALTER TABLE "two_step_factors" DROP CONSTRAINT "two_step_factors_kind_valid", ADD CONSTRAINT "two_step_factors_kind_valid" CHECK ("kind" in ('totp', 'webauthn'));
DROP INDEX "two_step_factors_one_device_idx";
DROP TABLE "two_step_device_requests";
DELETE FROM "drizzle"."__drizzle_migrations" WHERE "name" = '20261114015359_two_step_device';
COMMIT;
