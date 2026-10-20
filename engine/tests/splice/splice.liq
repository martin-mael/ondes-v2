# Splice test harness: plays a playlist of `annotate:` requests (A body, island, B body)
# and records the engine output to a WAV file, as fast as the CPU allows.
#
# Environment:
#   SPLICE_PLAYLIST  one annotate: request per line (written by run.ts)
#   SPLICE_OUT       output WAV path
#   SPLICE_MODE      none      plain sequence, no transition operator at all
#                    segment   the island chain merged into one track, then the station
#                              crossfade (what the engine should do)
#                    crossfade stdlib `crossfade` with station-like 3 s defaults; the
#                              island joins override it through track metadata
#                    cross     `cross` with the custom micro-crossfade transition below
#   SPLICE_FRAME     optional frame duration in seconds (default: Liquidsoap's 0.02)

settings.log.stdout := true
settings.log.file := false
settings.log.level := int_of_string(environment.get(default="3", "SPLICE_LOG_LEVEL"))

frame_duration = environment.get(default="", "SPLICE_FRAME")
if
  frame_duration != ""
then
  settings.frame.duration := float_of_string(frame_duration)
end

# Decoder override, e.g. SPLICE_DECODER=flac to prefer the native libFLAC decoder over
# ffmpeg (the default winner, priority 10).
preferred_decoder = environment.get(default="", "SPLICE_DECODER")
if preferred_decoder == "flac" then settings.decoder.priorities.flac := 100 end
if preferred_decoder == "mad" then settings.decoder.priorities.mad := 100 end
if preferred_decoder == "faad" then settings.decoder.priorities.aac := 100 end
if preferred_decoder == "mp4" then settings.decoder.priorities.mp4 := 100 end

playlist_path = environment.get("SPLICE_PLAYLIST")
out_path = environment.get("SPLICE_OUT")
mode = environment.get(default="none", "SPLICE_MODE")

# Every request is resolved (and its file checked) before the clock starts.
requests =
  list.map(
    fun (uri) ->
      begin
        r = request.create(uri)
        if
          not request.resolve(r)
        then
          log.critical(
            label="splice",
            "could not resolve #{uri}"
          )
          exit(2)
        end
        r
      end,
    list.filter(fun (l) -> l != "", file.lines(playlist_path))
  )

# Requests are prepared synchronously, when needed: the clock is unsynced (see below), and
# an asynchronous queue would not have the next track ready in time, ending the output early.
pending = ref(requests)

def next_request() =
  l = pending()
  if
    list.is_empty(l)
  then
    null
  else
    pending := list.tl(l)
    list.hd(l)
  end
end

queue =
  request.dynamic(
    id="tracks",
    synchronous=true,
    available={not list.is_empty(pending())},
    next_request
  )

# `segment`: the island chain (A body, island, B body) is merged into ONE track before the
# station crossfade, so `cross` never sees the island joins. Each request gets its own
# synchronous request.dynamic; `sequence(merge=true)` plays them back to back.
def one_request(r) =
  taken = ref(false)
  # The gain is applied per request, before merging: `amplify` only picks up
  # `liq_amplify` on a new track, and the merged segment has none at the joins.
  amplify(
    override="liq_amplify",
    1.,
    request.dynamic(
      synchronous=true,
      available={not taken()},
      fun () ->
        if
          taken()
        then
          null
        else
          taken := true
          r
        end
    )
  )
end

queue =
  if
    mode == "segment"
  then
    # `merge` does not apply when advancing to the last source of the list, hence the
    # trailing `source.fail()`, which is never ready.
    (sequence(id="segment", merge=true, [...list.map(one_request, requests), source.fail()]) : source)
  else
    (queue : source)
  end

# Per-track loudness gain, applied before any transition, exactly like the station (the
# segment already applied it per request).
tracks =
  if
    mode == "segment"
  then
    queue
  else
    (amplify(id="gain", override="liq_amplify", 1., queue) : source)
  end

# Micro-crossfade for island joins: complementary linear fades over the handle. Both
# sides hold the same audio, so a linear (equal-gain) sum reproduces it exactly.
# The fade duration is the cross duration of the outgoing track (`liq_cross_duration`).
def micro(a, b) =
  d = float_of_string(default=0.01, list.assoc(default="0.01", "liq_cross_duration", a.metadata))
  log.important(
    label="splice",
    "micro-crossfade: #{d}s"
  )
  add(
    normalize=false,
    [
      fade.in(type="lin", duration=d, override_duration="", override_type="", b.source),
      fade.out(type="lin", duration=d, override_duration="", override_type="", a.source)
    ]
  )
end

radio =
  if
    mode == "crossfade" or mode == "segment"
  then
    (crossfade(duration=3., fade_in=3., fade_out=3., tracks) : source)
  elsif mode == "cross" then (cross(duration=3., micro, tracks) : source)
  else
    (tracks : source)
  end

recorder =
  output.file(%wav(stereo=true, samplesize=24), out_path, fallible=true, radio)

recorder.on_stop(synchronous=true, shutdown)

# Run as fast as the CPU allows: this is an offline render, not a live stream.
clock.assign_new(id="splice", sync="none", [recorder])
