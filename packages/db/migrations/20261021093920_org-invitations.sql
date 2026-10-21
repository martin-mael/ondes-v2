CREATE TABLE "invite_link" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"station_id" uuid,
	"role" text NOT NULL,
	"label" text,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"max_uses" integer,
	"use_count" integer DEFAULT 0 NOT NULL,
	"restrict_to_domains" boolean DEFAULT false NOT NULL,
	"created_by" uuid,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invite_link_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "invite_link_max_uses_check" CHECK ("invite_link"."max_uses" is null or "invite_link"."max_uses" > 0),
	CONSTRAINT "invite_link_use_count_check" CHECK ("invite_link"."use_count" >= 0 and ("invite_link"."max_uses" is null or "invite_link"."use_count" <= "invite_link"."max_uses")),
	CONSTRAINT "invite_link_role_level_check" CHECK (("invite_link"."role" in ('owner', 'admin') and "invite_link"."station_id" is null)
      or ("invite_link"."role" in ('station_manager', 'programmer', 'presenter', 'viewer') and "invite_link"."station_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "join_request" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"domain_id" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "join_request_status_check" CHECK ("join_request"."status" in ('pending', 'approved', 'refused'))
);
--> statement-breakpoint
CREATE TABLE "org_domain" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"domain" text NOT NULL,
	"policy" text NOT NULL,
	"default_role" text NOT NULL,
	"default_station_id" uuid,
	"dns_token" text NOT NULL,
	"email_token_hash" text,
	"email_token_expires_at" timestamp with time zone,
	"email_token_sent_to" text,
	"verified_at" timestamp with time zone,
	"verification_method" text,
	"paused_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_domain_email_token_hash_unique" UNIQUE("email_token_hash"),
	CONSTRAINT "org_domain_policy_check" CHECK ("org_domain"."policy" in ('auto_join', 'request')),
	CONSTRAINT "org_domain_role_level_check" CHECK (("org_domain"."default_role" in ('owner', 'admin') and "org_domain"."default_station_id" is null)
      or ("org_domain"."default_role" in ('station_manager', 'programmer', 'presenter', 'viewer') and "org_domain"."default_station_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "invite_link" ADD CONSTRAINT "invite_link_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invite_link" ADD CONSTRAINT "invite_link_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invite_link" ADD CONSTRAINT "invite_link_station_org_fk" FOREIGN KEY ("station_id","org_id") REFERENCES "public"."station"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "join_request" ADD CONSTRAINT "join_request_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "join_request" ADD CONSTRAINT "join_request_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "join_request" ADD CONSTRAINT "join_request_domain_id_org_domain_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."org_domain"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "join_request" ADD CONSTRAINT "join_request_decided_by_user_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_domain" ADD CONSTRAINT "org_domain_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_domain" ADD CONSTRAINT "org_domain_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_domain" ADD CONSTRAINT "org_domain_station_org_fk" FOREIGN KEY ("default_station_id","org_id") REFERENCES "public"."station"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invite_link_org_id_idx" ON "invite_link" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "join_request_org_id_idx" ON "join_request" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "join_request_pending_key" ON "join_request" USING btree ("org_id","user_id") WHERE "join_request"."status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "org_domain_org_domain_key" ON "org_domain" USING btree ("org_id","domain");--> statement-breakpoint
CREATE UNIQUE INDEX "org_domain_verified_key" ON "org_domain" USING btree ("domain") WHERE "org_domain"."verified_at" is not null;--> statement-breakpoint
CREATE INDEX "org_domain_domain_idx" ON "org_domain" USING btree ("domain");