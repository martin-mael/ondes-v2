CREATE TABLE "clock_grid" (
	"station_id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"default_clock_id" uuid,
	"version" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clock_grid_version_check" CHECK ("clock_grid"."version" >= 0)
);
--> statement-breakpoint
CREATE TABLE "clock_grid_cell" (
	"station_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"weekday" integer NOT NULL,
	"hour" integer NOT NULL,
	"clock_id" uuid NOT NULL,
	CONSTRAINT "clock_grid_cell_pkey" PRIMARY KEY("station_id","weekday","hour"),
	CONSTRAINT "clock_grid_cell_weekday_check" CHECK ("clock_grid_cell"."weekday" between 1 and 7),
	CONSTRAINT "clock_grid_cell_hour_check" CHECK ("clock_grid_cell"."hour" between 0 and 23)
);
--> statement-breakpoint
CREATE TABLE "clock_grid_override" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"station_id" uuid NOT NULL,
	"name" text NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date NOT NULL,
	"start_hour" integer NOT NULL,
	"end_hour" integer NOT NULL,
	"clock_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clock_grid_override_range_check" CHECK ("clock_grid_override"."ends_on" >= "clock_grid_override"."starts_on"),
	CONSTRAINT "clock_grid_override_hours_check" CHECK ("clock_grid_override"."start_hour" between 0 and 23 and "clock_grid_override"."end_hour" between 1 and 24 and "clock_grid_override"."start_hour" < "clock_grid_override"."end_hour")
);
--> statement-breakpoint
CREATE TABLE "daypart" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"station_id" uuid NOT NULL,
	"name" text NOT NULL,
	"weekdays" integer[] NOT NULL,
	"start_hour" integer NOT NULL,
	"end_hour" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "daypart_weekdays_check" CHECK (cardinality("daypart"."weekdays") between 1 and 7 and "daypart"."weekdays" <@ '{1,2,3,4,5,6,7}'::integer[]),
	CONSTRAINT "daypart_hours_check" CHECK ("daypart"."start_hour" between 0 and 23 and "daypart"."end_hour" between 1 and 24)
);
--> statement-breakpoint
ALTER TABLE "clock_grid" ADD CONSTRAINT "clock_grid_station_org_fk" FOREIGN KEY ("station_id","org_id") REFERENCES "public"."station"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clock_grid" ADD CONSTRAINT "clock_grid_default_clock_fk" FOREIGN KEY ("default_clock_id","org_id","station_id") REFERENCES "public"."clock"("id","org_id","station_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clock_grid_cell" ADD CONSTRAINT "clock_grid_cell_clock_fk" FOREIGN KEY ("clock_id","org_id","station_id") REFERENCES "public"."clock"("id","org_id","station_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clock_grid_override" ADD CONSTRAINT "clock_grid_override_station_org_fk" FOREIGN KEY ("station_id","org_id") REFERENCES "public"."station"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clock_grid_override" ADD CONSTRAINT "clock_grid_override_clock_fk" FOREIGN KEY ("clock_id","org_id","station_id") REFERENCES "public"."clock"("id","org_id","station_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daypart" ADD CONSTRAINT "daypart_station_org_fk" FOREIGN KEY ("station_id","org_id") REFERENCES "public"."station"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "clock_grid_default_clock_id_idx" ON "clock_grid" USING btree ("default_clock_id");--> statement-breakpoint
CREATE INDEX "clock_grid_cell_clock_id_idx" ON "clock_grid_cell" USING btree ("clock_id");--> statement-breakpoint
CREATE INDEX "clock_grid_override_station_range_idx" ON "clock_grid_override" USING btree ("station_id","starts_on","ends_on");--> statement-breakpoint
CREATE INDEX "clock_grid_override_clock_id_idx" ON "clock_grid_override" USING btree ("clock_id");--> statement-breakpoint
CREATE UNIQUE INDEX "daypart_station_name_key" ON "daypart" USING btree ("station_id",lower("name"));