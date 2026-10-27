CREATE TABLE "promo" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"station_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"show_id" uuid,
	"event_name" text,
	"event_at" timestamp with time zone,
	"weight" integer DEFAULT 1 NOT NULL,
	"max_plays_per_day" integer,
	"dayparts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "promo_asset_key" UNIQUE("asset_id"),
	CONSTRAINT "promo_id_org_station_key" UNIQUE("id","org_id","station_id"),
	CONSTRAINT "promo_weight_check" CHECK ("promo"."weight" between 1 and 100),
	CONSTRAINT "promo_max_plays_check" CHECK ("promo"."max_plays_per_day" between 1 and 1000),
	CONSTRAINT "promo_version_check" CHECK ("promo"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "promo_placement" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"station_id" uuid NOT NULL,
	"promo_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"pool_id" uuid,
	"log_day_id" uuid NOT NULL,
	"local_date" date NOT NULL,
	"from_item_id" uuid,
	"to_item_id" uuid,
	"clock_id" uuid,
	"slot_index" integer,
	"planned_at" timestamp (3) with time zone NOT NULL,
	"segue_id" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "promo_placement_status_check" CHECK ("promo_placement"."status" in ('pending', 'placed', 'dropped'))
);
--> statement-breakpoint
CREATE TABLE "vt_pool" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"station_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"color" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vt_pool_id_org_station_key" UNIQUE("id","org_id","station_id")
);
--> statement-breakpoint
CREATE TABLE "vt_pool_member" (
	"pool_id" uuid NOT NULL,
	"promo_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"station_id" uuid NOT NULL,
	CONSTRAINT "vt_pool_member_pkey" PRIMARY KEY("pool_id","promo_id")
);
--> statement-breakpoint
ALTER TABLE "clock_slot" ADD COLUMN "pool_id" uuid;--> statement-breakpoint
ALTER TABLE "promo" ADD CONSTRAINT "promo_show_id_show_id_fk" FOREIGN KEY ("show_id") REFERENCES "public"."show"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo" ADD CONSTRAINT "promo_asset_fk" FOREIGN KEY ("asset_id","org_id","station_id") REFERENCES "public"."asset"("id","org_id","station_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo_placement" ADD CONSTRAINT "promo_placement_pool_id_vt_pool_id_fk" FOREIGN KEY ("pool_id") REFERENCES "public"."vt_pool"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo_placement" ADD CONSTRAINT "promo_placement_from_item_id_log_item_id_fk" FOREIGN KEY ("from_item_id") REFERENCES "public"."log_item"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo_placement" ADD CONSTRAINT "promo_placement_to_item_id_log_item_id_fk" FOREIGN KEY ("to_item_id") REFERENCES "public"."log_item"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo_placement" ADD CONSTRAINT "promo_placement_segue_id_segue_id_fk" FOREIGN KEY ("segue_id") REFERENCES "public"."segue"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo_placement" ADD CONSTRAINT "promo_placement_promo_fk" FOREIGN KEY ("promo_id","org_id","station_id") REFERENCES "public"."promo"("id","org_id","station_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo_placement" ADD CONSTRAINT "promo_placement_day_fk" FOREIGN KEY ("log_day_id","org_id","station_id") REFERENCES "public"."log_day"("id","org_id","station_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vt_pool" ADD CONSTRAINT "vt_pool_station_org_fk" FOREIGN KEY ("station_id","org_id") REFERENCES "public"."station"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vt_pool_member" ADD CONSTRAINT "vt_pool_member_pool_fk" FOREIGN KEY ("pool_id","org_id","station_id") REFERENCES "public"."vt_pool"("id","org_id","station_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vt_pool_member" ADD CONSTRAINT "vt_pool_member_promo_fk" FOREIGN KEY ("promo_id","org_id","station_id") REFERENCES "public"."promo"("id","org_id","station_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "promo_station_idx" ON "promo" USING btree ("station_id");--> statement-breakpoint
CREATE INDEX "promo_show_idx" ON "promo" USING btree ("show_id");--> statement-breakpoint
CREATE INDEX "promo_placement_promo_idx" ON "promo_placement" USING btree ("promo_id","planned_at");--> statement-breakpoint
CREATE INDEX "promo_placement_day_idx" ON "promo_placement" USING btree ("log_day_id");--> statement-breakpoint
CREATE INDEX "promo_placement_station_date_idx" ON "promo_placement" USING btree ("station_id","local_date");--> statement-breakpoint
CREATE INDEX "promo_placement_segue_idx" ON "promo_placement" USING btree ("segue_id");--> statement-breakpoint
CREATE INDEX "promo_placement_from_item_idx" ON "promo_placement" USING btree ("from_item_id");--> statement-breakpoint
CREATE INDEX "promo_placement_to_item_idx" ON "promo_placement" USING btree ("to_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "vt_pool_station_name_key" ON "vt_pool" USING btree ("station_id",lower("name"));--> statement-breakpoint
CREATE INDEX "vt_pool_member_promo_idx" ON "vt_pool_member" USING btree ("promo_id");--> statement-breakpoint
ALTER TABLE "clock_slot" ADD CONSTRAINT "clock_slot_pool_id_vt_pool_id_fk" FOREIGN KEY ("pool_id") REFERENCES "public"."vt_pool"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "clock_slot_pool_id_idx" ON "clock_slot" USING btree ("pool_id");