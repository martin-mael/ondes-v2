CREATE TABLE "job_run" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"lane" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"idempotency" text NOT NULL,
	"status" text NOT NULL,
	"attempt" integer NOT NULL,
	"org_id" uuid,
	"station_id" uuid,
	"last_error" text,
	"enqueued_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "job_run_in_flight_key" ON "job_run" USING btree ("idempotency_key") WHERE "job_run"."status" in ('running', 'retrying');--> statement-breakpoint
CREATE INDEX "job_run_key_status_idx" ON "job_run" USING btree ("idempotency_key","status");--> statement-breakpoint
CREATE INDEX "job_run_status_enqueued_idx" ON "job_run" USING btree ("status","enqueued_at");--> statement-breakpoint
CREATE INDEX "job_run_station_enqueued_idx" ON "job_run" USING btree ("station_id","enqueued_at");