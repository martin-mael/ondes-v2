# ADR 0013: Music categories and smart membership

- Status: accepted
- Date: 2026-10-21
- Issue: #37

## Context
Categories replace AzuraCast playlists for Vandale: a pool of songs with a rotation behaviour, picked from by clock slots (#39) under the rotation rules (#38), with songs moving between categories as they age (#41). Programmers want "smart" categories built from library tags (`style=house AND energy>=3`), plus the occasional song added or kept out by hand. When a song is tagged, the categories it belongs to must follow without anyone pressing a button.

## Decisions

### Membership is resolved, not stored
- A category stores its **rule** and its **manual entries** (`category_member`: `include` or `exclude`), never the list of matching songs.
- Members are computed when asked, by one pure function: `resolveCategory(category, candidates, { at })` in `@ondes/scheduling` (`packages/scheduling/src/categories`). Members = assets of the category's `asset_type` that the rule matches or that are included by hand, minus the manual excludes. It also reports each manual entry's effect (added, excluded, redundant, wrong type) and the counts shown in the UI.
- The api loads the station's candidates (assets with their tags, one query) and runs the resolver for lists, details and previews (`apps/api/src/modules/rotation/repo.ts`: `loadCandidates`, `resolveCategoryMembers`). Schedulers (#38, #50) get members the same way, so the preview, the counts and the log generator can't disagree.
- Why not a materialized membership table: it would need a refresh on every tag, asset and rule change, from the api and the worker, and a stale row would schedule a song that no longer belongs. A station library is thousands to tens of thousands of assets; resolving in memory is a few milliseconds. If that stops being true, a cache keyed by the library's last change can be added behind `resolveCategoryMembers` without changing callers.

### The rule is a JSON boolean tree
- `category.rule` (jsonb, `null` = manual only) is a tree of `all`/`any` groups, at most 3 deep, whose leaves are conditions: `tag` (`any`/`all`/`none` of values, case-insensitive like the tag vocabulary), `tag_number` (a tag value read as a number, e.g. `energy >= 3`), `year`, `explicit`.
- The zod contract (`packages/shared/src/contracts/rotation.ts`) validates it at the api boundary. New condition kinds (e.g. "added less than 4 weeks ago" for #41) are added to the union; stored rules stay valid.
- No query language and no SQL compilation: the same tree is evaluated in one place, and the editor builds it with plain selects.

### Rotation settings on the category
- `rotation_order` (`least_recently_played`, `weighted_random`, `sequential`), `search_depth_percent` (1–100), `rest_minutes`, `max_plays_per_day`/`max_plays_per_week` (nullable). They're stored and validated here; #38 and #50 give them their effect.
- Projected turnover ("each song plays every ~X days") is `schedulable members / plays per day`. Until clocks (#39) say how often a category airs, the preview takes plays per day as an input.

### Extensibility
- Clocks reference `category (id, org_id, station_id)` with a composite foreign key (the same tenant guard as the library tables).
- #38 and #41 add their settings as new columns or tables in `packages/db/src/schema/rotation.ts` and new optional contract fields.

## Consequences
- Every category read loads the station's candidates. Lists resolve all categories against one load.
- A manual entry for a deleted asset disappears with the asset (`ON DELETE CASCADE`).
- An asset outside its start/kill window stays a member but isn't schedulable; counts show both.
