-- #23: library search. Trigram matching (substrings, case and accents folded) over an asset's
-- title, artists and album, and indexes for the library screen's sort orders (keyset pages on
-- (sort value, id) within a station; text sorts on folded values, so "Été" sorts with the E's
-- whatever the collation). Only additive objects: one extension, two functions and indexes;
-- no table rewrite. Used by apps/api/src/modules/library/search-sql.ts, which must call the very
-- same expressions for Postgres to use these indexes.
--
-- Locks: CREATE INDEX takes a SHARE lock on its table (reads go on, writes wait) for as long as
-- it builds. Measured on 50,000 assets: see the PR (#154). On a much larger library, build
-- them CONCURRENTLY by hand before deploying (an ops step: CONCURRENTLY can't run in the
-- migration's transaction); the IF NOT EXISTS below then skips them.
--
-- pg_trgm is a trusted extension: the database owner can create it.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
-- Lower case without accents. translate() is plain (no dictionary, unlike unaccent) but costs
-- a few microseconds a row, so ASCII-only text (most titles) skips it. That matters when a
-- search word is too common or too short for the index and the station's rows are scanned.
CREATE FUNCTION ondes_fold(value text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
  RETURN CASE WHEN octet_length(value) = length(value) THEN lower(value) ELSE
    replace(replace(replace(translate(lower(value),
    'àáâãäåāăąçćčďđèéêëēėęěìíîïīįłñńňòóôõöøōőřŕšśşťùúûüūůűųýÿžźż',
    'aaaaaaaaacccddeeeeeeeeiiiiiilnnnoooooooorrssstuuuuuuuuyyzzz'),
    'œ', 'oe'), 'æ', 'ae'), 'ß', 'ss') END;
--> statement-breakpoint
-- What the search box matches on an asset (tags are matched through the station's tag table).
CREATE FUNCTION ondes_asset_search_text(title text, artists text[], album text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  RETURN ondes_fold(coalesce(title, '') || ' ' || coalesce(array_to_string(artists, ' '), '') || ' ' || coalesce(album, ''));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS asset_search_trgm_idx ON asset USING gin (ondes_asset_search_text(title, artists, album) gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS tag_search_trgm_idx ON tag USING gin (ondes_fold(value) gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS asset_station_title_sort_idx ON asset (station_id, ondes_fold(title), id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS asset_station_artist_sort_idx ON asset (station_id, ondes_fold(coalesce(artists[1], '')), id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS asset_station_album_sort_idx ON asset (station_id, ondes_fold(coalesce(album, '')), id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS asset_station_year_sort_idx ON asset (station_id, coalesce(year, 0), id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS asset_station_duration_sort_idx ON asset (station_id, coalesce(duration_ms, 0), id);
