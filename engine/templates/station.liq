# Ondes station engine template (#27). Liquidsoap 2.4.6.
#
# One Liquidsoap process per station. Node owns the log and feeds this script just in
# time; the script only executes and reports what aired. The control API (routes,
# payloads, events) is docs/adr/0002-engine-control.md and
# packages/shared/src/contracts/engine.ts. Keep the three in sync.
#
# This file is a template, not a runnable script: apps/api/src/modules/engine/config
# renders it from a station's settings. It replaces the `@ondes:config` marker below with
# the station's constants and the `@ondes:outputs` marker with its Icecast outputs, and
# stamps the result with a config version. `pnpm test:engine` renders it for every
# settings combination in engine/tests/template/combos.ts and runs `liquidsoap --check`.
#
# Source chain, highest priority first:
#   live (input.harbor, gated by Node) > queue (segments pushed by Node)
#   > safety playlist > emergency loop > mksafe (silence)
# with the station crossfade and the voice overlay (the island fallback, #57) under live,
# then: processing (compressor, limiter) > as-run > mksafe > blank.detect > outputs.
#
# Ports (inside the station's Docker network):
#   control_port (7000)  control API: harbor HTTP + JSON. Internal only, never published.
#   live_port    (8005)  input.harbor for live DJs. The only port that may be published.
#   metrics_port (9599)  Prometheus metrics, when metrics_enabled. Internal only, no auth:
#                        the lifecycle (#35) turns it off until something scrapes it.
#
# Secrets never go into the rendered script (it is stored and versioned): they come from
# the container environment.
#   ENGINE_CONTROL_TOKEN     bearer token for the control API (empty: no auth, dev only)
#   ENGINE_LIVE_PASSWORD     shared live password, when no live auth webhook is set
#   ICECAST_SOURCE_PASSWORD  Icecast source password

# @ondes:config

settings.server.telnet := false
settings.harbor.bind_addrs := ["0.0.0.0"]
settings.prometheus.server := metrics_enabled
settings.prometheus.server.port := metrics_port
settings.log.stdout := true
settings.log.file := false

control_token = environment.get(default="", "ENGINE_CONTROL_TOKEN")
live_password = environment.get(default="", "ENGINE_LIVE_PASSWORD")
icecast_password = environment.get(default="", "ICECAST_SOURCE_PASSWORD")

if
  icecast_password == ""
then
  log.critical(label="ondes", "ICECAST_SOURCE_PASSWORD is not set: the outputs cannot connect")
end

# A new id on every start, so Node can tell a restart (seq back to 1) from lost events.
boot_id = "#{int_of_float(time())}-#{random.int(min=100000, max=999999)}"
started_at = time()

# ---------------------------------------------------------------------------------------
# Events: engine -> Node.
#
# Callbacks only append to an in-memory log (cheap, so they can run on the clock thread).
# A separate thread posts new events to events_url in order, in batches, and retries
# until Node acknowledges with a 2xx. Node can also pull GET /v1/events?after=N to
# backfill after a gap. The log is written by the clock thread only (and once at boot,
# below), and the sender only reads it, so the two never race.

event_seq = ref(0)
event_log = ref([])
event_log_max = 1000
sent_seq = ref(0)
send_failures = ref(0)
next_send = ref(0.)

def emit(type, payload) =
  event_seq := event_seq() + 1
  e = json.object()
  e.add("v", 1)
  e.add("seq", event_seq())
  e.add("boot_id", boot_id)
  e.add("station_id", station_id)
  e.add("at", time())
  e.add("type", type)
  e.add("data", payload)
  entry = (event_seq(), e.stringify(compact=true))
  kept = event_log()
  kept =
    if list.length(kept) >= event_log_max then list.tl(kept) else kept end
  event_log := [...kept, entry]
end

def events_after(n) =
  list.filter(fun (e) -> fst(e) > n, event_log())
end

def batch_body(entries) =
  "[" ^ string.concat(separator=",", list.map(snd, entries)) ^ "]"
end

# Back off exponentially (0.2 s to 5 s) while Node is unreachable, log once per outage.
def send_failed(reason) =
  if send_failures() == 0 then log.important(label="events", "#{reason}, retrying") end
  send_failures := send_failures() + 1
  delays = [0.2, 0.5, 1., 2., 5.]
  next_send := time() + list.nth(delays, min(send_failures(), 5) - 1)
