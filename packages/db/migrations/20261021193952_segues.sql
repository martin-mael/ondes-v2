CREATE TABLE "island" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"station_id" uuid NOT NULL,
	"head_item_id" uuid NOT NULL,
	"head_asset_id" uuid NOT NULL,
	"head_join_sample" integer NOT NULL,
	"head_has_body" boolean NOT NULL,
	"tail_item_id" uuid NOT NULL,
	"tail_asset_id" uuid NOT NULL,
	"tail_join_sample" integer NOT NULL,
	"tail_has_body" boolean NOT NULL,
	"item_ids" uuid[] NOT NULL,
	"segue_ids" uuid[] NOT NULL,
	"spec_version" integer NOT NULL,
	"spec" jsonb NOT NULL,
	"files" jsonb NOT NULL,
	"hash" text NOT NULL,
	"length_samples" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"storage_key" text,
	"error" text,
	"rendered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "island_head_item_key" UNIQUE("head_item_id"),
	CONSTRAINT "island_status_check" CHECK ("island"."status" in ('pending', 'rendering', 'ready', 'failed')),
	CONSTRAINT "island_ready_check" CHECK ("island"."status" <> 'ready' or "island"."storage_key" is not null),
	CONSTRAINT "island_length_check" CHECK ("island"."length_samples" > 0)
);
--> statement-breakpoint
CREATE TABLE "segue" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"station_id" uuid NOT NULL,
	"from_item_id" uuid,
	"to_item_id" uuid,
	"from_asset_id" uuid,
	"to_asset_id" uuid,
	"out_lane" jsonb NOT NULL,
	"in_lane" jsonb NOT NULL,
	"voices" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"origin" text DEFAULT 'manual' NOT NULL,
	"status" text DEFAULT 'waiting' NOT NULL,
	"problem_code" text,
	"problem_message" text,
	"island_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "segue_from_item_key" UNIQUE("from_item_id"),
	CONSTRAINT "segue_to_item_key" UNIQUE("to_item_id"),
	CONSTRAINT "segue_status_check" CHECK ("segue"."status" in ('ready', 'waiting', 'detached', 'invalid')),
	CONSTRAINT "segue_origin_check" CHECK ("segue"."origin" in ('manual', 'auto')),
	CONSTRAINT "segue_problem_check" CHECK (("segue"."problem_code" is null) = ("segue"."problem_message" is null)),
	CONSTRAINT "segue_island_ready_check" CHECK ("segue"."island_id" is null or "segue"."status" = 'ready'),
	CONSTRAINT "segue_version_check" CHECK ("segue"."version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "island" ADD CONSTRAINT "island_station_org_fk" FOREIGN KEY ("station_id","org_id") REFERENCES "public"."station"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "segue" ADD CONSTRAINT "segue_from_item_id_log_item_id_fk" FOREIGN KEY ("from_item_id") REFERENCES "public"."log_item"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "segue" ADD CONSTRAINT "segue_to_item_id_log_item_id_fk" FOREIGN KEY ("to_item_id") REFERENCES "public"."log_item"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "segue" ADD CONSTRAINT "segue_from_asset_id_asset_id_fk" FOREIGN KEY ("from_asset_id") REFERENCES "public"."asset"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "segue" ADD CONSTRAINT "segue_to_asset_id_asset_id_fk" FOREIGN KEY ("to_asset_id") REFERENCES "public"."asset"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "segue" ADD CONSTRAINT "segue_island_id_island_id_fk" FOREIGN KEY ("island_id") REFERENCES "public"."island"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "segue" ADD CONSTRAINT "segue_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "segue" ADD CONSTRAINT "segue_station_org_fk" FOREIGN KEY ("station_id","org_id") REFERENCES "public"."station"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "island_station_status_idx" ON "island" USING btree ("station_id","status");--> statement-breakpoint
CREATE INDEX "island_station_hash_idx" ON "island" USING btree ("station_id","hash");--> statement-breakpoint
CREATE INDEX "segue_station_idx" ON "segue" USING btree ("station_id");--> statement-breakpoint
CREATE INDEX "segue_island_idx" ON "segue" USING btree ("island_id");--> statement-breakpoint
CREATE INDEX "segue_voices_idx" ON "segue" USING gin ("voices");