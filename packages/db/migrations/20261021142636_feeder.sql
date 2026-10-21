CREATE TABLE "feeder_push" (
	"station_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"boot_id" text NOT NULL,
	"entry_id" uuid NOT NULL,
	"fingerprint" text NOT NULL,
	"trim_ms" integer DEFAULT 0 NOT NULL,
	"aired" boolean DEFAULT false NOT NULL,
	"pushed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feeder_push_pkey" PRIMARY KEY("station_id","boot_id","entry_id"),
	CONSTRAINT "feeder_push_trim_check" CHECK ("feeder_push"."trim_ms" >= 0)
);
--> statement-breakpoint
ALTER TABLE "feeder_push" ADD CONSTRAINT "feeder_push_station_org_fk" FOREIGN KEY ("station_id","org_id") REFERENCES "public"."station"("id","org_id") ON DELETE cascade ON UPDATE no action;