end

# The adapter may check that events come from this engine: same token as the control API.
event_headers =
  [
    ("Content-Type", "application/json"),
    ...(if control_token != "" then [("Authorization", "Bearer #{control_token}")] else [] end)
  ]

def flush_events() =
  if
    events_url != "" and time() >= next_send()
  then
    pending = events_after(sent_seq())
    if
      pending != []
    then
      batch = list.prefix(100, pending)
      last = fst(list.last(batch))
      try
        r =
          http.post(
            timeout=2.,
            headers=event_headers,
            data=batch_body(batch),
            events_url
          )
        if
          r.status_code >= 200 and r.status_code < 300
        then
          if send_failures() > 0 then log.important(label="events", "Delivering again") end
          sent_seq := last
          send_failures := 0
        else
          send_failed("Node answered #{r.status_code}")
        end
      catch err do
        send_failed("Posting events failed: #{err.message}")
      end
    end
  end
end

# fast=false: posting is network IO, keep it off the fast scheduler queue.
thread.run(fast=false, every=0.2, flush_events)

def nullable_meta(m, key) =
  if list.assoc.mem(key, m) then json.value(m[key]) else json.value(null) end
end

# ---------------------------------------------------------------------------------------
# Main queue: segments pushed by Node.
#
# A segment is one log item, or an island chain (A body | island | B body, spike #12)
# that must air as ONE track: the station crossfade works in whole frames and drops or
# pads up to a frame at every track boundary it sees, so it must never see an island
# join. Each segment plays as `sequence(merge=true, [...requests, source.fail()])`, with
# `liq_amplify` applied per request inside it (amplify only reads its override on a new
# track, and the merged segment has none at the joins). Node sends cue points already
# snapped to the playout copy's packet grid and biased by half a sample; the template
# passes them through untouched. A single item is a one-request segment.
#
# Threads: harbor handlers are the only writers of `segments` (push, remove, clear) and
# of a segment's `aborted` flag; the clock thread is the only writer of `started_id` and
# `current_segment`. Each side only reads what the other writes, so no write is lost.
# Node's adapter sends commands one at a time.

segments = ref([])
next_segment_id = ref(0)
started_id = ref(0)

def new_segment(requests) =
  next_segment_id := next_segment_id() + 1
  {id=next_segment_id(), requests=requests, left=ref(requests), aborted=ref(false)}
end

current_segment = ref(new_segment([]))

def pending_segments() =
  list.filter(fun (s) -> s.id > started_id(), segments())
end

def pending_requests() =
  list.flatten(list.map(fun (s) -> s.requests, pending_segments()))
end

def meta_of(r, key) =
  m = request.metadata(r)
  if list.assoc.mem(key, m) then m[key] else "" end
end

def item_of(r) =
  meta_of(r, "ondes_item_id")
end

# One request of a segment, with its own gain. `left` holds the requests not taken yet,
# so the clock can release them if the segment is skipped half way.
def segment_request(seg, (r : request)) =
  taken = ref(false)
  amplify(
    override="liq_amplify",
    1.,
    request.dynamic(
      synchronous=true,
      available={not taken() and not seg.aborted()},
      fun () ->
        if
          taken() or seg.aborted()
        then
          null
        else
          taken := true
          seg.left := list.remove(r, seg.left())
          r
        end
    )
  )
end

def segment_source(seg) =
  # `merge` does not apply when advancing to the last source of the list, hence the
  # trailing `source.fail()`, which is never ready.
  sequence(
    id="segment_#{seg.id}",
    merge=true,
    [...list.map(fun (r) -> segment_request(seg, r), seg.requests), source.fail()]
  )
end

# Runs on the clock thread, at every track boundary and while nothing is ready.
def next_segment() =
  pending = pending_segments()
  if
    list.is_empty(pending)
  then
    null
  else
    seg = list.hd(pending)
    done = current_segment()
    # A skipped segment never takes its remaining requests: release them here.
    if done.aborted() then list.iter(request.destroy, done.left()) end
    started_id := seg.id
    current_segment := seg
    segment_source(seg)
  end
end

# self_sync=false: crossfade refuses a source that may control its own latency.
queue = source.dynamic(id="queue", self_sync=false, track_sensitive={true}, next_segment)

# ---------------------------------------------------------------------------------------
# Fallback sources.

