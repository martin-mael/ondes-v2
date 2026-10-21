CREATE TABLE "stream_listener_stat" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"station_id" uuid NOT NULL,
	"mount" text NOT NULL,
	"bucket_start" timestamp with time zone NOT NULL,
	"bucket_seconds" integer NOT NULL,
	"samples" integer NOT NULL,
	"listeners_sum" integer NOT NULL,
	"listeners_max" integer NOT NULL,
	"listeners_min" integer NOT NULL,
	"source_samples" integer NOT NULL,
	CONSTRAINT "stream_listener_stat_counts_check" CHECK ("stream_listener_stat"."bucket_seconds" in (60, 3600) and "stream_listener_stat"."samples" > 0
        and "stream_listener_stat"."source_samples" between 0 and "stream_listener_stat"."samples"
        and "stream_listener_stat"."listeners_min" between 0 and "stream_listener_stat"."listeners_max")
);
--> statement-breakpoint
ALTER TABLE "stream_listener_stat" ADD CONSTRAINT "stream_listener_stat_station_id_station_id_fk" FOREIGN KEY ("station_id") REFERENCES "public"."station"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "stream_listener_stat_key" ON "stream_listener_stat" USING btree ("station_id","mount","bucket_seconds","bucket_start");