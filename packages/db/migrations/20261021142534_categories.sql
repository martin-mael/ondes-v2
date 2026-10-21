CREATE TABLE "category" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"station_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"color" text,
	"asset_type" text DEFAULT 'song' NOT NULL,
	"rule" jsonb,
	"rotation_order" text DEFAULT 'least_recently_played' NOT NULL,
	"search_depth_percent" integer DEFAULT 100 NOT NULL,
	"rest_minutes" integer DEFAULT 180 NOT NULL,
	"max_plays_per_day" integer,
	"max_plays_per_week" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "category_id_org_station_key" UNIQUE("id","org_id","station_id"),
	CONSTRAINT "category_asset_type_check" CHECK ("category"."asset_type" in ('song', 'vt', 'jingle', 'bed', 'episode', 'other')),
	CONSTRAINT "category_rotation_order_check" CHECK ("category"."rotation_order" in ('least_recently_played', 'weighted_random', 'sequential')),
	CONSTRAINT "category_search_depth_check" CHECK ("category"."search_depth_percent" between 1 and 100),
	CONSTRAINT "category_rest_check" CHECK ("category"."rest_minutes" >= 0),
	CONSTRAINT "category_max_plays_check" CHECK ("category"."max_plays_per_day" > 0 and "category"."max_plays_per_week" > 0)
);
--> statement-breakpoint
CREATE TABLE "category_member" (
	"category_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"station_id" uuid NOT NULL,
	"mode" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "category_member_pkey" PRIMARY KEY("category_id","asset_id"),
	CONSTRAINT "category_member_mode_check" CHECK ("category_member"."mode" in ('include', 'exclude'))
);
--> statement-breakpoint
ALTER TABLE "category" ADD CONSTRAINT "category_station_org_fk" FOREIGN KEY ("station_id","org_id") REFERENCES "public"."station"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "category_member" ADD CONSTRAINT "category_member_category_fk" FOREIGN KEY ("category_id","org_id","station_id") REFERENCES "public"."category"("id","org_id","station_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "category_member" ADD CONSTRAINT "category_member_asset_fk" FOREIGN KEY ("asset_id","org_id","station_id") REFERENCES "public"."asset"("id","org_id","station_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "category_station_name_key" ON "category" USING btree ("station_id",lower("name"));--> statement-breakpoint
CREATE INDEX "category_member_asset_id_idx" ON "category_member" USING btree ("asset_id");