# Station-local safety rotation, read from the playout cache. Reloaded when files change.
safety =
  playlist(
    id="safety",
    mode="randomize",
    reload_mode="watch",
    prefix="annotate:ondes_source=\"safety\":",
    safety_dir
  )

# The emergency loop: a fresh request for the file at every loop, so the engine picks up a file
# that appears after boot (single() never does) or is replaced by the playout cache (#34). While
# the file is missing the source isn't ready (retried every second) and mksafe plays silence.
emergency =
  request.dynamic(
    id="emergency",
    retry_delay=1.,
    fun () -> request.create("annotate:ondes_source=\"emergency\":#{emergency_file}")
  )

# liq_amplify must be applied per track before the crossfade mixes two tracks together
# (the queue applies it per request, inside each segment).
safety = amplify(id="safety_gain", override="liq_amplify", 1., safety)

# track_sensitive=false: as soon as Node refills a dry queue, the log takes the air back
# (through the crossfade below) instead of waiting for the safety track to end. It also
# stops the emergency file from sticking at boot, before the first requests resolve.
auto = fallback(id="auto", track_sensitive=false, [queue, safety, emergency])

# Overlap between two tracks = min(liq_cross_end_duration of the outgoing one,
# liq_cross_start_duration of the incoming one). Fades use liq_fade_in / liq_fade_out.
# Don't use liq_cross_duration: in 2.4.6 it sets both ends of the track at once and
# delays the track's metadata, see ADR 0002. A segment is one track here: its first
# request carries the cross/fade into it, its last request the cross/fade out of it.
auto =
  crossfade(
    id="xfade",
    duration=default_cross,
    fade_in=default_cross,
    fade_out=default_cross,
    auto
  )

# ---------------------------------------------------------------------------------------
# Voice overlay (#57, ADR 0024): the degraded path of a voice track whose island is not
# rendered (or not cached) at air time. The transition then airs as the standard
# crossfade, with the voices laid over it and the music ducked while they play. It is
# frame-granular (spike #12): not "what you preview is what airs", but the voice airs.
#
# Node attaches the voices to the queue entry they follow (`overlay` on POST /v1/queue or
# /v1/segment, kept against its last request). When that request goes on air (as-run
# below), each voice is started `at` seconds later. Voices carry no metadata: they are
# part of the transition, not an item on air, so the as-run never sees them. A skip
# cancels the voices of the item it ends.
#
# Threads: harbor handlers write `voice_overlays` (push) and `voice_epoch` (skip), the
# clock thread takes from `voice_overlays` (on air), scheduled tasks write `voice_ducks`.

voice_queue = request.queue(id="voice")
voice_overlays =
  ref(
    (
      [] :
        [
          (
            string
          *
            [
              {
                uri: string,
                at: float,
                duration: float,
                cue_in: float?,
                cue_out: float?,
                amplify_db: float?,
                duck_db: float?
              }
            ]
          )
        ]
    )
  )
voice_ducks = ref([])
voice_epoch = ref(0)
voice_duck = ref(1.)

# Lowest duck of the voices playing, reached smoothly (about 100 ms) to avoid zipper noise.
def voice_duck_gain() =
  target = list.fold(fun (a, d) -> if d < a then d else a end, 1., voice_ducks())
  voice_duck := voice_duck() + (target - voice_duck()) * 0.25
  voice_duck()
end

voices =
  metadata.map(
    id="voices",
    strip=true,
    update=false,
    fun (_) -> [],
    amplify(override="liq_amplify", 1., voice_queue)
  )
# override=null: the duck must not read liq_amplify again (each request already applied its own).
auto =
  add(
    id="overlay",
    normalize=false,
    [amplify(id="duck", override=null, {voice_duck_gain()}, auto), voices]
  )

# ---------------------------------------------------------------------------------------
# Live input (live_input setting). Auth: Node's webhook if configured (it checks each DJ's
# own credentials, #63), else the shared ENGINE_LIVE_PASSWORD. The webhook carries the
# control token like the events do. #64 extends this into a harbor pool.

live_enabled = ref(false)
live_connected = ref(false)
live_ready = ref(fun () -> false)
# Ends the track on air, whichever branch it comes from (POST /v1/skip).
skip_on_air = ref(fun () -> auto.skip())

