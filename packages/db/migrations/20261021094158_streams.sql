CREATE TABLE "stream_listener_minute" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"station_id" uuid NOT NULL,
	"mount" text NOT NULL,
	"minute" timestamp with time zone NOT NULL,
	"samples" integer NOT NULL,
	"listeners_sum" integer NOT NULL,
	"listeners_max" integer NOT NULL,
	"listeners_min" integer NOT NULL,
	"source_samples" integer NOT NULL,
	CONSTRAINT "stream_listener_minute_counts_check" CHECK ("stream_listener_minute"."samples" > 0 and "stream_listener_minute"."source_samples" between 0 and "stream_listener_minute"."samples"
        and "stream_listener_minute"."listeners_min" between 0 and "stream_listener_minute"."listeners_max")
);
--> statement-breakpoint
ALTER TABLE "stream_listener_minute" ADD CONSTRAINT "stream_listener_minute_station_id_station_id_fk" FOREIGN KEY ("station_id") REFERENCES "public"."station"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "stream_listener_minute_key" ON "stream_listener_minute" USING btree ("station_id","mount","minute");