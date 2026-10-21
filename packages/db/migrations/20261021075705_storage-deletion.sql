CREATE TABLE "storage_deletion" (
	"org_id" uuid NOT NULL,
	"key" text NOT NULL,
	"released_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	CONSTRAINT "storage_deletion_pkey" PRIMARY KEY("org_id","key")
);
--> statement-breakpoint
ALTER TABLE "storage_deletion" ADD CONSTRAINT "storage_deletion_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "storage_deletion_released_idx" ON "storage_deletion" USING btree ("released_at");