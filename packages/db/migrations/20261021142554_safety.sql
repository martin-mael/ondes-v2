CREATE TABLE "station_emergency_asset" (
	"station_id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "station_fallback_file" (
	"org_id" uuid NOT NULL,
	"station_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"sha256" text NOT NULL,
	"state" text NOT NULL,
	"error" text,
	"error_message" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "station_fallback_file_pkey" PRIMARY KEY("station_id","kind","sha256"),
	CONSTRAINT "station_fallback_file_kind_check" CHECK ("station_fallback_file"."kind" in ('safety', 'emergency')),
	CONSTRAINT "station_fallback_file_state_check" CHECK ("station_fallback_file"."state" in ('ready', 'failed') and ("station_fallback_file"."state" = 'failed') = ("station_fallback_file"."error" is not null))
);
--> statement-breakpoint
CREATE TABLE "station_fallback_state" (
	"station_id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"synced_at" timestamp with time zone,
	"on_air_source" text,
	"on_air_since" timestamp with time zone,
	"on_air_event_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "station_fallback_state_source_check" CHECK ("station_fallback_state"."on_air_source" is null or "station_fallback_state"."on_air_source" in ('live', 'queue', 'safety', 'emergency', 'unknown'))
);
--> statement-breakpoint
CREATE TABLE "station_safety_asset" (
	"org_id" uuid NOT NULL,
	"station_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "station_safety_asset_pkey" PRIMARY KEY("station_id","asset_id")
);
--> statement-breakpoint
ALTER TABLE "station_emergency_asset" ADD CONSTRAINT "station_emergency_asset_asset_fk" FOREIGN KEY ("asset_id","org_id","station_id") REFERENCES "public"."asset"("id","org_id","station_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "station_fallback_file" ADD CONSTRAINT "station_fallback_file_station_org_fk" FOREIGN KEY ("station_id","org_id") REFERENCES "public"."station"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "station_fallback_state" ADD CONSTRAINT "station_fallback_state_station_org_fk" FOREIGN KEY ("station_id","org_id") REFERENCES "public"."station"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "station_safety_asset" ADD CONSTRAINT "station_safety_asset_asset_fk" FOREIGN KEY ("asset_id","org_id","station_id") REFERENCES "public"."asset"("id","org_id","station_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "station_emergency_asset_asset_idx" ON "station_emergency_asset" USING btree ("asset_id");--> statement-breakpoint
CREATE INDEX "station_safety_asset_asset_idx" ON "station_safety_asset" USING btree ("asset_id");