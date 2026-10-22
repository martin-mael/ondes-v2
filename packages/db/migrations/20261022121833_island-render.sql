ALTER TABLE "island" ADD COLUMN "file_sha256" text;--> statement-breakpoint
ALTER TABLE "island" ADD COLUMN "file_size_bytes" bigint;--> statement-breakpoint
ALTER TABLE "island" ADD COLUMN "render_claim" uuid;--> statement-breakpoint
ALTER TABLE "island" ADD COLUMN "render_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "island" ADD COLUMN "retry_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "island" ADD CONSTRAINT "island_file_check" CHECK (("island"."file_sha256" is null) = ("island"."file_size_bytes" is null));