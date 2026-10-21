CREATE TABLE "playout_cache_file" (
	"org_id" uuid NOT NULL,
	"station_id" uuid NOT NULL,
	"sha256" text NOT NULL,
	"ext" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"state" text NOT NULL,
	"error" text,
	"error_message" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"fetched_at" timestamp with time zone,
	"last_needed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "playout_cache_file_pkey" PRIMARY KEY("station_id","sha256"),
	CONSTRAINT "playout_cache_file_state_check" CHECK ("playout_cache_file"."state" in ('ready', 'failed')),
	CONSTRAINT "playout_cache_file_error_check" CHECK (("playout_cache_file"."state" = 'failed') = ("playout_cache_file"."error" is not null)
        and ("playout_cache_file"."error" is null or "playout_cache_file"."error" in ('source_missing', 'checksum_mismatch', 'io'))),
	CONSTRAINT "playout_cache_file_size_check" CHECK ("playout_cache_file"."size_bytes" >= 0)
);
--> statement-breakpoint
CREATE TABLE "station_cache" (
	"station_id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"budget_bytes" bigint,
	"horizon_hours" integer,
	"bytes_per_sec" bigint,
	"used_bytes" bigint DEFAULT 0 NOT NULL,
	"horizon_bytes" bigint DEFAULT 0 NOT NULL,
	"deferred" text[] DEFAULT '{}'::text[] NOT NULL,
	"disk_low" boolean DEFAULT false NOT NULL,
	"last_pass_at" timestamp with time zone,
	"last_error_at" timestamp with time zone,
	"last_error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "station_cache_settings_check" CHECK (("station_cache"."budget_bytes" is null or "station_cache"."budget_bytes" > 0)
        and ("station_cache"."horizon_hours" is null or "station_cache"."horizon_hours" between 1 and 168)
        and ("station_cache"."bytes_per_sec" is null or "station_cache"."bytes_per_sec" > 0))
);
--> statement-breakpoint
ALTER TABLE "playout_cache_file" ADD CONSTRAINT "playout_cache_file_station_org_fk" FOREIGN KEY ("station_id","org_id") REFERENCES "public"."station"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "station_cache" ADD CONSTRAINT "station_cache_station_org_fk" FOREIGN KEY ("station_id","org_id") REFERENCES "public"."station"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "playout_cache_file_station_state_idx" ON "playout_cache_file" USING btree ("station_id","state");