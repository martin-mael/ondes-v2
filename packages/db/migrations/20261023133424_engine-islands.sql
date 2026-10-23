ALTER TABLE "asrun_entry" ADD COLUMN "transition" jsonb;--> statement-breakpoint
ALTER TABLE "feeder_push" ADD COLUMN "parts" jsonb;--> statement-breakpoint
ALTER TABLE "feeder_push" ADD COLUMN "item_ids" uuid[];