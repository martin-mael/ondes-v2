CREATE TABLE "alert" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"station_id" uuid NOT NULL,
	"type" text NOT NULL,
	"severity" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"title" text NOT NULL,
	"message" text,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurrences" integer DEFAULT 1 NOT NULL,
	"raised_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"escalated_at" timestamp with time zone,
	"escalate_at" timestamp with time zone,
	"escalate_to" text,
	"acknowledged_at" timestamp with time zone,
	"acknowledged_by" uuid,
	"resolved_at" timestamp with time zone,
	"resolution" text,
	CONSTRAINT "alert_severity_check" CHECK ("alert"."severity" in ('info', 'warning', 'critical')),
	CONSTRAINT "alert_escalate_to_check" CHECK ("alert"."escalate_to" is null or "alert"."escalate_to" in ('info', 'warning', 'critical')),
	CONSTRAINT "alert_occurrences_check" CHECK ("alert"."occurrences" >= 1)
);
--> statement-breakpoint
CREATE TABLE "silence_setting" (
	"station_id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"max_seconds" real NOT NULL,
	"threshold_db" real NOT NULL,
	"action" text NOT NULL,
	"escalate_after_seconds" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "silence_setting_action_check" CHECK ("silence_setting"."action" in ('skip', 'safety', 'none'))
);
--> statement-breakpoint
ALTER TABLE "alert" ADD CONSTRAINT "alert_acknowledged_by_user_id_fk" FOREIGN KEY ("acknowledged_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert" ADD CONSTRAINT "alert_station_org_fk" FOREIGN KEY ("station_id","org_id") REFERENCES "public"."station"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "silence_setting" ADD CONSTRAINT "silence_setting_station_org_fk" FOREIGN KEY ("station_id","org_id") REFERENCES "public"."station"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "alert_station_dedupe_open_key" ON "alert" USING btree ("station_id","dedupe_key") WHERE "alert"."resolved_at" is null;--> statement-breakpoint
CREATE INDEX "alert_station_id_idx" ON "alert" USING btree ("station_id","id");--> statement-breakpoint
CREATE INDEX "alert_escalate_at_idx" ON "alert" USING btree ("escalate_at") WHERE "alert"."resolved_at" is null and "alert"."escalate_at" is not null;