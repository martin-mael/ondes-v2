CREATE TABLE "asrun_entry" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"station_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"boot_id" text NOT NULL,
	"seq" integer NOT NULL,
	"rid" text,
	"source" text NOT NULL,
	"log_item_id" uuid,
	"segment_id" uuid,
	"kind" text,
	"asset_id" uuid,
	"file_sha256" text,
	"title" text,
	"artist" text,
	"artists" text[] DEFAULT '{}'::text[] NOT NULL,
	"live_session_id" uuid,
	"started_at" timestamp (3) with time zone NOT NULL,
	"ended_at" timestamp (3) with time zone,
	"end_seq" integer,
	"duration_ms" integer,
	"outcome" text,
	"planned_start" timestamp (3) with time zone,
	"planned_duration_ms" integer,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "asrun_entry_event_key" UNIQUE("event_id"),
	CONSTRAINT "asrun_entry_station_boot_seq_key" UNIQUE("station_id","boot_id","seq"),
	CONSTRAINT "asrun_entry_source_check" CHECK ("asrun_entry"."source" in ('log', 'safety', 'emergency', 'live', 'unknown')),
	CONSTRAINT "asrun_entry_end_check" CHECK (("asrun_entry"."ended_at" is null) = ("asrun_entry"."outcome" is null)
        and ("asrun_entry"."ended_at" is null or "asrun_entry"."ended_at" >= "asrun_entry"."started_at")
        and ("asrun_entry"."outcome" is null or "asrun_entry"."outcome" in ('complete', 'cut', 'skipped', 'interrupted'))
        and ("asrun_entry"."duration_ms" is null or "asrun_entry"."duration_ms" >= 0)),
	CONSTRAINT "asrun_entry_seq_check" CHECK ("asrun_entry"."seq" > 0)
);
--> statement-breakpoint
ALTER TABLE "asrun_entry" ADD CONSTRAINT "asrun_entry_station_org_fk" FOREIGN KEY ("station_id","org_id") REFERENCES "public"."station"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "asrun_entry_station_started_idx" ON "asrun_entry" USING btree ("station_id","started_at");--> statement-breakpoint
CREATE INDEX "asrun_entry_station_asset_idx" ON "asrun_entry" USING btree ("station_id","asset_id","started_at");--> statement-breakpoint
CREATE INDEX "asrun_entry_artists_idx" ON "asrun_entry" USING gin ("artists");--> statement-breakpoint
CREATE INDEX "asrun_entry_log_item_idx" ON "asrun_entry" USING btree ("log_item_id");--> statement-breakpoint
CREATE INDEX "asrun_entry_open_idx" ON "asrun_entry" USING btree ("station_id","boot_id") WHERE "asrun_entry"."ended_at" is null;