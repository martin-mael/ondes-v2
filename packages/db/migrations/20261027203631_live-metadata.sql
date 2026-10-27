CREATE TABLE "live_now_playing" (
	"session_id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"station_id" uuid NOT NULL,
	"title" text,
	"artist" text,
	"source" text NOT NULL,
	"encoder_title" text,
	"encoder_artist" text,
	"encoder_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "live_now_playing_source_check" CHECK ("live_now_playing"."source" in ('default', 'encoder', 'manual'))
);
--> statement-breakpoint
ALTER TABLE "streamer" ADD COLUMN "encoder_metadata" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "live_now_playing" ADD CONSTRAINT "live_now_playing_session_id_live_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."live_session"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "live_now_playing" ADD CONSTRAINT "live_now_playing_station_org_fk" FOREIGN KEY ("station_id","org_id") REFERENCES "public"."station"("id","org_id") ON DELETE cascade ON UPDATE no action;