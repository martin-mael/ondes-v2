CREATE TABLE "streamer" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"station_id" uuid NOT NULL,
	"user_id" uuid,
	"display_name" text NOT NULL,
	"username" text NOT NULL,
	"password_hash" text NOT NULL,
	"password_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"expires_at" timestamp with time zone,
	"any_time" boolean DEFAULT false NOT NULL,
	"last_connected_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "streamer_id_org_station_key" UNIQUE("id","org_id","station_id"),
	CONSTRAINT "streamer_username_check" CHECK ("streamer"."username" ~ '^[a-z0-9][a-z0-9._-]{1,31}$')
);
--> statement-breakpoint
CREATE TABLE "streamer_show" (
	"streamer_id" uuid NOT NULL,
	"show_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"station_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "streamer_show_pkey" PRIMARY KEY("streamer_id","show_id")
);
--> statement-breakpoint
ALTER TABLE "streamer" ADD CONSTRAINT "streamer_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "streamer" ADD CONSTRAINT "streamer_station_org_fk" FOREIGN KEY ("station_id","org_id") REFERENCES "public"."station"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "streamer_show" ADD CONSTRAINT "streamer_show_streamer_fk" FOREIGN KEY ("streamer_id","org_id","station_id") REFERENCES "public"."streamer"("id","org_id","station_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "streamer_show" ADD CONSTRAINT "streamer_show_show_fk" FOREIGN KEY ("show_id","org_id","station_id") REFERENCES "public"."show"("id","org_id","station_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "streamer_station_username_key" ON "streamer" USING btree ("station_id",lower("username"));--> statement-breakpoint
CREATE INDEX "streamer_user_idx" ON "streamer" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "streamer_show_show_idx" ON "streamer_show" USING btree ("show_id");