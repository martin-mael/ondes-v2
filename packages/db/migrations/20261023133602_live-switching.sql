CREATE TABLE "live_session" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"station_id" uuid NOT NULL,
	"streamer_id" uuid,
	"input" integer NOT NULL,
	"trigger" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"end_reason" text,
	CONSTRAINT "live_session_input_check" CHECK ("live_session"."input" between 1 and 16),
	CONSTRAINT "live_session_trigger_check" CHECK ("live_session"."trigger" in ('slot', 'manual')),
	CONSTRAINT "live_session_end_check" CHECK (("live_session"."ended_at" is null) = ("live_session"."end_reason" is null))
);
--> statement-breakpoint
ALTER TABLE "live_session" ADD CONSTRAINT "live_session_streamer_id_streamer_id_fk" FOREIGN KEY ("streamer_id") REFERENCES "public"."streamer"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "live_session" ADD CONSTRAINT "live_session_station_org_fk" FOREIGN KEY ("station_id","org_id") REFERENCES "public"."station"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "live_session_open_key" ON "live_session" USING btree ("station_id") WHERE "live_session"."ended_at" is null;--> statement-breakpoint
CREATE INDEX "live_session_station_started_idx" ON "live_session" USING btree ("station_id","started_at");--> statement-breakpoint
CREATE INDEX "live_session_streamer_idx" ON "live_session" USING btree ("streamer_id");