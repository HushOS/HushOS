ALTER TABLE "notification_registrations" ADD COLUMN "web_endpoint" text;--> statement-breakpoint
ALTER TABLE "notification_registrations" ADD COLUMN "web_p256dh" text;--> statement-breakpoint
ALTER TABLE "notification_registrations" ADD COLUMN "web_auth" text;--> statement-breakpoint
ALTER TABLE "notification_registrations" ALTER COLUMN "handle" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_registrations" ADD CONSTRAINT "notification_registrations_web_valid" CHECK ("web_endpoint" is null or ("web_endpoint" like 'https://%' and length("web_endpoint") <= 1024 and "web_p256dh" ~ '^[A-Za-z0-9_-]{87}$' and "web_auth" ~ '^[A-Za-z0-9_-]{22}$'));--> statement-breakpoint
ALTER TABLE "notification_registrations" ADD CONSTRAINT "notification_registrations_one_kind" CHECK (("handle" is not null) <> ("web_endpoint" is not null));--> statement-breakpoint
ALTER TABLE "notification_registrations" DROP CONSTRAINT "notification_registrations_handle_valid", ADD CONSTRAINT "notification_registrations_handle_valid" CHECK ("handle" is null or "handle" ~ '^[A-Za-z0-9_-]{43}$');