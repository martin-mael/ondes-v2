-- #23: library search. Trigram matching (substrings, case and accents folded) over an asset's
-- title, artists and album, and indexes for the library screen's sort orders (keyset pages on
-- (sort value, id) within a station; text sorts on folded values, so "Été" sorts with the E's
-- whatever the collation). Only additive objects: extensions, two functions, a
-- generated column and indexes. Used by apps/api/src/modules/library/search-sql.ts, which must call the very same
-- expressions for Postgres to use these indexes.
--
-- pg_trgm and unaccent are trusted extensions: the database owner can create them.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS unaccent;
--> statement-breakpoint
-- unaccent() is only STABLE (it reads its dictionary by name); with the dictionary given
-- explicitly the result never changes, so this wrapper is safe to declare IMMUTABLE and to index.
CREATE FUNCTION ondes_fold(value text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
  RETURN lower(public.unaccent('public.unaccent'::regdictionary, value));
--> statement-breakpoint
-- What the search box matches on an asset (tags are matched through the station's tag table).
CREATE FUNCTION ondes_asset_search_text(title text, artists text[], album text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  RETURN ondes_fold(coalesce(title, '') || ' ' || coalesce(array_to_string(artists, ' '), '') || ' ' || coalesce(album, ''));
--> statement-breakpoint
-- Stored, so a search compares plain text instead of folding every row (unaccent is slow).
-- Not declared in the Drizzle schema on purpose: the repositories never read it, and asset
-- rows (API answers, audit diffs) stay as they are. Adding it rewrites the table once.
ALTER TABLE asset ADD COLUMN search_text text GENERATED ALWAYS AS (ondes_asset_search_text(title, artists, album)) STORED;
--> statement-breakpoint
CREATE INDEX asset_search_trgm_idx ON asset USING gin (search_text gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX tag_search_trgm_idx ON tag USING gin (ondes_fold(value) gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX asset_station_title_sort_idx ON asset (station_id, ondes_fold(title), id);
--> statement-breakpoint
CREATE INDEX asset_station_artist_sort_idx ON asset (station_id, ondes_fold(coalesce(artists[1], '')), id);
--> statement-breakpoint
CREATE INDEX asset_station_album_sort_idx ON asset (station_id, ondes_fold(coalesce(album, '')), id);
--> statement-breakpoint
CREATE INDEX asset_station_year_sort_idx ON asset (station_id, coalesce(year, 0), id);
--> statement-breakpoint
CREATE INDEX asset_station_duration_sort_idx ON asset (station_id, coalesce(duration_ms, 0), id);
