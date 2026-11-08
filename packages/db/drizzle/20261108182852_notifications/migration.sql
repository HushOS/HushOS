CREATE TABLE "notification_events" (
	"seq" bigserial PRIMARY KEY,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL UNIQUE,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"data" jsonb DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_events_kind_valid" CHECK (kind in ('new-device', 'device-removed', 'devices-removed', 'password-attempts', 'shared', 'family-invitation', 'family-waiting'))
);
--> statement-breakpoint
CREATE TABLE "notification_registrations" (
	"device_id" uuid PRIMARY KEY,
	"user_id" uuid NOT NULL,
	"handle" text NOT NULL,
	"list_seq" bigint DEFAULT 0 NOT NULL,
	"other_pinged_at" timestamp with time zone,
	"other_ping_open" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_registrations_handle_valid" CHECK ("handle" ~ '^[A-Za-z0-9_-]{43}$')
);
--> statement-breakpoint
CREATE TABLE "notification_settings" (
	"user_id" uuid PRIMARY KEY,
	"shared" boolean DEFAULT true NOT NULL,
	"family" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "notification_events_user_seq_idx" ON "notification_events" ("user_id","seq");--> statement-breakpoint
CREATE INDEX "notification_events_created_idx" ON "notification_events" ("created_at");--> statement-breakpoint
CREATE INDEX "notification_registrations_user_idx" ON "notification_registrations" ("user_id");--> statement-breakpoint
ALTER TABLE "notification_events" ADD CONSTRAINT "notification_events_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "notification_registrations" ADD CONSTRAINT "notification_registrations_device_id_account_devices_id_fkey" FOREIGN KEY ("device_id") REFERENCES "account_devices"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "notification_registrations" ADD CONSTRAINT "notification_registrations_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "notification_settings" ADD CONSTRAINT "notification_settings_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;