import {
  DEFAULT_ROTATION_RULES,
  type MyOrg,
  type PickResponse,
  type RotationRule,
} from '@ondes/shared';
import { fireEvent, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  type ApiRoute,
  orgs,
  renderApp,
  signedIn,
  stationId,
} from '../../../app/testing/render.tsx';

// Rotation rules page on the whole app with a fake api: edit and save the ordered rule set,
// see the relaxation ladder, and try a pick whose relaxation is explained.

const at = '2026-10-21T08:00:00.000Z';
const categoryId = '01a15ddf-0000-7000-8000-0000000000c1';
const alpha = '01a15ddf-0000-7000-8000-0000000000d1';
const bravo = '01a15ddf-0000-7000-8000-0000000000d2';
const base = `/stations/${stationId}/rotation`;

// Tokyo: never the browser's timezone here (Paris locally, UTC in CI).
const programmerOrgs: MyOrg[] = orgs.map((org) => ({
  ...org,
  stations: org.stations.map((s) =>
    s.id === stationId ? { ...s, role: 'programmer', timezone: 'Asia/Tokyo' } : s,
  ),
}));

const asProgrammer = (routes: Record<string, ApiRoute> = {}): Record<string, ApiRoute> => ({
  ...signedIn(),
  'GET /orgs': [200, { orgs: programmerOrgs }],
  [`GET ${base}/rules`]: [200, { rules: DEFAULT_ROTATION_RULES, updatedAt: null }],
  [`GET /stations/${stationId}/categories`]: [
    200,
    {
      items: [
        {
          id: categoryId,
          orgId: orgs[0]?.id,
          stationId,
          name: 'House power',
          description: null,
          color: null,
          assetType: 'song',
          rule: null,
          rotationOrder: 'least_recently_played',
          searchDepthPercent: 100,
          restMinutes: 180,
          maxPlaysPerDay: null,
          maxPlaysPerWeek: null,
          createdAt: at,
          updatedAt: at,
          counts: {
            members: 2,
            schedulable: 2,
            ruleMatches: 0,
            manualOnly: 2,
            excluded: 0,
            totalDurationMs: 0,
          },
        },
      ],
    },
  ],
  ...routes,
});

