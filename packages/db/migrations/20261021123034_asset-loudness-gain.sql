ALTER TABLE "asset" ADD COLUMN "normalize_loudness" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "asset" ADD COLUMN "gain_override_db" real;--> statement-breakpoint
ALTER TABLE "asset" ADD CONSTRAINT "asset_gain_override_check" CHECK ("asset"."gain_override_db" between -60 and 24);