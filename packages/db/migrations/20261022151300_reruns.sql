ALTER TABLE "asrun_entry" ADD COLUMN "episode_id" uuid;--> statement-breakpoint
ALTER TABLE "asrun_entry" ADD COLUMN "show_id" uuid;--> statement-breakpoint
ALTER TABLE "asrun_entry" ADD COLUMN "episode_number" integer;--> statement-breakpoint
ALTER TABLE "asrun_entry" ADD COLUMN "rerun" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "show_slot" ADD COLUMN "rerun_strategy" text;--> statement-breakpoint
ALTER TABLE "show_slot" ADD COLUMN "rerun_episode_id" uuid;--> statement-breakpoint
ALTER TABLE "show_slot" ADD CONSTRAINT "show_slot_rerun_episode_id_episode_id_fk" FOREIGN KEY ("rerun_episode_id") REFERENCES "public"."episode"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "show_slot_rerun_episode_idx" ON "show_slot" USING btree ("rerun_episode_id") WHERE "show_slot"."rerun_episode_id" is not null;--> statement-breakpoint
ALTER TABLE "asrun_entry" ADD CONSTRAINT "asrun_entry_episode_check" CHECK (("asrun_entry"."episode_id" is null) = ("asrun_entry"."episode_number" is null)
        and ("asrun_entry"."episode_id" is null) = ("asrun_entry"."show_id" is null)
        and ("asrun_entry"."episode_id" is not null or not "asrun_entry"."rerun"));--> statement-breakpoint
ALTER TABLE "show_slot" ADD CONSTRAINT "show_slot_rerun_check" CHECK (("show_slot"."rerun_strategy" is null or "show_slot"."type" = 'rerun')
        and ("show_slot"."rerun_strategy" is null or "show_slot"."rerun_strategy" in ('latest_episode', 'episode'))
        and ("show_slot"."rerun_episode_id" is null or "show_slot"."rerun_strategy" = 'episode'));