def live_auth(login) =
  if
    live_auth_url != ""
  then
    try
      body = json.object()
      body.add("user", login.user)
      body.add("password", login.password)
      body.add("address", login.address)
      r =
        http.post(
          timeout=3.,
          headers=event_headers,
          data=body.stringify(compact=true),
          live_auth_url
        )
      r.status_code >= 200 and r.status_code < 300
    catch err do
      log.important(label="live", "Auth webhook failed: #{err.message}")
      false
    end
  else
    live_password != "" and login.password == live_password
  end
end

def with_live(auto) =
  live =
    input.harbor(
      id="live",
      port=live_port,
      auth=live_auth,
      buffer=live_buffer,
      max=live_max,
      live_mount
    )

  # Never forward the DJ's credentials: drop the Authorization header.
  live.on_connect(
    synchronous=true,
    fun (headers) ->
      begin
        live_connected := true
        d = json.object()
        d.add(
          "headers",
          list.filter(fun (h) -> string.case(lower=true, fst(h)) != "authorization", headers)
        )
        emit("live.connected", d)
      end
  )

  live.on_disconnect(
    synchronous=true,
    fun () ->
      begin
        live_connected := false
        emit("live.disconnected", json.object())
      end
  )

  # Ready once input.harbor has buffered `buffer` seconds; only then can it take the air.
  live_ready := fun () -> live.is_ready()

  # Node decides when a live DJ may take over (live slot, or an ad-hoc override).
  gated = switch(id="live_gate", track_sensitive=false, [({live_enabled()}, live)])

  # Tag above the gate: opening it starts a new track there, and insert_missing gives
  # that track metadata, which is what the as-run callback keys on.
  gated = metadata.map(insert_missing=true, fun (_) -> [("ondes_source", "live")], gated)

  def live_fade(a, b) =
    add(normalize=false, [fade.in(duration=1., b), fade.out(duration=1., a)])
  end
  main =
    fallback(
      id="main", track_sensitive=false, transitions=[live_fade, live_fade], [gated, auto]
    )
  skip_on_air := fun () -> main.skip()
  main
end

program = if live_input then (with_live(auto) : source) else (auto : source) end

# ---------------------------------------------------------------------------------------
# Processing (per-station toggles). Before mksafe, so silence passes through untouched.

radio =
  if
    compressor_enabled
  then
    (
      compress(
        id="compressor",
        threshold=compressor_threshold,
        ratio=compressor_ratio,
        attack=compressor_attack,
        release=compressor_release,
        knee=compressor_knee,
        gain=compressor_gain,
        program
      )
    :
      source
    )
  else
    program
  end

radio =
  if
    limiter_enabled
  then
    (limit(id="limiter", threshold=limiter_threshold, release=limiter_release, radio) : source)
  else
    radio
  end

# ---------------------------------------------------------------------------------------
# Voice overlay scheduling (see "Voice overlay" above).

def voice_annotation(k, v, unit) =
  if
    null.defined(v)
  then
    value = string.float(null.get(v)) ^ unit
    ["#{k}=#{string.quote(value)}"]
  else
    []
  end
end

# Starts one voice, unless a skip came since its item went on air. It ducks the music
# for its `duration`.
def start_voice(
  epoch,
  (
    v :
      {
        uri: string,
        at: float,
        duration: float,
        cue_in: float?,
        cue_out: float?,
        amplify_db: float?,
        duck_db: float?
      }
  )
) =
  if
    epoch == voice_epoch()
  then
    annotations =
      [
        ...voice_annotation("liq_cue_in", v.cue_in, ""),
        ...voice_annotation("liq_cue_out", v.cue_out, ""),
        ...voice_annotation("liq_amplify", v.amplify_db, " dB")
      ]
    voice_queue.push(
      request.create("annotate:#{string.concat(separator=',', annotations)}:#{v.uri}")
    )
    duck = lin_of_dB(null.get(default=0., v.duck_db))
    voice_ducks := [...voice_ducks(), duck]
    ignore(
      thread.run(delay=v.duration, fun () -> voice_ducks := list.remove(duck, voice_ducks()))
    )
  end
end

# The request `m` describes just went on air: start the voices kept against it.
def schedule_voices(m) =
  rid = if list.assoc.mem("rid", m) then m["rid"] else "" end
  if
    rid != "" and list.assoc.mem(rid, voice_overlays())
  then
    found = list.assoc(rid, voice_overlays())
    voice_overlays := list.assoc.remove(rid, voice_overlays())
    epoch = voice_epoch()
    list.iter(
      fun (v) ->
        ignore(
          thread.run(
            delay=if v.at > 0. then v.at else 0. end, fun () -> start_voice(epoch, v)
          )
        ),
      found
    )
  end
