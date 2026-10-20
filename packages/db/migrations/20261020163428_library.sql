CREATE TABLE "asset" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"station_id" uuid NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"artists" text[] DEFAULT '{}'::text[] NOT NULL,
	"album" text,
	"year" integer,
	"isrc" text,
	"version" text,
	"duration_ms" integer,
	"explicit" boolean DEFAULT false NOT NULL,
	"start_at" timestamp with time zone,
	"kill_at" timestamp with time zone,
	"notes" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_filename" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "asset_id_org_station_key" UNIQUE("id","org_id","station_id"),
	CONSTRAINT "asset_type_check" CHECK ("asset"."type" in ('song', 'vt', 'jingle', 'bed', 'episode', 'other')),
	CONSTRAINT "asset_kill_after_start_check" CHECK ("asset"."kill_at" > "asset"."start_at"),
	CONSTRAINT "asset_duration_check" CHECK ("asset"."duration_ms" >= 0)
);
--> statement-breakpoint
CREATE TABLE "asset_analysis" (
	"asset_id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"station_id" uuid NOT NULL,
	"bpm" real,
	"musical_key" text,
	"energy" real,
	"confidence" real,
	"analyzer" text NOT NULL,
	"analyzer_version" text NOT NULL,
	"features" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"analyzed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "asset_analysis_confidence_check" CHECK ("asset_analysis"."confidence" between 0 and 1),
	CONSTRAINT "asset_analysis_energy_check" CHECK ("asset_analysis"."energy" between 0 and 1)
);
--> statement-breakpoint
CREATE TABLE "asset_cues" (
	"asset_id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"station_id" uuid NOT NULL,
	"sample_rate" integer NOT NULL,
	"analyzer_version" text,
	"cue_in" bigint,
	"cue_in_source" text DEFAULT 'auto' NOT NULL,
	"cue_in_locked" boolean DEFAULT false NOT NULL,
	"cue_out" bigint,
	"cue_out_source" text DEFAULT 'auto' NOT NULL,
	"cue_out_locked" boolean DEFAULT false NOT NULL,
	"intro_end" bigint,
	"intro_end_source" text DEFAULT 'auto' NOT NULL,
	"intro_end_locked" boolean DEFAULT false NOT NULL,
	"outro_start" bigint,
	"outro_start_source" text DEFAULT 'auto' NOT NULL,
	"outro_start_locked" boolean DEFAULT false NOT NULL,
	"fade_in" bigint,
	"fade_in_source" text DEFAULT 'auto' NOT NULL,
	"fade_in_locked" boolean DEFAULT false NOT NULL,
	"fade_out" bigint,
	"fade_out_source" text DEFAULT 'auto' NOT NULL,
	"fade_out_locked" boolean DEFAULT false NOT NULL,
	"cross_start_next" bigint,
	"cross_start_next_source" text DEFAULT 'auto' NOT NULL,
	"cross_start_next_locked" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "asset_cues_sample_rate_check" CHECK ("asset_cues"."sample_rate" > 0),
	CONSTRAINT "asset_cues_non_negative_check" CHECK ("asset_cues"."cue_in" >= 0 and "asset_cues"."cue_out" >= 0 and "asset_cues"."intro_end" >= 0 and "asset_cues"."outro_start" >= 0
        and "asset_cues"."fade_in" >= 0 and "asset_cues"."fade_out" >= 0 and "asset_cues"."cross_start_next" >= 0),
	CONSTRAINT "asset_cues_in_before_out_check" CHECK ("asset_cues"."cue_out" > "asset_cues"."cue_in"),
	CONSTRAINT "asset_cues_source_check" CHECK ("asset_cues"."cue_in_source" in ('auto', 'manual') and "asset_cues"."cue_out_source" in ('auto', 'manual')
        and "asset_cues"."intro_end_source" in ('auto', 'manual') and "asset_cues"."outro_start_source" in ('auto', 'manual')
        and "asset_cues"."fade_in_source" in ('auto', 'manual') and "asset_cues"."fade_out_source" in ('auto', 'manual')
        and "asset_cues"."cross_start_next_source" in ('auto', 'manual'))
);
--> statement-breakpoint
CREATE TABLE "asset_file" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"asset_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"station_id" uuid NOT NULL,
	"role" text NOT NULL,
	"storage_key" text NOT NULL,
	"sha256" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"codec" text NOT NULL,
	"mime_type" text,
	"sample_rate" integer,
	"channels" integer,
	"bit_depth" integer,
	"duration_samples" bigint,
	"flac_block_size" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "asset_file_asset_role_key" UNIQUE("asset_id","role"),
	CONSTRAINT "asset_file_role_check" CHECK ("asset_file"."role" in ('master', 'playout', 'peaks')),
	CONSTRAINT "asset_file_size_check" CHECK ("asset_file"."size_bytes" >= 0),
	CONSTRAINT "asset_file_playout_flac_check" CHECK ("asset_file"."role" <> 'playout' or ("asset_file"."codec" = 'flac' and "asset_file"."flac_block_size" is not null and "asset_file"."sample_rate" is not null))
);
--> statement-breakpoint
CREATE TABLE "asset_loudness" (
	"asset_id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"station_id" uuid NOT NULL,
	"integrated_lufs" real NOT NULL,
	"loudness_range_lu" real,
	"true_peak_dbtp" real,
	"analyzer" text NOT NULL,
	"analyzer_version" text NOT NULL,
	"confidence" real,
	"measured_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "asset_loudness_confidence_check" CHECK ("asset_loudness"."confidence" between 0 and 1)
);
--> statement-breakpoint
CREATE TABLE "asset_tag" (
	"asset_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"station_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "asset_tag_pkey" PRIMARY KEY("asset_id","tag_id")
);
--> statement-breakpoint
CREATE TABLE "tag" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"station_id" uuid NOT NULL,
	"key" text NOT NULL,
	"value" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tag_id_org_station_key" UNIQUE("id","org_id","station_id")
);
--> statement-breakpoint
CREATE TABLE "org_storage_usage" (
	"org_id" uuid PRIMARY KEY NOT NULL,
	"used_bytes" bigint DEFAULT 0 NOT NULL,
	"limit_bytes" bigint,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_storage_usage_used_check" CHECK ("org_storage_usage"."used_bytes" >= 0)
);
--> statement-breakpoint
CREATE TABLE "storage_object" (
	"org_id" uuid NOT NULL,
	"key" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"ref_count" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "storage_object_pkey" PRIMARY KEY("org_id","key"),
	CONSTRAINT "storage_object_size_check" CHECK ("storage_object"."size_bytes" >= 0),
	CONSTRAINT "storage_object_ref_count_check" CHECK ("storage_object"."ref_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "asset" ADD CONSTRAINT "asset_station_org_fk" FOREIGN KEY ("station_id","org_id") REFERENCES "public"."station"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_analysis" ADD CONSTRAINT "asset_analysis_asset_fk" FOREIGN KEY ("asset_id","org_id","station_id") REFERENCES "public"."asset"("id","org_id","station_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_cues" ADD CONSTRAINT "asset_cues_asset_fk" FOREIGN KEY ("asset_id","org_id","station_id") REFERENCES "public"."asset"("id","org_id","station_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_file" ADD CONSTRAINT "asset_file_asset_fk" FOREIGN KEY ("asset_id","org_id","station_id") REFERENCES "public"."asset"("id","org_id","station_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_loudness" ADD CONSTRAINT "asset_loudness_asset_fk" FOREIGN KEY ("asset_id","org_id","station_id") REFERENCES "public"."asset"("id","org_id","station_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_tag" ADD CONSTRAINT "asset_tag_asset_fk" FOREIGN KEY ("asset_id","org_id","station_id") REFERENCES "public"."asset"("id","org_id","station_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_tag" ADD CONSTRAINT "asset_tag_tag_fk" FOREIGN KEY ("tag_id","org_id","station_id") REFERENCES "public"."tag"("id","org_id","station_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tag" ADD CONSTRAINT "tag_station_org_fk" FOREIGN KEY ("station_id","org_id") REFERENCES "public"."station"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_storage_usage" ADD CONSTRAINT "org_storage_usage_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_object" ADD CONSTRAINT "storage_object_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "asset_station_id_idx" ON "asset" USING btree ("station_id","id");--> statement-breakpoint
CREATE INDEX "asset_station_type_idx" ON "asset" USING btree ("station_id","type");--> statement-breakpoint
CREATE INDEX "asset_isrc_idx" ON "asset" USING btree ("isrc");--> statement-breakpoint
CREATE INDEX "asset_analysis_station_id_idx" ON "asset_analysis" USING btree ("station_id");--> statement-breakpoint
CREATE INDEX "asset_cues_station_id_idx" ON "asset_cues" USING btree ("station_id");--> statement-breakpoint
CREATE INDEX "asset_file_station_id_idx" ON "asset_file" USING btree ("station_id");--> statement-breakpoint
CREATE INDEX "asset_file_org_sha256_idx" ON "asset_file" USING btree ("org_id","sha256");--> statement-breakpoint
CREATE INDEX "asset_file_org_key_idx" ON "asset_file" USING btree ("org_id","storage_key");--> statement-breakpoint
CREATE INDEX "asset_loudness_station_id_idx" ON "asset_loudness" USING btree ("station_id");--> statement-breakpoint
CREATE INDEX "asset_tag_tag_id_idx" ON "asset_tag" USING btree ("tag_id");--> statement-breakpoint
CREATE INDEX "asset_tag_station_id_idx" ON "asset_tag" USING btree ("station_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tag_station_key_value_key" ON "tag" USING btree ("station_id","key",lower("value"));