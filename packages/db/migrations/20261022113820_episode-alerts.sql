CREATE TABLE "episode_check" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"station_id" uuid NOT NULL,
	"show_id" uuid NOT NULL,
	"slot_id" uuid NOT NULL,
	"occurrence_date" date NOT NULL,
	"step" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"episode_id" uuid,
	"notified" text[] DEFAULT '{}'::text[] NOT NULL,
	"attempts" smallint DEFAULT 0 NOT NULL,
	"claimed_at" timestamp with time zone,
	"processed_at" timestamp with time zone,
	"result" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "episode_check_occurrence_step_key" UNIQUE("slot_id","occurrence_date","step"),
	CONSTRAINT "episode_check_step_check" CHECK ("episode_check"."step" in ('t48h', 't6h', 'fallback'))
);
--> statement-breakpoint
CREATE TABLE "log_item_fallback" (
	"log_item_id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"station_id" uuid NOT NULL,
	"slot_id" uuid NOT NULL,
	"occurrence_date" date NOT NULL,
	"kind" text NOT NULL,
	"episode_id" uuid,
	"missing_episode_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "log_item_fallback_kind_check" CHECK ("log_item_fallback"."kind" in ('latest_episode', 'episode', 'clock_music'))
);
--> statement-breakpoint
ALTER TABLE "asrun_entry" ADD COLUMN "fallback" text;--> statement-breakpoint
ALTER TABLE "show" ADD COLUMN "fallback_policy" text DEFAULT 'latest_episode' NOT NULL;--> statement-breakpoint
ALTER TABLE "show" ADD COLUMN "fallback_episode_id" uuid;--> statement-breakpoint
ALTER TABLE "episode_check" ADD CONSTRAINT "episode_check_slot_fk" FOREIGN KEY ("slot_id","org_id","station_id") REFERENCES "public"."show_slot"("id","org_id","station_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "log_item_fallback" ADD CONSTRAINT "log_item_fallback_log_item_id_log_item_id_fk" FOREIGN KEY ("log_item_id") REFERENCES "public"."log_item"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "log_item_fallback" ADD CONSTRAINT "log_item_fallback_slot_fk" FOREIGN KEY ("slot_id","org_id","station_id") REFERENCES "public"."show_slot"("id","org_id","station_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "episode_check_pending_idx" ON "episode_check" USING btree ("created_at") WHERE "episode_check"."processed_at" is null;--> statement-breakpoint
CREATE INDEX "log_item_fallback_occurrence_idx" ON "log_item_fallback" USING btree ("slot_id","occurrence_date");--> statement-breakpoint
ALTER TABLE "show" ADD CONSTRAINT "show_fallback_episode_id_episode_id_fk" FOREIGN KEY ("fallback_episode_id") REFERENCES "public"."episode"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asrun_entry" ADD CONSTRAINT "asrun_entry_fallback_check" CHECK ("asrun_entry"."fallback" is null or "asrun_entry"."fallback" in ('latest_episode', 'episode', 'clock_music'));--> statement-breakpoint
ALTER TABLE "show" ADD CONSTRAINT "show_fallback_policy_check" CHECK ("show"."fallback_policy" in ('latest_episode', 'episode', 'clock_music', 'none'));