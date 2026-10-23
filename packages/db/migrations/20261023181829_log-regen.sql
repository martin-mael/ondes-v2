CREATE TABLE "log_item_pin" (
	"log_item_id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"station_id" uuid NOT NULL,
	"start" timestamp (3) with time zone NOT NULL,
	"settled_start" timestamp (3) with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "log_regen_cursor" (
	"station_id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"seen_until" timestamp (3) with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "log_regen_request" (
	"station_id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"from_date" date,
	"areas" text[] NOT NULL,
	"first_requested_at" timestamp (3) with time zone NOT NULL,
	"last_requested_at" timestamp (3) with time zone NOT NULL,
	"due_at" timestamp (3) with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "log_regen_setting" (
	"station_id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"horizon_days" integer NOT NULL,
	"new_day_status" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "log_regen_setting_horizon" CHECK ("log_regen_setting"."horizon_days" between 1 and 56),
	CONSTRAINT "log_regen_setting_status" CHECK ("log_regen_setting"."new_day_status" in ('draft', 'published'))
);
--> statement-breakpoint
ALTER TABLE "log_item_pin" ADD CONSTRAINT "log_item_pin_item_fk" FOREIGN KEY ("log_item_id") REFERENCES "public"."log_item"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "log_item_pin" ADD CONSTRAINT "log_item_pin_station_org_fk" FOREIGN KEY ("station_id","org_id") REFERENCES "public"."station"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "log_regen_cursor" ADD CONSTRAINT "log_regen_cursor_station_org_fk" FOREIGN KEY ("station_id","org_id") REFERENCES "public"."station"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "log_regen_request" ADD CONSTRAINT "log_regen_request_station_org_fk" FOREIGN KEY ("station_id","org_id") REFERENCES "public"."station"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "log_regen_setting" ADD CONSTRAINT "log_regen_setting_station_org_fk" FOREIGN KEY ("station_id","org_id") REFERENCES "public"."station"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "log_item_pin_station" ON "log_item_pin" USING btree ("station_id");--> statement-breakpoint
CREATE INDEX "log_regen_request_due" ON "log_regen_request" USING btree ("due_at");