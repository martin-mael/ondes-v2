-- #34: deleting a library asset drops it from its station's safety playlist or emergency slot
-- (foreign key ON DELETE CASCADE). Record that in audit_log, so the removal isn't silent. Removals
-- through the api (the asset still exists) write their own audit row and are skipped here.
CREATE FUNCTION safety_selection_cascade_audit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM asset WHERE id = OLD.asset_id) THEN
    INSERT INTO audit_log (org_id, station_id, actor_type, actor_id, action, entity_type, entity_id, diff)
    VALUES (
      OLD.org_id,
      OLD.station_id,
      'system',
      'asset.delete',
      CASE TG_TABLE_NAME WHEN 'station_safety_asset' THEN 'safety_playlist.remove' ELSE 'emergency_file.set' END,
      'station',
      OLD.station_id::text,
      CASE TG_TABLE_NAME
        WHEN 'station_safety_asset' THEN
          jsonb_build_object('assetIds', jsonb_build_object('from', jsonb_build_array(OLD.asset_id), 'to', NULL))
        ELSE
          jsonb_build_object('assetId', jsonb_build_object('from', OLD.asset_id, 'to', NULL))
      END
    );
  END IF;
  RETURN OLD;
END
$$;
--> statement-breakpoint
CREATE TRIGGER station_safety_asset_cascade_audit AFTER DELETE ON station_safety_asset
  FOR EACH ROW EXECUTE FUNCTION safety_selection_cascade_audit();
--> statement-breakpoint
CREATE TRIGGER station_emergency_asset_cascade_audit AFTER DELETE ON station_emergency_asset
  FOR EACH ROW EXECUTE FUNCTION safety_selection_cascade_audit();
