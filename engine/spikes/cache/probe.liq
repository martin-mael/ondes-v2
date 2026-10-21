# Engine-side probe (spike #15). Resolves each URI in $PROBE_URIS (one per line) the way
# the template's push handler does (`request.resolve` with $PROBE_TIMEOUT), prints one
# `PROBE {json}` line per URI, then plays $PROBE_PLAY (if set) through output.dummy for
# $PROBE_PLAY_SECONDS and reports what was decoded.
settings.log.level := 3
settings.log.stdout := true

uris = list.filter(fun (u) -> u != "", string.split(separator="\n", environment.get("PROBE_URIS")))
timeout = float_of_string(environment.get(default="5.", "PROBE_TIMEOUT"))

def probe(uri) =
  t0 = time()
  r = request.create(uri)
  ok = request.resolve(timeout=timeout, r)
  t1 = time()
  fname = null.get(default="", request.filename(r))
  size = if ok then file.size(fname) else -1 end
  dur = if ok then null.get(default=-1., request.duration(fname)) else -1. end
  print(
    "PROBE " ^
      json.stringify(compact=true, 
        {
          uri=uri,
          ok=ok,
          resolve_ms=(t1 - t0) * 1000.,
          local=fname,
          bytes=size,
          duration=dur
        }
      )
  )
  request.destroy(r)
end

play_uri = environment.get("PROBE_PLAY")
play_seconds = float_of_string(environment.get(default="0.", "PROBE_PLAY_SECONDS"))
played = ref(0.)
tracks = ref(0)

s =
  if
    play_uri != ""
  then
    q = request.queue()
    q.push.uri(play_uri)
    q.on_track(synchronous=true, fun (_) -> tracks := tracks() + 1)
    q
  else
    blank()
  end
s = mksafe(s)
s.on_frame(synchronous=true, fun () -> played := played() + settings.frame.duration())
output.dummy(s)

thread.run(
  delay=0.,
  fun () ->
    begin
      list.iter(probe, uris)
      if
        play_uri != ""
      then
        thread.run(
          delay=play_seconds,
          fun () ->
            begin
              print(
                "PROBE " ^
                  json.stringify(compact=true, 
                    {play=play_uri, tracks=tracks(), seconds=played(), on_air=s.is_ready()}
                  )
              )
              shutdown()
            end
        )
      else
        shutdown()
      end
    end
)
