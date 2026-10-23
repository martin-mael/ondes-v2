CREATE TABLE "live_event" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"station_id" uuid NOT NULL,
	"title" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "live_event_id_org_station_key" UNIQUE("id","org_id","station_id"),
	CONSTRAINT "live_event_span_check" CHECK ("live_event"."ends_at" > "live_event"."starts_at" and "live_event"."ends_at" <= "live_event"."starts_at" + interval '24 hours')
);
--> statement-breakpoint
CREATE TABLE "live_event_streamer" (
	"event_id" uuid NOT NULL,
	"streamer_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"station_id" uuid NOT NULL,
	CONSTRAINT "live_event_streamer_pkey" PRIMARY KEY("event_id","streamer_id")
);
--> statement-breakpoint
CREATE TABLE "live_request" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"station_id" uuid NOT NULL,
	"streamer_id" uuid NOT NULL,
	"input" integer NOT NULL,
	"connected_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by" uuid,
	CONSTRAINT "live_request_status_check" CHECK ("live_request"."status" in ('pending', 'approved', 'refused', 'cancelled')),
	CONSTRAINT "live_request_decided_check" CHECK (("live_request"."status" = 'pending') = ("live_request"."decided_at" is null)),
	CONSTRAINT "live_request_input_check" CHECK ("live_request"."input" between 1 and 16)
);
--> statement-breakpoint
CREATE TABLE "live_slot_check" (
	"slot_id" uuid NOT NULL,
	"occurrence_date" date NOT NULL,
	"org_id" uuid NOT NULL,
	"station_id" uuid NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"missed_at" timestamp with time zone,
	"fallback" text,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "live_slot_check_pkey" PRIMARY KEY("slot_id","occurrence_date")
);
--> statement-breakpoint
ALTER TABLE "live_session" DROP CONSTRAINT "live_session_trigger_check";--> statement-breakpoint
ALTER TABLE "asrun_entry" ADD COLUMN "live_dj_name" text;--> statement-breakpoint
ALTER TABLE "asrun_entry" ADD COLUMN "live_title" text;--> statement-breakpoint
ALTER TABLE "live_session" ADD COLUMN "streamer_name" text;--> statement-breakpoint
ALTER TABLE "live_session" ADD COLUMN "show_id" uuid;--> statement-breakpoint
ALTER TABLE "live_session" ADD COLUMN "slot_id" uuid;--> statement-breakpoint
ALTER TABLE "live_session" ADD COLUMN "occurrence_date" date;--> statement-breakpoint
ALTER TABLE "live_session" ADD COLUMN "episode_id" uuid;--> statement-breakpoint
ALTER TABLE "live_session" ADD COLUMN "episode_number" integer;--> statement-breakpoint
ALTER TABLE "live_session" ADD COLUMN "event_id" uuid;--> statement-breakpoint
ALTER TABLE "live_session" ADD COLUMN "title" text;--> statement-breakpoint
ALTER TABLE "live_session" ADD COLUMN "scheduled_end_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "streamer" ADD COLUMN "ad_hoc" text DEFAULT 'approval' NOT NULL;--> statement-breakpoint
ALTER TABLE "show_slot" ADD COLUMN "live_grace_ms" integer;--> statement-breakpoint
ALTER TABLE "show_slot" ADD COLUMN "live_early_connect" text;--> statement-breakpoint
ALTER TABLE "live_event" ADD CONSTRAINT "live_event_station_org_fk" FOREIGN KEY ("station_id","org_id") REFERENCES "public"."station"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "live_event_streamer" ADD CONSTRAINT "live_event_streamer_event_fk" FOREIGN KEY ("event_id","org_id","station_id") REFERENCES "public"."live_event"("id","org_id","station_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "live_event_streamer" ADD CONSTRAINT "live_event_streamer_streamer_fk" FOREIGN KEY ("streamer_id","org_id","station_id") REFERENCES "public"."streamer"("id","org_id","station_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "live_request" ADD CONSTRAINT "live_request_decided_by_user_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "live_request" ADD CONSTRAINT "live_request_streamer_fk" FOREIGN KEY ("streamer_id","org_id","station_id") REFERENCES "public"."streamer"("id","org_id","station_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "live_slot_check" ADD CONSTRAINT "live_slot_check_slot_fk" FOREIGN KEY ("slot_id","org_id","station_id") REFERENCES "public"."show_slot"("id","org_id","station_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "live_event_station_range_idx" ON "live_event" USING btree ("station_id","ends_at","starts_at");--> statement-breakpoint
CREATE INDEX "live_event_streamer_streamer_idx" ON "live_event_streamer" USING btree ("streamer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "live_request_connection_key" ON "live_request" USING btree ("streamer_id","input","connected_at");--> statement-breakpoint
CREATE INDEX "live_request_pending_idx" ON "live_request" USING btree ("station_id","requested_at") WHERE "live_request"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "live_slot_check_open_idx" ON "live_slot_check" USING btree ("station_id","ends_at") WHERE "live_slot_check"."closed_at" is null;--> statement-breakpoint
CREATE INDEX "live_session_occurrence_idx" ON "live_session" USING btree ("slot_id","occurrence_date") WHERE "live_session"."slot_id" is not null;--> statement-breakpoint
ALTER TABLE "live_session" ADD CONSTRAINT "live_session_occurrence_check" CHECK (("live_session"."slot_id" is null) = ("live_session"."occurrence_date" is null));--> statement-breakpoint
ALTER TABLE "live_session" ADD CONSTRAINT "live_session_trigger_check" CHECK ("live_session"."trigger" in ('slot', 'manual', 'ad_hoc', 'event'));--> statement-breakpoint
ALTER TABLE "streamer" ADD CONSTRAINT "streamer_ad_hoc_check" CHECK ("streamer"."ad_hoc" in ('approval', 'allowed'));--> statement-breakpoint
ALTER TABLE "show_slot" ADD CONSTRAINT "show_slot_live_check" CHECK (("show_slot"."live_grace_ms" is null) = ("show_slot"."live_early_connect" is null)
        and ("show_slot"."live_grace_ms" is null or "show_slot"."type" = 'live')
        and ("show_slot"."live_grace_ms" is null or "show_slot"."live_grace_ms" between 0 and 3600000)
        and ("show_slot"."live_early_connect" is null or "show_slot"."live_early_connect" in ('wait', 'go_live')));