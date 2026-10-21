CREATE TABLE "engine_port" (
	"port" integer PRIMARY KEY NOT NULL,
	"station_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "engine_port_station_purpose_key" UNIQUE("station_id","purpose"),
	CONSTRAINT "engine_port_range" CHECK ("engine_port"."port" between 1024 and 65535)
);
--> statement-breakpoint
CREATE TABLE "station_engine" (
	"station_id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"desired_state" text DEFAULT 'running' NOT NULL,
	"control_token_enc" text NOT NULL,
	"live_password_enc" text NOT NULL,
	"icecast_source_password_enc" text NOT NULL,
	"config_version" text,
	"container_id" text,
	"storm_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "engine_port" ADD CONSTRAINT "engine_port_station_id_station_id_fk" FOREIGN KEY ("station_id") REFERENCES "public"."station"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "station_engine" ADD CONSTRAINT "station_engine_station_fk" FOREIGN KEY ("station_id","org_id") REFERENCES "public"."station"("id","org_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "station_engine_desired_state_idx" ON "station_engine" USING btree ("desired_state");