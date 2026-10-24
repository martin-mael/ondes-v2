ALTER TABLE "show_slot" ADD COLUMN "start_mode" text DEFAULT 'hard' NOT NULL;--> statement-breakpoint
ALTER TABLE "show_slot" ADD COLUMN "start_cap_ms" integer;--> statement-breakpoint
ALTER TABLE "show_slot" ADD CONSTRAINT "show_slot_start_check" CHECK ("show_slot"."start_mode" in ('hard', 'soft')
        and ("show_slot"."start_cap_ms" is null or ("show_slot"."start_mode" = 'soft' and "show_slot"."start_cap_ms" between 0 and 600000)));