end

# ---------------------------------------------------------------------------------------
# As-run: what actually aired, taken after every transition, right before the output.
#
# Keyed on metadata, not on track marks: when a crossfade override is set, Liquidsoap
# emits the track mark at the start of the transition with empty metadata, and the
# incoming track's metadata only when its audio actually starts. A new request id (rid)
# is a new item, so every request of a segment (A body, island, B body) gets its own
# track.started although the segment is one track; sources without requests (live) are
# keyed by source name.

current = ref(json.object())
current_key = ref("")
current_item = ref("")
current_segment_id = ref(json.value(null))
current_source = ref("")
current_started = ref(0.)

def air_key(m) =
  if
    list.assoc.mem("rid", m)
  then
    "rid:#{m['rid']}"
  elsif list.assoc.mem("ondes_source", m) then "src:#{m['ondes_source']}"
  else
    ""
  end
end

def on_air(m) =
  now = time()
  current_key := air_key(m)
  if
    current_started() > 0.
  then
    d = json.object()
    d.add(
      "item_id",
      if current_item() == "" then json.value(null) else json.value(current_item()) end
    )
    d.add("segment_id", current_segment_id())
    d.add("source", current_source())
    d.add("started_at", current_started())
    d.add("played", now - current_started())
    emit("track.ended", d)
  end
  item = if list.assoc.mem("ondes_item_id", m) then m["ondes_item_id"] else "" end
  src =
    if
      list.assoc.mem("ondes_source", m)
    then
      m["ondes_source"]
    elsif item != "" then "queue"
    else
      "unknown"
    end
  d = json.object()
  d.add("item_id", if item == "" then json.value(null) else json.value(item) end)
  d.add("segment_id", nullable_meta(m, "ondes_segment_id"))
  d.add("source", src)
  d.add("title", nullable_meta(m, "title"))
  d.add("artist", nullable_meta(m, "artist"))
  d.add("filename", nullable_meta(m, "filename"))
  d.add("rid", nullable_meta(m, "rid"))
  current_item := item
  current_segment_id := nullable_meta(m, "ondes_segment_id")
  current_source := src
  current_started := now
  current := d
  emit("track.started", d)
  schedule_voices(m)
end

# The callbacks go on mksafe's output (the cast sources above have no methods left); its
# own silence carries no metadata, so it never shows up in the as-run.
radio = mksafe(id="safe", radio)

radio.on_metadata(
  synchronous=true,
  fun (m) ->
    begin
      k = air_key(m)
      if k != "" and k != current_key() then on_air(m) end
    end
)

# The same request on air again (a looping single(), a replayed safety file) brings a
# track mark with its metadata but no new rid.
radio.on_track(
  synchronous=true,
  fun (m) ->
    begin
      k = air_key(m)
      if
        k != "" and k == current_key() and time() - current_started() > 1.
      then
        on_air(m)
      end
    end
)

# Silence on the final mix, whatever the source. After mksafe, so that "nothing to play
# at all" (mksafe's silence) is detected too.
radio =
  blank.detect(
    id="blank",
    max_blank=blank_max,
    threshold=blank_threshold,
    track_sensitive=false,
    radio
  )

radio.on_blank(synchronous=true, fun () -> emit("blank.detected", json.object()))
radio.on_noise(synchronous=true, fun () -> emit("blank.recovered", json.object()))

blank_source = radio

# ---------------------------------------------------------------------------------------
# Metrics. Built-in server on metrics_port plus a few station gauges.

queue_length_metric =
  prometheus.gauge(
    help="Requests waiting in the Node-fed queue",
    labels=["station"],
    "ondes_engine_queue_length"
  )
queue_length_gauge = queue_length_metric(label_values=[station_id])
live_metric =
  prometheus.gauge(
    help="1 when a live DJ is connected",
    labels=["station"],
    "ondes_engine_live_connected"
  )
live_gauge = live_metric(label_values=[station_id])
blank_metric =
  prometheus.gauge(
    help="1 while the output is silent",
    labels=["station"],
    "ondes_engine_blank"
  )
blank_gauge = blank_metric(label_values=[station_id])
source_gauge =
  prometheus.gauge(
    help="1 for the source currently on air",
    labels=["station", "source"],
    "ondes_engine_on_air_source"
  )

