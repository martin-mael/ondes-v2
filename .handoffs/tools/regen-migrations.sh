#!/bin/sh
# During a merge with a conflicting drizzle journal: keep HEAD's journal and snapshots,
# drop the migrations the incoming branch (MERGE_HEAD) added, regenerate one migration per
# dropped one on top of the merged schema, and diff the SQL against the original.
set -eu
cd "$(git rev-parse --show-toplevel)"
tmp=$(mktemp -d)
base=$(git merge-base HEAD MERGE_HEAD)
added=$(git diff --name-only --diff-filter=A "$base" MERGE_HEAD -- 'packages/db/migrations/*.sql')
[ -z "$added" ] && { echo "no incoming migrations"; exit 0; }
git show HEAD:packages/db/migrations/meta/_journal.json > packages/db/migrations/meta/_journal.json
for sql in $added; do
  tag=$(basename "$sql" .sql)
  name=${tag#*_}
  git show "MERGE_HEAD:$sql" > "$tmp/orig-$tag.sql"
  git rm -qf "$sql" "packages/db/migrations/meta/${tag%%_*}_snapshot.json" 2>/dev/null || rm -f "$sql" "packages/db/migrations/meta/${tag%%_*}_snapshot.json"
  echo "regenerating $name (was $tag)"
  pnpm --filter @ondes/db generate --name "$name" >/dev/null 2>&1
  new=$(ls -t packages/db/migrations/ | grep "_$name.sql$" | head -1 || true)
  if [ -z "$new" ]; then
    # Nothing to generate from the schema: a hand-written migration (triggers, backfills).
    pnpm --filter @ondes/db exec drizzle-kit generate --custom --name "$name" >/dev/null 2>&1
    new=$(ls -t packages/db/migrations/ | grep "_$name.sql$" | head -1)
    cp "$tmp/orig-$tag.sql" "packages/db/migrations/$new"
    echo "  custom migration restored -> $new"
    continue
  fi
  new=packages/db/migrations/$new
  if diff -q "$tmp/orig-$tag.sql" "$new" >/dev/null; then
    echo "  identical SQL -> $(basename "$new")"
  else
    echo "  SQL DIFFERS -> $(basename "$new"):"
    diff "$tmp/orig-$tag.sql" "$new" | head -40
  fi
done
git add packages/db/migrations
