-- Takes back 20261112151421_two_step: the two-step tables, "sessions"."two_step_at",
-- "account_devices"."two_step_failures" and the 'two-step' purpose of a bound password proof.
-- Run it as the role that migrates (psql -f undo.sql); it is one transaction, so it applies whole or
-- not at all. Run it after 20261112151423_two_step_session_guard's undo.sql: it stops, changing nothing, while the
-- guard is still on "sessions", since the guard reads a table this drops and every sign-in would
-- fail without it.
--
-- It deletes every account's factors, backup codes and security log, which turns the second step
-- off for everyone who had it. Nothing here can bring them back; take a backup first
-- (docs/self-hosting.md, "Two-step sign-in"). Not run by drizzle-kit:
-- packages/db/src/two-step.migration.test.ts runs it and checks the schema is back to before.
BEGIN;
SET LOCAL lock_timeout = '5s';
DO $undo$
BEGIN
	IF EXISTS (
		SELECT 1 FROM pg_trigger
		WHERE tgname = 'sessions_two_step_guard' AND tgrelid = 'public.sessions'::regclass
	) THEN
		RAISE EXCEPTION 'HushOS: the two-step guard is still on "sessions".'
			USING HINT = 'Run 20261112151423_two_step_session_guard/undo.sql first.';
	END IF;
END
$undo$;
-- A proof started for a two-step change has nowhere to go, and the older check refuses its row.
DELETE FROM "opaque_login_attempts" WHERE "purpose" = 'two-step';
ALTER TABLE "opaque_login_attempts" DROP CONSTRAINT "opaque_login_attempts_purpose_binding", ADD CONSTRAINT "opaque_login_attempts_purpose_binding" CHECK (("purpose" = 'login' and "session_token_hash" is null) or ("purpose" in ('delete', 'password', 'master-key', 'recovery-key', 'devices') and "session_token_hash" is not null and octet_length("session_token_hash") = 32));
ALTER TABLE "sessions" DROP COLUMN "two_step_at";
ALTER TABLE "account_devices" DROP COLUMN "two_step_failures";
DROP TABLE "account_security_events";
DROP TABLE "two_step_attempts";
DROP TABLE "two_step_backup_codes";
DROP TABLE "two_step_factors";
DROP TABLE "two_step_state";
DELETE FROM "drizzle"."__drizzle_migrations" WHERE "name" = '20261112151421_two_step';
COMMIT;