latency_metric = prometheus.latency(labels=["station"])
latency_metric(label_values=[station_id], radio)

def update_metrics() =
  queue_length_gauge(float(list.length(pending_requests())))
  live_gauge(if live_connected() then 1. else 0. end)
  blank_gauge(if blank_source.is_blank() then 1. else 0. end)
  list.iter(
    fun (s) ->
      begin
        g = source_gauge(label_values=[station_id, s])
        g(if current_source() == s then 1. else 0. end)
      end,
    ["live", "queue", "safety", "emergency", "unknown"]
  )
end

thread.run(every=1., update_metrics)

# ---------------------------------------------------------------------------------------
# Control API: harbor HTTP + JSON on control_port.

# Every reply is a JSON string, so handlers never unify `res.json` over different types.
def reply(res, code, body) =
  res.status_code(code)
  res.content_type("application/json")
  res.data(body)
end

def authorized(req, res) =
  if
    control_token == ""
    or
      (list.assoc.mem("authorization", req.headers)
       and req.headers["authorization"] == "Bearer #{control_token}")
  then
    true
  else
    reply(res, 401, json.stringify({error="unauthorized"}))
    false
  end
end

def fail(res, code, message) =
  reply(res, code, json.stringify({error=message}))
end

def request_json(r) =
  d = json.object()
  d.add("rid", request.id(r))
  m = request.metadata(r)
  d.add("item_id", nullable_meta(m, "ondes_item_id"))
  d.add("segment_id", nullable_meta(m, "ondes_segment_id"))
  d.add("uri", request.uri(r))
  d.add("status", request.status(r))
  d
end

def requests_json(rs) =
  items = list.map(fun (r) -> request_json(r).stringify(compact=true), rs)
  "[" ^ string.concat(separator=",", items) ^ "]"
end

def state_json() =
  s = json.object()
  s.add("boot_id", boot_id)
  s.add("station_id", station_id)
  s.add("version", liquidsoap.version)
  s.add("config_version", config_version)
  s.add("uptime", time() - started_at)
  s.add("seq", event_seq())
  on_air = current()
  # Elapsed comes from our own timestamp. Never call source methods such as remaining()
  # from a handler: they run on the harbor thread, race the clock and, in 2.4.6, can
  # crash the engine (Source.Unavailable). Node knows each item's planned duration.
  if current_started() > 0. then on_air.add("elapsed", time() - current_started()) end
  s.add("on_air", on_air)
  s.add("queue", list.map(request_json, pending_requests()))
  l = json.object()
  l.add("enabled", live_enabled())
  l.add("connected", live_connected())
  is_ready = live_ready()
  l.add("ready", is_ready())
  s.add("live", l)
  s.add("blank", blank_source.is_blank())
  levels = blank_source.dB_levels()
  s.add(
    "output_db",
    if
      null.defined(levels)
    then
      # -inf (digital silence) and nan are not valid JSON: clamp to -120 dBFS.
      json.value(
        list.map(
          fun (x) -> if float.is_nan(x) or x < -120. then -120. else x end,
          null.get(levels)
        )
      )
    else
      json.value(null)
    end
  )
  s
end

# Annotation values are quoted with string.quote; Liquidsoap's annotate parser
# accepts the escaped quotes it produces.
def annotation(k, v) =
  "#{k}=#{string.quote(v)}"
end

def float_annotation(k, v) =
  if null.defined(v) then [annotation(k, string.float(null.get(v)))] else [] end
end

def string_annotation(k, v) =
  if null.defined(v) then [annotation(k, null.get(v))] else [] end
end

# Creates and resolves one request. `transitions`: its crossfade annotations, if any (a
# segment's first part carries the transition into the segment, its last part the
# transition out of it; inside a segment there is no transition at all). Fails with the
# URI when the file can't be resolved.
def make_request(p, segment_id, transitions) =
  gain =
    if
      null.defined(p.amplify_db)
    then
      [annotation("liq_amplify", "#{string.float(null.get(p.amplify_db))} dB")]
    else
      []
    end
  segment = if segment_id != "" then [annotation("ondes_segment_id", segment_id)] else [] end
  annotations =
    [
      annotation("ondes_item_id", p.item_id),
      ...segment,
      annotation("ondes_source", "queue"),
      ...float_annotation("liq_cue_in", p.cue_in),
      ...float_annotation("liq_cue_out", p.cue_out),
      ...transitions,
      ...gain,
      ...string_annotation("title", p.title),
      ...string_annotation("artist", p.artist)
    ]
  r = request.create("annotate:#{string.concat(separator=',', annotations)}:#{p.uri}")
  if
    request.resolve(timeout=5., content_type=queue, r)
  then
    (r, "")
  else
    request.destroy(r)
    (r, p.uri)
  end
