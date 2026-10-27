CREATE TABLE "live_recording" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"station_id" uuid NOT NULL,
	"episode_id" uuid,
	"show_id" uuid,
	"event_id" uuid,
	"session_id" uuid,
	"title" text,
	"status" text DEFAULT 'recording' NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"built_version" integer,
	"duration_ms" bigint,
	"upload_id" uuid,
	"asset_id" uuid,
	"error" text,
	"built_at" timestamp with time zone,
	"build_ms" integer,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "live_recording_owner_check" CHECK ("live_recording"."episode_id" is not null or "live_recording"."event_id" is not null or "live_recording"."session_id" is not null),
	CONSTRAINT "live_recording_status_check" CHECK ("live_recording"."status" in ('recording', 'pending', 'processing', 'ready', 'failed', 'expired', 'skipped')),
	CONSTRAINT "live_recording_version_check" CHECK ("live_recording"."version" >= 0)
);
--> statement-breakpoint
CREATE TABLE "live_recording_part" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"station_id" uuid NOT NULL,
	"file" text NOT NULL,
	"session_id" uuid NOT NULL,
	"recording_id" uuid,
	"boot_id" text NOT NULL,
	"status" text DEFAULT 'recording' NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "live_recording_part_file_key" UNIQUE("station_id","file"),
	CONSTRAINT "live_recording_part_status_check" CHECK ("live_recording_part"."status" in ('recording', 'closed', 'interrupted', 'deleted'))
);
--> statement-breakpoint
CREATE TABLE "live_recording_settings" (
	"station_id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"retention_days" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "live_recording_settings_retention_check" CHECK ("live_recording_settings"."retention_days" is null or "live_recording_settings"."retention_days" between 1 and 3650)
);
--> statement-breakpoint
ALTER TABLE "live_recording" ADD CONSTRAINT "live_recording_station_org_fk" FOREIGN KEY ("station_id","org_id") REFERENCES "public"."station"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "live_recording_part" ADD CONSTRAINT "live_recording_part_recording_id_live_recording_id_fk" FOREIGN KEY ("recording_id") REFERENCES "public"."live_recording"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "live_recording_part" ADD CONSTRAINT "live_recording_part_station_org_fk" FOREIGN KEY ("station_id","org_id") REFERENCES "public"."station"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "live_recording_settings" ADD CONSTRAINT "live_recording_settings_station_org_fk" FOREIGN KEY ("station_id","org_id") REFERENCES "public"."station"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "live_recording_episode_key" ON "live_recording" USING btree ("station_id","episode_id") WHERE "live_recording"."episode_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "live_recording_event_key" ON "live_recording" USING btree ("station_id","event_id") WHERE "live_recording"."episode_id" is null and "live_recording"."event_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "live_recording_session_key" ON "live_recording" USING btree ("station_id","session_id") WHERE "live_recording"."episode_id" is null and "live_recording"."event_id" is null;--> statement-breakpoint
CREATE INDEX "live_recording_status_ended_idx" ON "live_recording" USING btree ("status","ended_at");--> statement-breakpoint
CREATE INDEX "live_recording_part_recording_idx" ON "live_recording_part" USING btree ("recording_id","started_at");--> statement-breakpoint
CREATE INDEX "live_recording_part_session_idx" ON "live_recording_part" USING btree ("station_id","session_id");--> statement-breakpoint
CREATE INDEX "live_recording_part_status_idx" ON "live_recording_part" USING btree ("status","updated_at");