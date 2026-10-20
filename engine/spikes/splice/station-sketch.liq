# Spike sketch: how a station script can play island chains as single tracks while normal
# transitions keep the station crossfade. Not a template: the feeder (#57) and the engine
# templates (#13 and later) own the real thing.
#
# SPLICE_PLAYLIST holds one segment per line, its requests separated by " | ":
#   Z                         a normal song
#   A body | island | B body  an island chain, played as ONE track
#   C                         a normal song
# Each segment is built when the previous one ends, like a feeder pushing log items.

settings.log.stdout := true
settings.log.file := false
settings.log.level := int_of_string(environment.get(default="3", "SPLICE_LOG_LEVEL"))

out_path = environment.get("SPLICE_OUT")
segments =
  list.map(
    fun (line) -> string.split(separator=" \\| ", line),
    list.filter(fun (l) -> l != "", file.lines(environment.get("SPLICE_PLAYLIST")))
  )

# One request, prepared synchronously, with its own gain (amplify must see each request's
# `liq_amplify` as a new track, before the chain is merged).
def one_request(uri) =
  r = request.create(uri)
  taken = ref(false)
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

# A segment: its requests back to back as one track. `merge` does not apply when advancing
# to the last source of the list, hence the trailing `source.fail()`.
def segment(uris) =
  sequence(merge=true, [...list.map(one_request, uris), source.fail()])
end

pending = ref(segments)

def next_segment() =
  l = pending()
  if
    list.is_empty(l)
  then
    null
  else
    pending := list.tl(l)
    log.important(
      label="station",
      "next segment: #{list.hd(l)}"
    )
    segment(list.hd(l))
  end
end

# `self_sync=false`: cross refuses a source that may control its own latency.
radio = source.dynamic(self_sync=false, track_sensitive={true}, next_segment)

# Station crossfade between segments only. It never sees an island join.
radio = crossfade(duration=3., fade_in=3., fade_out=3., radio)

recorder =
  output.file(%wav(stereo=true, samplesize=24), out_path, fallible=true, radio)

recorder.on_stop(synchronous=true, shutdown)
clock.assign_new(id="station", sync="none", [recorder])