end

def into_annotations(t) =
  [
    ...float_annotation("liq_fade_in", t.fade_in),
    ...float_annotation("liq_cross_start_duration", t.cross_in)
  ]
end

def out_annotations(t) =
  [
    ...float_annotation("liq_fade_out", t.fade_out),
    ...float_annotation("liq_cross_end_duration", t.cross_out)
  ]
end

# Queues resolved requests as one segment, or releases them all if one failed (nothing
# is queued). Returns the requests, or the error.
def enqueue(made) =
  missing = list.filter(fun (x) -> snd(x) != "", made)
  if
    not list.is_empty(missing)
  then
    list.iter(fun (x) -> if snd(x) == "" then request.destroy(fst(x)) end, made)
    ([], "cannot resolve #{snd(list.hd(missing))}")
  else
    rs = list.map(fst, made)
    segments := [...pending_segments(), new_segment(rs)]
    (rs, "")
  end
end

# Keeps an entry's voice overlay against its last request, until that request goes on air.
# Overlays of requests no longer queued (removed, cleared) are dropped here.
def remember_voices(rs, overlay) =
  voices = null.get(default=[], overlay)
  if
    not list.is_empty(voices)
  then
    live_rids =
      list.map(
        fun (r) -> string(request.id(r)),
        [...current_segment().requests, ...pending_requests()]
      )
    kept = list.filter(fun (e) -> list.mem(fst(e), live_rids), voice_overlays())
    voice_overlays := [...kept, (string(request.id(list.last(rs))), voices)]
  end
end

# POST /v1/queue: one log item, a one-request segment.
def handle_push(req, res) =
  if
    authorized(req, res)
  then
    try
      let json.parse (
        p :
          {
            item_id: string,
            uri: string,
            cue_in: float?,
            cue_out: float?,
            fade_in: float?,
            fade_out: float?,
            amplify_db: float?,
            cross_in: float?,
            cross_out: float?,
            title: string?,
            artist: string?,
            overlay:
              [
                {
                  uri: string,
                  at: float,
                  duration: float,
                  cue_in: float?,
                  cue_out: float?,
                  amplify_db: float?,
                  duck_db: float?
                }
              ]?
          }
      ) = req.body()
      transitions = [...into_annotations(p), ...out_annotations(p)]
      let (rs, problem) = enqueue([make_request(p, "", transitions)])
      if
        problem != ""
      then
        fail(res, 422, problem)
      else
        remember_voices(rs, p.overlay)
        reply(res, 201, request_json(list.hd(rs)).stringify(compact=true))
      end
    catch err do
      fail(res, 400, "invalid push: #{err.message}")
    end
  end
end

# POST /v1/segment: an island chain (A body, island, B body), aired as one track.
def handle_segment(req, res) =
  if
    authorized(req, res)
  then
    try
      let json.parse (
        s :
          {
            segment_id: string,
            parts:
              [
                {
                  item_id: string,
                  uri: string,
                  cue_in: float?,
                  cue_out: float?,
                  amplify_db: float?,
                  title: string?,
                  artist: string?
                }
              ],
            fade_in: float?,
            fade_out: float?,
            cross_in: float?,
            cross_out: float?,
            overlay:
              [
                {
                  uri: string,
                  at: float,
                  duration: float,
                  cue_in: float?,
                  cue_out: float?,
                  amplify_db: float?,
                  duck_db: float?
                }
              ]?
          }
      ) = req.body()
      if
        list.is_empty(s.parts)
      then
        fail(res, 400, "invalid segment: no parts")
      else
        n = list.length(s.parts)
        made =
          list.mapi(
            fun (i, p) ->
              begin
                into = if i == 0 then into_annotations(s) else [] end
                outro = if i == n - 1 then out_annotations(s) else [] end
                make_request(p, s.segment_id, [...into, ...outro])
              end,
            s.parts
          )
        let (rs, problem) = enqueue(made)
        if
          problem != ""
        then
          fail(res, 422, problem)
        else
          remember_voices(rs, s.overlay)
          reply(
            res,
            201,
            "{\"segment_id\":#{json.stringify(s.segment_id)},\"requests\":#{requests_json(rs)}}"
          )
        end
      end
    catch err do
      fail(res, 400, "invalid segment: #{err.message}")
    end
  end