describe('rotation rules', () => {
  it('opens from the nav and shows the ladder of the default rules', async () => {
    const { screen, user, history } = renderApp(`/stations/${stationId}`, asProgrammer());
    await user.click(await screen.findByRole('link', { name: 'Rotation rules' }));
    await waitFor(() => expect(history.location.pathname).toBe(`${base}/rules`));
    expect(await screen.findByText('This station uses the default rules.')).toBeVisible();
    expect(screen.getByTestId('ladder')).toHaveTextContent(
      'Album separation → Artist separation → Search depth → Title separation → Song rest → Max plays per day and week',
    );
  });

  it('hides the nav entry from roles without rotation:read', async () => {
    const { screen } = renderApp(`/stations/${stationId}`, signedIn());
    expect(await screen.findByRole('link', { name: 'Dashboard' })).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Rotation rules' })).toBeNull();
  });

  it('edits, reorders, validates and saves the rule set', async () => {
    const { screen, user, calls } = renderApp(
      `${base}/rules`,
      asProgrammer({
        [`PUT ${base}/rules`]: (body) => [
          200,
          { rules: (body as { rules: RotationRule[] }).rules, updatedAt: at },
        ],
      }),
    );
    const artist = await screen.findByRole('group', { name: 'Artist separation' });
    const value = within(artist).getByLabelText('Separation');
    await user.clear(value);
    await user.type(value, '90');
    await user.selectOptions(within(artist).getByLabelText('Unit'), 'items');

    // Album up above artist: artist is now relaxed first.
    await user.click(screen.getByRole('button', { name: 'Move up: Album separation' }));
    expect(screen.getByTestId('ladder')).toHaveTextContent(
      /^Relaxation order: Artist separation → Album separation/,
    );

    // Max plays may never be relaxed.
    const maxPlays = screen.getByRole('group', { name: 'Max plays per day and week' });
    await user.click(within(maxPlays).getByRole('checkbox', { name: 'May be relaxed' }));
    expect(screen.getByTestId('ladder')).not.toHaveTextContent('Max plays');

    // A tag run without a value is incomplete.
    await user.selectOptions(screen.getByLabelText('Rule to add'), 'tag_run');
    await user.click(screen.getByRole('button', { name: 'Add a rule' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Some rules are incomplete.')).toBeVisible();
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
    const run = screen.getByRole('group', { name: 'Tag run limit' });
    await user.type(within(run).getByLabelText('Value'), '1');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    const put = calls.find((c) => c.method === 'PUT')?.body as { rules: RotationRule[] };
    const saved = put.rules;
    expect(saved.map((r) => [r.kind, r.priority])).toEqual([
      ['max_plays', 1],
      ['song_rest', 2],
      ['title_separation', 3],
      ['search_depth', 4],
      ['album_separation', 5],
      ['artist_separation', 6],
      ['tag_run', 7],
    ]);
    expect(saved[0]).toMatchObject({ breakable: false });
    expect(saved[5]).toMatchObject({ unit: 'items', value: 90 });
    expect(saved[6]).toMatchObject({ tag: { key: 'energy', value: '1' }, maxRun: 2 });
    expect(await screen.findByText('Rules saved.')).toBeVisible();
  });

  it('tries a pick with the draft rules and explains the relaxation', async () => {
    const pick: PickResponse = {
      picks: [
        {
          categoryId,
          at,
          asset: { id: bravo, title: 'Bravo', artists: ['B'], album: null, durationMs: 180_000 },
          relaxed: [{ rule: 'artist_separation', reason: 'artist: blocked 2 of 2 candidates' }],
          unfilled: null,
          candidates: 2,
          ranked: [
            {
              assetId: alpha,
              title: 'Alpha',
              artists: ['A'],
              position: 0,
              lastPlayedAt: null,
              violations: [
                {
                  ruleId: 'artist',
                  kind: 'artist_separation',
                  detail: 'x',
                  values: { minutes: 12, limit: 70 },
                },
                {
                  ruleId: 'song-rest',
                  kind: 'song_rest',
                  detail: 'x',
                  values: { minutes: 12, limit: 180 },
                },
              ],
              notes: [],
              picked: false,
            },
            {
              assetId: bravo,
              title: 'Bravo',
              artists: ['B'],
              position: 1,
              lastPlayedAt: null,
              violations: [
                {
                  ruleId: 'artist',
                  kind: 'artist_separation',
                  detail: 'x',
                  values: { items: 1, limit: 3 },
                },
              ],
              notes: [],
              picked: true,
            },
          ],
        },
      ],
    };
    const { screen, user, calls } = renderApp(
      `${base}/rules`,
      asProgrammer({ [`POST ${base}/pick`]: [200, pick] }),
    );
    await user.click(await screen.findByRole('button', { name: 'Pick' }));
    const result = await screen.findByTestId('pick-result');
    expect(within(result).getByText('Picked: B – Bravo')).toBeVisible();
    const relaxed = within(result).getByTestId('relaxed');
    expect(relaxed).toHaveTextContent('Relaxed: Artist separation');
    expect(relaxed).toHaveTextContent('Same artist 1 songs away (needs 3).');
    expect(within(result).getByTestId('ranked')).toHaveTextContent(
      'Played 12 min away; rest is 180 min.',
    );
    const body = calls.find((c) => c.method === 'POST' && c.path === `${base}/pick`)?.body as {
      slots: { categoryId: string }[];
      rules: RotationRule[];
      explain: boolean;
    };
    expect(body.slots[0]?.categoryId).toBe(categoryId);
    expect(body.rules).toHaveLength(DEFAULT_ROTATION_RULES.length);
    expect(body.explain).toBe(true);
  });

  it('reads the pick time on the station clock, not the browser one', async () => {
    const empty: PickResponse = {
      picks: [
        {
          categoryId,
          at,
          asset: null,
          relaxed: [],
          unfilled: {
            reason: 'unbreakable_rules',
            blockedBy: [{ ruleId: 'artist', kind: 'artist_separation', candidates: 2 }],
          },
          candidates: 2,
          ranked: [],
        },
      ],
    };
    const { screen, user, calls } = renderApp(
      `${base}/rules`,
      asProgrammer({ [`POST ${base}/pick`]: [200, empty] }),
    );
    const time = await screen.findByLabelText('Station time (Asia/Tokyo)');
    fireEvent.change(time, { target: { value: '2026-10-21T10:00' } });
    await user.click(screen.getByRole('button', { name: 'Pick' }));
    const unfilled = await screen.findByTestId('unfilled');
    expect(unfilled).toHaveTextContent(
      'No song can fill this slot: every candidate breaks a rule that may not be relaxed.',
    );
    expect(unfilled).toHaveTextContent('Artist separation blocks 2 of the candidates.');
    const body = calls.find((c) => c.method === 'POST' && c.path === `${base}/pick`)?.body as {
      slots: { at: string }[];
    };
    // 10:00 in Tokyo (UTC+9).
    expect(body.slots[0]?.at).toBe('2026-10-21T01:00:00.000Z');
  });

  it('warns when a rule carrying category settings is off', async () => {
    const { screen, user } = renderApp(`${base}/rules`, asProgrammer());
    const rest = await screen.findByRole('group', { name: 'Song rest' });
    expect(screen.queryByTestId('ignored-settings')).toBeNull();
    await user.click(within(rest).getByRole('checkbox', { name: 'Enabled' }));
    expect(screen.getByTestId('ignored-settings')).toHaveTextContent(
      'Song rest is off: the categories’ rest times are ignored.',
    );
    await user.click(screen.getByRole('button', { name: 'Remove: Max plays per day and week' }));
    expect(screen.getByTestId('ignored-settings')).toHaveTextContent('Max plays is off');
  });
});
