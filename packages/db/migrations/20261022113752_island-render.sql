ALTER TABLE "island" ADD COLUMN "file_sha256" text;--> statement-breakpoint
ALTER TABLE "island" ADD COLUMN "file_size_bytes" bigint;--> statement-breakpoint
ALTER TABLE "island" ADD CONSTRAINT "island_file_check" CHECK (("island"."file_sha256" is null) = ("island"."file_size_bytes" is null));