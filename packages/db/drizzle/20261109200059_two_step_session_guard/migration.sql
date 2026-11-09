-- Custom SQL migration: Drizzle does not model triggers. This is the repository's first.
--
-- The second step is a server rule, enforced by code that knows it (docs/two-step-design.md 4). A
-- container of a release from before that code never sets "sessions"."two_step_at": during a
-- rolling update that skips releases, or after a rollback, it would hand an account that has
-- turned the step on its session and its password envelope for the password alone, silently. This
-- trigger makes that sign-in fail instead: no session is made for an account with a confirmed
-- factor unless the row says when the step was passed.
--
-- It covers sign-in only. An older container still skips the step at a password change, a key
-- rotation and account deletion, from a session that already exists (docs/two-step-design.md 10).
--
-- The function runs as the role that inserts the session, which reads "two_step_factors" like any
-- other application table. The lock timeout is repeated for when this runs on its own: CREATE
-- TRIGGER takes a SHARE ROW EXCLUSIVE lock on "sessions".
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE FUNCTION "sessions_two_step_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF NEW."two_step_at" IS NULL AND EXISTS (
		SELECT 1 FROM "two_step_factors"
		WHERE "user_id" = NEW."user_id" AND "confirmed_at" IS NOT NULL
	) THEN
		RAISE EXCEPTION 'two-step sign-in is on for this account: a session needs two_step_at'
			USING ERRCODE = 'check_violation', CONSTRAINT = 'sessions_two_step_guard', TABLE = 'sessions';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "sessions_two_step_guard" BEFORE INSERT ON "sessions"
	FOR EACH ROW EXECUTE FUNCTION "sessions_two_step_guard"();
