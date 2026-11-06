# Handoff: UI hill climb (2026-11-06)

For the next session that touches the web app or picks up orchestration. Read `CLAUDE.md` first, then this. `2026-10-28-after-wave-11.md` is still the latest wave handoff: its state, its "left for later" list and its proposed wave 12 (#192, #72, #75, #41, #42, #78) are unchanged, since this work touched only `apps/web`, docs and `CLAUDE.md`.

## Where things stand

- `main` is at `042fa81`. Since wave 11, three web-only PRs merged, none tied to an issue:
  - **#196** UI hill climb, pass 1: grouped nav, one page header, shorter copy, a leaner library asset panel. Report: `docs/ui-hill-climb/README.md`.
  - **#197** pass 2, layout: the page header became the app's top bar, pages got three widths, controls moved next to what they act on. Report: `docs/ui-hill-climb/pass-2/README.md`.
  - **#198** the header bar spans the window, with its actions anchored right. The owner noticed the buttons "floating" mid-bar on `list` and `form` pages after #197.
- Both reports have before/after screenshots (light and dark, 1440×900) and give the reason for each choice.
- **ADRs** still go up to 0042; the next free number is **0043**. The only ADR change: ADR 0009 records the lighter dark `--primary`.
- **Migrations:** 41, unchanged.
- **Open PRs:** #173 (docs: drop AI voice tracks, #97), #183 and #184 (Dependabot). Same as after wave 11.
- **Branches to delete** (merged): `ui-hill-climb`, `ui-pass-2`, `ui-header-anchor`. The worktree `.claude/worktrees/ui-hill-climb` can go too, but it holds the untracked `.claude/ui-hill-climb-test-account.local` (see below). It must never be committed.

## UI conventions now in place

`CLAUDE.md`'s "Web app" section is the reference (see its "Page layout" bullet). In short:

- **Every page** is `<Page width=… header={<PageHeader …/>}>` (`apps/web/src/app/page-header.tsx`).
  - The header is the sticky 64px top bar, level with the sidebar's station switcher.
  - It holds the title, one line of description, a badge, and actions on the right. An optional middle slot holds a page's main control (the library search, the calendar's period).
  - Editors pass a `BackButton` and are titled with the object's name.
  - The sidebar toggle shows only below `md`.
- **Widths:** `full` for tools (calendar, log, grid, library, editors, live), `list` (`max-w-5xl`) for lists, `form` (`max-w-3xl`) for settings.
  - Content is left-aligned; the bar always spans the window.
  - `fill` makes the content exactly the window's height and scroll inside (the calendar's week view, the library). It uses `flex-none` on purpose: `flex-1` would let the page grow.
- **Nav** in four groups: Antenne / Programmation / Contenus / Réglages. One active entry: the deepest path match.
- **Sizes:**
  - Body text is 14px (`text-sm` on `body`).
  - Toolbars use default-size controls, so a row has one height. Don't use the `sm` select (24px, 10px text) next to buttons.
- **Library asset panel:** shows only values that are set, with no "—" rows. "Plus de filtres" is folded.

## How the screenshots were made

The scripts lived in the session scratchpad, which is gone. To redo them:

1. Use Playwright (`playwright-core` with the cached Chromium) against the web dev server.
2. Log in through the api first, then open the 19 station pages plus the library with an asset open.
3. Shoot each page at 1440×900 with `colorScheme` light and dark.
4. Put each before and after side by side with a small HTML page screenshotted by the same browser.
5. For a fair before/after, shoot `main` (from a temporary worktree on another vite port) and the branch back to back, so the clock and the log match.

Use a fixed wait, not `networkidle`: the SSE stream keeps the network busy forever.

**Test account:**
- `ui-hill-climb@ondes.localhost`, admin of the seeded `vandale` org. Its membership was added with SQL with the owner's OK.
- Its credentials are in `.claude/ui-hill-climb-test-account.local` in the `ui-hill-climb` worktree (untracked).
- Logging in many times in a row hits the api's login rate limit (429). Log in once per run, or wait it out.

## Gotchas met

- **The api and worker die after the Mac sleeps:** `AMQPConnectionError: socket timed out (no heartbeat)` from `rabbitmq-client`. The web app then gets 502s. Restart `pnpm --filter @ondes/api --filter @ondes/worker --parallel run dev` with the worktree's `.env` loaded. It also happened twice during the hill climb; worth an issue (reconnect instead of crash).
- **Port 3000 can be taken by another project.**
  - A `vite dev` from `portal-shell.web` (a different repo) bound `127.0.0.1:3000`, while the Ondes api listened on `*:3000`, so `localhost:3000` reached the other server.
  - Don't kill it, it's not ours. Start the web dev server with `VITE_API_PROXY=http://<lan-ip>:3000` (supported by `apps/web/vite.config.ts`) or run the api on another `API_PORT`.
- **The dashboard's engine card** stays on its skeleton when no engine runs locally: the dev api answers 500 for `/engine` and the query retries. That's the dev setup, not the UI. `pnpm dev:engine` gives it real data.
- **The log page** auto-scrolls to the next upcoming item; late in the day there's none, so it stays at the top. Not a bug.

## Left for later (UI)

- **Live page order:** the connection settings (three wide cards and long notes) come before the streamers. That's right for a DJ, wrong for an admin. Splitting the page by role is the owner's call.
- **Dashboard widgets** keep their own heights, so the grid can leave a gap under a short card.
- **Library:** the Tags column cuts long tags at the table's right edge.
- **Station clock in the top bar:** the bar is per page now. A station clock would need the station's event stream above the pages.
- **VT recorder and segue editor** use `Page`/`PageHeader` now, but their status badges and recording controls weren't redesigned.
