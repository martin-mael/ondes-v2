-- Custom SQL migration (#44): an episode whose asset goes away can't stay `ready`.
-- `episode.asset_id` is `on delete set null`; the referential action is an UPDATE of the
-- episode row, so this BEFORE trigger turns `ready` back into `planned` in the same statement
-- and `episode_ready_asset_check` holds. The api does the same on its own updates.
CREATE FUNCTION episode_asset_cleared() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.asset_id IS NULL AND NEW.status = 'ready' THEN
    NEW.status := 'planned';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER episode_asset_cleared
  BEFORE UPDATE OF asset_id ON episode
  FOR EACH ROW EXECUTE FUNCTION episode_asset_cleared();
