-- Two-step sign-in's notices also go to the account's devices (docs/two-step-design.md 7): the
-- kinds a notification event may have gain the thirteen notices the step sends by email. No
-- existing row changes.
-- Hand-edited: the comments and lock_timeout. Replacing a CHECK takes an exclusive lock on
-- "notification_events" and reads the table once to validate it (30 days of events at most).
-- lock_timeout bounds the wait for that lock, so a long transaction ahead cannot queue every
-- notification behind this migration: the migration fails and is retried instead.
-- An older release cannot serve an event of a new kind (its response schema refuses it), so
-- before rolling back past this migration delete those events (docs/self-hosting.md).
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "notification_events" DROP CONSTRAINT "notification_events_kind_valid", ADD CONSTRAINT "notification_events_kind_valid" CHECK (kind in ('new-device', 'device-removed', 'devices-removed', 'password-attempts', 'two-step-on', 'two-step-off', 'two-step-app-added', 'two-step-app-removed', 'backup-codes-made', 'backup-code-used', 'phrase-used', 'phrase-replaced', 'password-reset', 'account-key-rotated', 'step-failed', 'change-step-failed', 'totp-frozen', 'shared', 'family-invitation', 'family-waiting'));
