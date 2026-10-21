CREATE TABLE "episode" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"station_id" uuid NOT NULL,
	"show_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"title" text,
	"description" text,
	"tracklist" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"kind" text NOT NULL,
	"asset_id" uuid,
	"status" text DEFAULT 'planned' NOT NULL,
	"aired_at" timestamp with time zone,
	"slot_id" uuid,
	"occurrence_date" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "episode_show_number_key" UNIQUE("show_id","number"),
	CONSTRAINT "episode_number_check" CHECK ("episode"."number" >= 1),
	CONSTRAINT "episode_kind_check" CHECK ("episode"."kind" in ('prerecorded', 'live')),
	CONSTRAINT "episode_status_check" CHECK ("episode"."status" in ('planned', 'ready', 'aired', 'missing')),
	CONSTRAINT "episode_ready_asset_check" CHECK ("episode"."status" <> 'ready' or "episode"."asset_id" is not null),
	CONSTRAINT "episode_occurrence_pair_check" CHECK (("episode"."slot_id" is null) = ("episode"."occurrence_date" is null))
);
--> statement-breakpoint
CREATE TABLE "show" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"station_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"artwork_url" text,
	"colour" text,
	"default_duration_ms" integer,
	"default_slot_type" text DEFAULT 'prerecorded' NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"next_episode_number" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "show_id_org_station_key" UNIQUE("id","org_id","station_id"),
	CONSTRAINT "show_default_slot_type_check" CHECK ("show"."default_slot_type" in ('prerecorded', 'live')),
	CONSTRAINT "show_colour_check" CHECK ("show"."colour" ~ '^#[0-9a-f]{6}$'),
	CONSTRAINT "show_default_duration_check" CHECK ("show"."default_duration_ms" between 60000 and 86400000)
);
--> statement-breakpoint
CREATE TABLE "show_host" (
	"show_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"station_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "show_host_pkey" PRIMARY KEY("show_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "show_slot" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"station_id" uuid NOT NULL,
	"show_id" uuid NOT NULL,
	"type" text NOT NULL,
	"rule" jsonb NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date,
	"duration_ms" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "show_slot_id_org_station_key" UNIQUE("id","org_id","station_id"),
	CONSTRAINT "show_slot_type_check" CHECK ("show_slot"."type" in ('prerecorded', 'live', 'rerun')),
	CONSTRAINT "show_slot_duration_check" CHECK ("show_slot"."duration_ms" between 60000 and 86400000),
	CONSTRAINT "show_slot_range_check" CHECK ("show_slot"."ends_on" >= "show_slot"."starts_on")
);
--> statement-breakpoint
CREATE TABLE "show_slot_exception" (
	"slot_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"station_id" uuid NOT NULL,
	"date" date NOT NULL,
	"kind" text NOT NULL,
	"start_date" date,
	"start_time" text,
	"duration_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "show_slot_exception_pkey" PRIMARY KEY("slot_id","date"),
	CONSTRAINT "show_slot_exception_kind_check" CHECK (("show_slot_exception"."kind" = 'cancelled' and "show_slot_exception"."start_date" is null and "show_slot_exception"."start_time" is null and "show_slot_exception"."duration_ms" is null)
        or ("show_slot_exception"."kind" = 'moved' and "show_slot_exception"."start_date" is not null and "show_slot_exception"."start_time" is not null)),
	CONSTRAINT "show_slot_exception_move_check" CHECK ("show_slot_exception"."start_date" between "show_slot_exception"."date" - 7 and "show_slot_exception"."date" + 7),
	CONSTRAINT "show_slot_exception_duration_check" CHECK ("show_slot_exception"."duration_ms" between 60000 and 86400000)
);
--> statement-breakpoint
ALTER TABLE "episode" ADD CONSTRAINT "episode_asset_id_asset_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."asset"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "episode" ADD CONSTRAINT "episode_slot_id_show_slot_id_fk" FOREIGN KEY ("slot_id") REFERENCES "public"."show_slot"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "episode" ADD CONSTRAINT "episode_show_fk" FOREIGN KEY ("show_id","org_id","station_id") REFERENCES "public"."show"("id","org_id","station_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "show" ADD CONSTRAINT "show_station_org_fk" FOREIGN KEY ("station_id","org_id") REFERENCES "public"."station"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "show_host" ADD CONSTRAINT "show_host_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "show_host" ADD CONSTRAINT "show_host_show_fk" FOREIGN KEY ("show_id","org_id","station_id") REFERENCES "public"."show"("id","org_id","station_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "show_slot" ADD CONSTRAINT "show_slot_show_fk" FOREIGN KEY ("show_id","org_id","station_id") REFERENCES "public"."show"("id","org_id","station_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "show_slot_exception" ADD CONSTRAINT "show_slot_exception_slot_fk" FOREIGN KEY ("slot_id","org_id","station_id") REFERENCES "public"."show_slot"("id","org_id","station_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "episode_occurrence_key" ON "episode" USING btree ("slot_id","occurrence_date") WHERE "episode"."slot_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "episode_asset_key" ON "episode" USING btree ("asset_id") WHERE "episode"."asset_id" is not null;--> statement-breakpoint
CREATE INDEX "episode_station_status_idx" ON "episode" USING btree ("station_id","status");--> statement-breakpoint
CREATE INDEX "episode_unscheduled_idx" ON "episode" USING btree ("show_id") WHERE "episode"."slot_id" is null;--> statement-breakpoint
CREATE INDEX "show_station_name_idx" ON "show" USING btree ("station_id","name");--> statement-breakpoint
CREATE INDEX "show_host_user_idx" ON "show_host" USING btree ("user_id","station_id");--> statement-breakpoint
CREATE INDEX "show_slot_show_idx" ON "show_slot" USING btree ("show_id");--> statement-breakpoint
CREATE INDEX "show_slot_station_range_idx" ON "show_slot" USING btree ("station_id","starts_on","ends_on");