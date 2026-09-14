CREATE TABLE "server_secrets" (
	"name" text PRIMARY KEY,
	"value" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
