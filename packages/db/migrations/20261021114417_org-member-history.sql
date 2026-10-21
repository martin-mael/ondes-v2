-- #113: everyone who ever held a membership in an org, so domain rules don't let a removed
-- member back in. A trigger keeps it up to date whatever path creates the membership.
CREATE FUNCTION "org_member_history_record"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO "org_member_history" ("org_id", "user_id") VALUES (NEW."org_id", NEW."user_id")
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER "membership_org_member_history" AFTER INSERT ON "membership"
  FOR EACH ROW EXECUTE FUNCTION "org_member_history_record"();--> statement-breakpoint
-- Backfill: current members, then past ones from the audit log (memberships are audited).
INSERT INTO "org_member_history" ("org_id", "user_id", "first_joined_at")
  SELECT "org_id", "user_id", min("created_at") FROM "membership" GROUP BY "org_id", "user_id"
  ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "org_member_history" ("org_id", "user_id", "first_joined_at")
  SELECT a."org_id", u."id", min(a."at")
  FROM "audit_log" a
  JOIN "organization" o ON o."id" = a."org_id"
  JOIN "user" u ON u."id"::text = a."diff" -> 'userId' ->> 'to'
  WHERE a."action" = 'membership.create'
  GROUP BY a."org_id", u."id"
  ON CONFLICT DO NOTHING;
