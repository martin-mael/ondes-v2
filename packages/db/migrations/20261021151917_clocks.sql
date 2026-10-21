CREATE TABLE "clock" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"station_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"color" text,
	"target_duration_ms" integer DEFAULT 3600000 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clock_id_org_station_key" UNIQUE("id","org_id","station_id"),
	CONSTRAINT "clock_target_check" CHECK ("clock"."target_duration_ms" between 60000 and 21600000),
	CONSTRAINT "clock_version_check" CHECK ("clock"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "clock_slot" (
	"clock_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"org_id" uuid NOT NULL,
	"station_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"label" text,
	"duration_ms" integer,
	"category_id" uuid,
	"asset_id" uuid,
	"vt_mode" text,
	"timing" text,
	"offset_ms" integer,
	"cap_ms" integer,
	CONSTRAINT "clock_slot_pkey" PRIMARY KEY("clock_id","position"),
	CONSTRAINT "clock_slot_kind_check" CHECK ("clock_slot"."kind" in ('category', 'asset', 'vt', 'jingle', 'marker', 'fill', 'live')),
	CONSTRAINT "clock_slot_position_check" CHECK ("clock_slot"."position" >= 0),
	CONSTRAINT "clock_slot_duration_check" CHECK ("clock_slot"."duration_ms" >= 0),
	CONSTRAINT "clock_slot_vt_check" CHECK (("clock_slot"."kind" = 'vt') = ("clock_slot"."vt_mode" is not null) and "clock_slot"."vt_mode" in ('promo', 'placeholder')),
	CONSTRAINT "clock_slot_marker_check" CHECK (("clock_slot"."kind" = 'marker') = ("clock_slot"."timing" is not null and "clock_slot"."offset_ms" is not null)
        and "clock_slot"."timing" in ('hard', 'soft', 'not_before') and "clock_slot"."offset_ms" >= 0 and "clock_slot"."cap_ms" >= 0)
);
--> statement-breakpoint
ALTER TABLE "clock" ADD CONSTRAINT "clock_station_org_fk" FOREIGN KEY ("station_id","org_id") REFERENCES "public"."station"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clock_slot" ADD CONSTRAINT "clock_slot_category_id_category_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."category"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clock_slot" ADD CONSTRAINT "clock_slot_asset_id_asset_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."asset"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clock_slot" ADD CONSTRAINT "clock_slot_clock_fk" FOREIGN KEY ("clock_id","org_id","station_id") REFERENCES "public"."clock"("id","org_id","station_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "clock_station_name_key" ON "clock" USING btree ("station_id",lower("name"));--> statement-breakpoint
CREATE INDEX "clock_slot_category_id_idx" ON "clock_slot" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "clock_slot_asset_id_idx" ON "clock_slot" USING btree ("asset_id");