end

# Drops queued segments (never the one on air) and releases their requests. A segment
# the clock starts in the meantime keeps its requests: it is on air, use skip.
def drop_segments(keep) =
  pending = pending_segments()
  dropped = list.filter(fun (s) -> not keep(s), pending)
  segments := list.filter(keep, pending)
  list.iter(
    fun (s) -> if s.id > started_id() then list.iter(request.destroy, s.requests) end,
    dropped
  )
  list.fold(fun (n, s) -> n + list.length(s.requests), 0, dropped)
end

# DELETE /v1/queue/:id: removes every queued entry whose item_id or segment_id is `id`.
# A segment can't be split: naming one of its parts removes all of it.
def handle_remove(req, res) =
  if
    authorized(req, res)
  then
    wanted = req.query["id"]
    def named(r) =
      item_of(r) == wanted or meta_of(r, "ondes_segment_id") == wanted
    end
    removed = drop_segments(fun (s) -> not list.exists(named, s.requests))
    if
      removed == 0
    then
      fail(res, 404, "#{wanted} is not queued")
    else
      reply(res, 200, json.stringify({removed=removed}))
    end
  end
end

def handle_clear(req, res) =
  if
    authorized(req, res)
  then
    reply(res, 200, json.stringify({removed=drop_segments(fun (_) -> false)}))
  end
end

# Ends whatever is on air. A segment on air ends as a whole: its remaining requests
# (the island, B body) are not played.
def handle_skip(req, res) =
  if
    authorized(req, res)
  then
    if current_source() == "queue" then current_segment().aborted := true end
    # Voices of the item that ends, not yet started, never start.
    voice_epoch := voice_epoch() + 1
    skip = skip_on_air()
    skip()
    reply(res, 200, json.stringify({skipped=true}))
  end
end

def handle_live(req, res) =
  if
    authorized(req, res)
  then
    if
      not live_input
    then
      fail(res, 409, "live input is disabled for this station")
    else
      try
        let json.parse (p : {enabled: bool}) = req.body()
        live_enabled := p.enabled
        d = json.object()
        d.add("enabled", p.enabled)
        emit("live.gate", d)
        reply(res, 200, json.stringify({enabled=p.enabled}))
      catch err do
        fail(res, 400, "invalid live command: #{err.message}")
      end
    end
  end
end

def handle_state(req, res) =
  if authorized(req, res) then reply(res, 200, state_json().stringify(compact=true)) end
end

def handle_events(req, res) =
  if
    authorized(req, res)
  then
    after =
      if
        list.assoc.mem("after", req.query)
      then
        int_of_string(default=0, req.query["after"])
      else
        0
      end
    reply(res, 200, batch_body(events_after(after)))
  end
end

def handle_health(_, res) =
  reply(
    res,
    200,
    json.stringify(
      {
        status="ok",
        boot_id=boot_id,
        version=liquidsoap.version,
        config_version=config_version
      }
    )
  )
end

harbor.http.register(port=control_port, method="GET", "/v1/health", handle_health)
harbor.http.register(port=control_port, method="GET", "/v1/state", handle_state)
harbor.http.register(port=control_port, method="GET", "/v1/events", handle_events)
harbor.http.register(port=control_port, method="POST", "/v1/queue", handle_push)
harbor.http.register(port=control_port, method="POST", "/v1/segment", handle_segment)
harbor.http.register(port=control_port, method="DELETE", "/v1/queue", handle_clear)
harbor.http.register(port=control_port, method="DELETE", "/v1/queue/:id", handle_remove)
harbor.http.register(port=control_port, method="POST", "/v1/skip", handle_skip)
harbor.http.register(port=control_port, method="POST", "/v1/live", handle_live)

emit(
  "engine.started",
  begin
    d = json.object()
    d.add("version", liquidsoap.version)
    d
  end
)

# ---------------------------------------------------------------------------------------
# Outputs: one output.icecast per mount in the station settings. `radio` is the final mix.

# @ondes:outputs
