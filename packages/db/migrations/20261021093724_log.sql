CREATE TABLE "log_day" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"station_id" uuid NOT NULL,
	"local_date" date NOT NULL,
	"starts_at" timestamp (3) with time zone NOT NULL,
	"ends_at" timestamp (3) with time zone NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"generated_at" timestamp with time zone,
	"seed" text,
	"generator_version" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "log_day_station_date_key" UNIQUE("station_id","local_date"),
	CONSTRAINT "log_day_id_org_station_key" UNIQUE("id","org_id","station_id"),
	CONSTRAINT "log_day_status_check" CHECK ("log_day"."status" in ('draft', 'published')),
	CONSTRAINT "log_day_range_check" CHECK ("log_day"."ends_at" > "log_day"."starts_at"),
	CONSTRAINT "log_day_version_check" CHECK ("log_day"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "log_item" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"station_id" uuid NOT NULL,
	"log_day_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"kind" text NOT NULL,
	"planned_start" timestamp (3) with time zone NOT NULL,
	"planned_duration_ms" integer NOT NULL,
	"asset_id" uuid,
	"episode_id" uuid,
	"live_slot_id" uuid,
	"title" text,
	"cue_overrides" jsonb,
	"timing" text DEFAULT 'flow' NOT NULL,
	"anchor_at" timestamp (3) with time zone,
	"cap_ms" integer,
	"origin_type" text NOT NULL,
	"origin_clock_id" uuid,
	"origin_slot_index" integer,
	"origin_show_slot_id" uuid,
	"locked" boolean DEFAULT false NOT NULL,
	"relaxed_rules" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"segment_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "log_item_day_position_key" UNIQUE("log_day_id","position"),
	CONSTRAINT "log_item_kind_check" CHECK ("log_item"."kind" in ('song', 'vt', 'jingle', 'bed', 'episode', 'live_slot', 'marker', 'fill', 'segment')),
	CONSTRAINT "log_item_duration_check" CHECK ("log_item"."planned_duration_ms" >= 0),
	CONSTRAINT "log_item_marker_duration_check" CHECK ("log_item"."kind" <> 'marker' or "log_item"."planned_duration_ms" = 0),
	CONSTRAINT "log_item_timing_check" CHECK ("log_item"."timing" in ('flow', 'hard', 'soft', 'not_before')
        and ("log_item"."timing" = 'flow') = ("log_item"."anchor_at" is null)
        and ("log_item"."cap_ms" is null or ("log_item"."timing" = 'soft' and "log_item"."cap_ms" >= 0))),
	CONSTRAINT "log_item_origin_check" CHECK ("log_item"."origin_type" in ('clock', 'show', 'manual')),
	CONSTRAINT "log_item_segment_part_check" CHECK ("log_item"."segment_id" is null or "log_item"."kind" <> 'segment')
);
--> statement-breakpoint
ALTER TABLE "log_day" ADD CONSTRAINT "log_day_station_org_fk" FOREIGN KEY ("station_id","org_id") REFERENCES "public"."station"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "log_item" ADD CONSTRAINT "log_item_asset_id_asset_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."asset"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "log_item" ADD CONSTRAINT "log_item_segment_id_log_item_id_fk" FOREIGN KEY ("segment_id") REFERENCES "public"."log_item"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "log_item" ADD CONSTRAINT "log_item_day_fk" FOREIGN KEY ("log_day_id","org_id","station_id") REFERENCES "public"."log_day"("id","org_id","station_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "log_day_station_range_idx" ON "log_day" USING btree ("station_id","starts_at");--> statement-breakpoint
CREATE INDEX "log_item_station_start_idx" ON "log_item" USING btree ("station_id","planned_start");--> statement-breakpoint
CREATE INDEX "log_item_segment_idx" ON "log_item" USING btree ("segment_id");--> statement-breakpoint
CREATE INDEX "log_item_asset_idx" ON "log_item" USING btree ("asset_id");