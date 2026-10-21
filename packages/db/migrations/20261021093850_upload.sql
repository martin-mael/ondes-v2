CREATE TABLE "upload" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"station_id" uuid NOT NULL,
	"status" text DEFAULT 'uploading' NOT NULL,
	"filename" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"content_type" text,
	"asset_type" text NOT NULL,
	"staging_key" text NOT NULL,
	"s3_upload_id" text,
	"part_size" integer NOT NULL,
	"part_count" integer NOT NULL,
	"sha256" text,
	"asset_id" uuid,
	"duplicate_of_asset_id" uuid,
	"error_code" text,
	"error" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "upload_status_check" CHECK ("upload"."status" in ('uploading', 'queued', 'processing', 'ingested', 'duplicate', 'quarantined', 'failed', 'aborted')),
	CONSTRAINT "upload_size_check" CHECK ("upload"."size_bytes" >= 0),
	CONSTRAINT "upload_parts_check" CHECK ("upload"."part_size" > 0 and "upload"."part_count" > 0)
);
--> statement-breakpoint
ALTER TABLE "upload" ADD CONSTRAINT "upload_station_org_fk" FOREIGN KEY ("station_id","org_id") REFERENCES "public"."station"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "upload_station_id_idx" ON "upload" USING btree ("station_id","id");--> statement-breakpoint
CREATE INDEX "upload_station_status_idx" ON "upload" USING btree ("station_id","status");--> statement-breakpoint
CREATE INDEX "upload_station_sha256_idx" ON "upload" USING btree ("station_id","sha256");