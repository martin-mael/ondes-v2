# Live auth end-to-end test

Checks the harbor auth callback (#63, ADR 0023) with the real pieces: the station template
rendered with a `live.authUrl`, run in the pinned Liquidsoap image, calling the api's
`createLiveAuthHandler` on a throwaway database. An ffmpeg MP3 Icecast source plays the DJ.

```sh
pnpm dev:up                         # Postgres for the throwaway database
node engine/tests/live-auth/run.ts  # docker + ffmpeg, ~1 min
```

It checks that good credentials connect (and the Shoutcast form, user `source` with
`username:password` as the password), that a wrong password, an unknown username, the shared
`ENGINE_LIVE_PASSWORD`, a disabled streamer and one outside its slots are refused, that the
engine sends its control token (the handler refuses it otherwise) and that accepted logins are
audited. Its own container, ports on random `127.0.0.1` ports; generated files go to `.work/`.
Not in CI yet: run it when you touch the live input, the auth callback or the Liquidsoap version.
