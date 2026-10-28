CREATE TABLE "live_handover" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"station_id" uuid NOT NULL,
	"streamer_id" uuid NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"fade_ms" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"reason" text,
	"session_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	CONSTRAINT "live_handover_status_check" CHECK ("live_handover"."status" in ('pending', 'running', 'done', 'failed', 'cancelled')),
	CONSTRAINT "live_handover_fade_check" CHECK ("live_handover"."fade_ms" between 0 and 10000)
);
--> statement-breakpoint
ALTER TABLE "live_handover" ADD CONSTRAINT "live_handover_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "live_handover" ADD CONSTRAINT "live_handover_streamer_fk" FOREIGN KEY ("streamer_id","org_id","station_id") REFERENCES "public"."streamer"("id","org_id","station_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "live_handover_pending_idx" ON "live_handover" USING btree ("station_id","at") WHERE "live_handover"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "live_handover_station_at_idx" ON "live_handover" USING btree ("station_id","at");