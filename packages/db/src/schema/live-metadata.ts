import type { LiveNowPlayingSource } from '@ondes/shared';
import { sql } from 'drizzle-orm';
import { check, foreignKey, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { liveSession } from './live.ts';
import { station } from './tenancy.ts';

// Live metadata (#68, ADR 0040). Contracts: packages/shared/src/contracts/live-metadata.ts.
//
// One row per live session: the now-playing the streams show while it is on air (`title`,
// `artist`, `source`), and the last metadata the DJ's encoder sent, kept whether or not it
// reached the streams, so allowing it or clearing a manual text can fall back on it. A new
// session (a handover) starts at its own default. The row goes with its session.

export const LIVE_NOW_PLAYING_SOURCES = ['default', 'encoder', 'manual'] as const;

export const liveNowPlaying = pgTable(
  'live_now_playing',
  {
    sessionId: uuid('session_id')
      .primaryKey()
      .references(() => liveSession.id, { onDelete: 'cascade' }),
    orgId: uuid('org_id').notNull(),
    stationId: uuid('station_id').notNull(),
    title: text('title'),
    artist: text('artist'),
    source: text('source').$type<LiveNowPlayingSource>().notNull(),
    encoderTitle: text('encoder_title'),
    encoderArtist: text('encoder_artist'),
    encoderAt: timestamp('encoder_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'live_now_playing_station_org_fk',
      columns: [t.stationId, t.orgId],
      foreignColumns: [station.id, station.orgId],
    }).onDelete('cascade'),
    check(
      'live_now_playing_source_check',
      sql`${t.source} in (${sql.raw(LIVE_NOW_PLAYING_SOURCES.map((v) => `'${v}'`).join(', '))})`,
    ),
  ],
);
