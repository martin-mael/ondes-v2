# Hard-start spike (#14): a copy of engine/templates/station.liq as of spike #13, with
# spike-only additions marked "HARDSTART". Don't edit the template from here: #27 is
# rewriting it. Additions:
#   - POST /v1/schedule: an engine-timed hard start. The item waits in its own queue and a
#     switch takes the air when time() >= at, fading the interrupted item out.
#   - optional soundtouch tempo per queue item (ondes_tempo), when HARDSTART_STRETCH=1;
#   - audio_pos (source.time of the final mix) in track.started, a clock.sample event
#     every 60 s, and a recorder (POST /spike/record) instead of the Icecast output.
#
# Original header follows.
#
# Ondes station engine: minimal template draft (spike #13).
#
# One Liquidsoap process per station. Node owns the log and feeds this script just in
# time; the script only executes and reports what aired. The engine adapter contract
# (commands, events, payloads, transport) is docs/adr/0002-engine-control.md and
# packages/shared/src/contracts/engine.ts. Keep the three in sync.
#
# Source chain, highest priority first:
#   live (input.harbor, gated by Node) > queue (request.queue fed by Node)
#   > safety playlist > emergency single() > mksafe (silence)
#
# Ports (inside the station's Docker network):
#   ENGINE_CONTROL_PORT (7000)  control API: harbor HTTP + JSON. Internal only, never published.
#   ENGINE_LIVE_PORT    (8005)  input.harbor for live DJs. The only port that may be published.
#   9599                        Prometheus metrics. Internal only.
#
# #27 turns this file into a generated, versioned template. Until then it reads its
# settings from the environment so the spike in engine/spikes/control can drive it.

settings.server.telnet := false
settings.harbor.bind_addrs := ["0.0.0.0"]
settings.prometheus.server := true
settings.prometheus.server.port := 9599
settings.log.stdout := true
settings.log.file := false

def env(name, default) =
  environment.get(default=default, name)
end

station_id = env("STATION_ID", "dev")
control_port = int_of_string(env("ENGINE_CONTROL_PORT", "7000"))
control_token = env("ENGINE_CONTROL_TOKEN", "")
events_url = env("ENGINE_EVENTS_URL", "")
live_port = int_of_string(env("ENGINE_LIVE_PORT", "8005"))
live_mount = env("ENGINE_LIVE_MOUNT", "live")
live_auth_url = env("ENGINE_LIVE_AUTH_URL", "")
live_password = env("ENGINE_LIVE_PASSWORD", "")
safety_dir = env("ENGINE_SAFETY_DIR", "/media/safety")
emergency_file = env("ENGINE_EMERGENCY_FILE", "/media/emergency.wav")
default_cross = float_of_string(env("ENGINE_CROSS_DURATION", "3."))
blank_max = float_of_string(env("ENGINE_BLANK_MAX", "10."))
blank_threshold = float_of_string(env("ENGINE_BLANK_THRESHOLD", "-40."))

# A new id on every start, so Node can tell a restart (seq back to 1) from lost events.
boot_id = "#{int_of_float(time())}-#{random.int(min=100000, max=999999)}"
started_at = time()

# ---------------------------------------------------------------------------------------
# Events: engine -> Node.
#
# Callbacks only append to an in-memory log (cheap, so they can run on the clock thread).
# A separate thread posts new events to ENGINE_EVENTS_URL in order, in batches, and
# retries until Node acknowledges with a 2xx. Node can also pull GET /v1/events?after=N
# to backfill after a gap. The log is written by the clock thread only, and the sender
# only reads it, so the two never race.

# HARDSTART: the audio timeline. The clock thread computes each frame at time() plus a
# scheduling delay that jitters (up to ~100 ms measured), while the audio itself is a
# steady stream: frame n plays at origin + n × frame duration, plus the output's constant
# latency. `clock_origin` is the wall time of audio position 0, estimated from the least
# delayed frame (Liquidsoap sleeps when ahead, so frames are never computed early).
# `frame_pos` is the audio position of the frame being computed, set before each frame.
clock_origin = ref(infinity)
frame_pos = ref(0.)
frame_duration = settings.frame.duration()

def nominal_now() =
  if clock_origin() == infinity then time() else clock_origin() + frame_pos() end
end

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
  now = time()
  e.add("at", now)
  # HARDSTART: json.stringify prints floats with 12 significant digits, so `at` (epoch
  # seconds) only has 10 ms resolution. at_us carries the same instant to the microsecond.
  e.add("at_us", string.float(decimal_places=6, now))
  # HARDSTART: when the event happened on the audio timeline (see clock_origin).
  e.add("at_nominal", string.float(decimal_places=6, nominal_now()))
  e.add("audio_pos", frame_pos())
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
            headers=[("Content-Type", "application/json")],
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
# Sources.

# Node pushes log items here. Requests carry our metadata as annotations:
# ondes_item_id, cue/fade/amplify/cross overrides, title/artist.
queue = request.queue(id="queue")

# Station-local safety rotation, read from the playout cache. Reloaded when files change.
safety =
  playlist(
    id="safety",
    mode="randomize",
    reload_mode="watch",
    prefix="annotate:ondes_source=\"safety\":",
    safety_dir
  )

emergency =
  single(id="emergency", "annotate:ondes_source=\"emergency\":#{emergency_file}")

# liq_amplify must be applied per track before the crossfade mixes two tracks together.
queue_out = amplify(id="queue_gain", override="liq_amplify", 1., queue)

# HARDSTART: optional time-stretch of queue items, tempo from ondes_tempo (1. = unchanged).
# soundtouch keeps the pitch. Off unless HARDSTART_STRETCH=1, so other lanes are untouched.
queue_tempo = ref(1.)
queue_out =
  if
    env("HARDSTART_STRETCH", "0") == "1"
  then
    queue.on_track(
      synchronous=true,
      fun (m) ->
        queue_tempo :=
          if
            list.assoc.mem("ondes_tempo", m)
          then
            float_of_string(m["ondes_tempo"])
          else
            1.
          end
    )
    soundtouch(id="queue_tempo", tempo={queue_tempo()}, queue_out)
  else
    queue_out
  end
safety = amplify(id="safety_gain", override="liq_amplify", 1., safety)

# track_sensitive=false: as soon as Node refills a dry queue, the log takes the air back
# (through the crossfade below) instead of waiting for the safety track to end. It also
# stops the emergency file from sticking at boot, before the first requests resolve.
auto =
  fallback(id="auto", track_sensitive=false, [queue_out, safety, emergency])

# Overlap between two tracks = min(liq_cross_end_duration of the outgoing one,
# liq_cross_start_duration of the incoming one); 0 on both = butt splice (island joins).
# Fades use liq_fade_in / liq_fade_out. Don't use liq_cross_duration: in 2.4.6 it sets
# both ends of the track at once and delays the track's metadata, see ADR 0002.
auto =
  crossfade(
    id="xfade",
    duration=default_cross,
    fade_in=default_cross,
    fade_out=default_cross,
    auto
  )

# HARDSTART: engine-timed hard start. Node pushes the episode to `scheduled` ahead of time
# with POST /v1/schedule {item_id, uri, at}. The gate opens when time() >= at; the switch
# predicate is evaluated once per frame (settings.frame.duration, 20 ms), on the clock
# thread, so the start is frame-accurate whatever Node's timers do. Taking the air fades
# the interrupted automation out over HARDSTART_CUT_FADE seconds while the episode starts
# at full level, then skips the interrupted item so it doesn't resume after the episode.
scheduled = request.queue(id="scheduled")
scheduled_at = ref(infinity)
scheduled_item = ref("")
cut_fade = float_of_string(env("HARDSTART_CUT_FADE", "1."))
# Gate on the audio timeline by default: take the frame whose start is nearest to `at`.
# The switch takes effect one frame after its predicate first holds (measured: +20.0 ms
# on every run), hence a lead of HARDSTART_GATE_LEAD frames (default 1).
# HARDSTART_GATE=wall compares time() at frame computation instead (jittery).
gate_on_wall = env("HARDSTART_GATE", "nominal") == "wall"
gate_lead = float_of_string(env("HARDSTART_GATE_LEAD", "1.")) * frame_duration

def gate_open() =
  if
    gate_on_wall
  then
    time() >= scheduled_at()
  else
    nominal_now() >= scheduled_at() - gate_lead - frame_duration / 2.
  end
end

scheduled_gated =
  switch(id="scheduled_gate", track_sensitive=false, [(gate_open, scheduled)])

def cut_to_scheduled(a, b) =
  # The fade-out keeps pulling `a` for cut_fade seconds; skip it once that's done.
  thread.run(delay=cut_fade + 0.2, fun () -> auto.skip())
  add(normalize=false, [(b : source), (fade.out(duration=cut_fade, a) : source)])
end

def back_to_auto(a, b) =
  add(normalize=false, [fade.in(duration=1., b), fade.out(duration=1., a)])
end

auto =
  fallback(
    id="hardstart",
    track_sensitive=false,
    transitions=[cut_to_scheduled, back_to_auto],
    [scheduled_gated, auto]
  )

# Live input. Auth: Node's webhook if configured, else a single shared password.
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
          headers=[("Content-Type", "application/json")],
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

live =
  input.harbor(
    id="live",
    port=live_port,
    auth=live_auth,
    buffer=5.,
    max=10.,
    live_mount
  )

live_connected = ref(false)

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

# Node decides when a live DJ may take over (live slot, or an ad-hoc override).
live_enabled = ref(false)
live_gated = switch(id="live_gate", track_sensitive=false, [({live_enabled()}, live)])

# Tag above the gate: opening it starts a new track there, and insert_missing gives that
# track metadata, which is what the as-run callback keys on.
live_gated =
  metadata.map(
    insert_missing=true,
    fun (_) -> [("ondes_source", "live")],
    live_gated
  )

radio =
  fallback(
    id="main",
    track_sensitive=false,
    transitions=[
      fun (a, b) -> add(normalize=false, [fade.in(duration=1., b), fade.out(duration=1., a)]),
      fun (a, b) -> add(normalize=false, [fade.in(duration=1., b), fade.out(duration=1., a)])
    ],
    [live_gated, auto]
  )

# ---------------------------------------------------------------------------------------
# As-run: what actually aired, taken after every transition, right before the output.
#
# Keyed on metadata, not on track marks: when a crossfade override is set, Liquidsoap
# emits the track mark at the start of the transition with empty metadata, and the
# incoming track's metadata only when its audio actually starts. A new request id (rid)
# is a new item; sources without requests (live) are keyed by source name.

current = ref(json.object())
current_key = ref("")
current_item = ref("")
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
    d.add("item_id", if current_item() == "" then json.value(null) else json.value(current_item()) end)
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
  d.add("source", src)
  d.add("title", nullable_meta(m, "title"))
  d.add("artist", nullable_meta(m, "artist"))
  d.add("filename", nullable_meta(m, "filename"))
  d.add("rid", nullable_meta(m, "rid"))
  # HARDSTART: position on the engine's audio timeline (seconds produced by the final mix).
  d.add("audio_pos", frame_pos())
  current_item := item
  current_source := src
  current_started := now
  current := d
  emit("track.started", d)
end

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
radio = mksafe(id="safe", radio)
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
# Metrics. Built-in server on 9599 plus a few station gauges.

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
  queue_length_gauge(float(queue.length()))
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
# Control API: harbor HTTP + JSON on ENGINE_CONTROL_PORT.

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
  m = request.metadata(r)
  d = json.object()
  d.add("rid", request.id(r))
  d.add("item_id", nullable_meta(m, "ondes_item_id"))
  d.add("uri", request.uri(r))
  d.add("status", request.status(r))
  d
end

def queue_json() =
  list.map(request_json, queue.queue())
end

def state_json() =
  s = json.object()
  s.add("boot_id", boot_id)
  s.add("station_id", station_id)
  s.add("version", liquidsoap.version)
  s.add("uptime", time() - started_at)
  s.add("seq", event_seq())
  on_air = current()
  # Elapsed comes from our own timestamp. Never call source methods such as remaining()
  # from a handler: they run on the harbor thread, race the clock and, in 2.4.6, can
  # crash the engine (Source.Unavailable). Node knows each item's planned duration.
  if current_started() > 0. then on_air.add("elapsed", time() - current_started()) end
  s.add("on_air", on_air)
  s.add("queue", queue_json())
  l = json.object()
  l.add("enabled", live_enabled())
  l.add("connected", live_connected())
  # Ready once input.harbor has buffered `buffer` seconds; only then can it take the air.
  l.add("ready", live.is_ready())
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
            tempo: float?,
            title: string?,
            artist: string?
          }
      ) = req.body()
      gain =
        if
          null.defined(p.amplify_db)
        then
          [annotation("liq_amplify", "#{string.float(null.get(p.amplify_db))} dB")]
        else
          []
        end
      annotations =
        [
          annotation("ondes_item_id", p.item_id),
          annotation("ondes_source", "queue"),
          ...float_annotation("liq_cue_in", p.cue_in),
          ...float_annotation("liq_cue_out", p.cue_out),
          ...float_annotation("liq_fade_in", p.fade_in),
          ...float_annotation("liq_fade_out", p.fade_out),
          ...float_annotation("liq_cross_start_duration", p.cross_in),
          ...float_annotation("liq_cross_end_duration", p.cross_out),
          ...gain,
          # HARDSTART: time-stretch ratio, read by the optional soundtouch stage.
          ...float_annotation("ondes_tempo", p.tempo),
          ...string_annotation("title", p.title),
          ...string_annotation("artist", p.artist)
        ]
      uri = "annotate:#{string.concat(separator=',', annotations)}:#{p.uri}"
      r = request.create(uri)
      if
        request.resolve(timeout=5., content_type=queue, r)
      then
        queue.push(r)
        reply(res, 201, request_json(r).stringify(compact=true))
      else
        request.destroy(r)
        fail(res, 422, "cannot resolve #{p.uri}")
      end
    catch err do
      fail(res, 400, "invalid push: #{err.message}")
    end
  end
end

def handle_remove(req, res) =
  if
    authorized(req, res)
  then
    item_id = req.query["item_id"]
    matches =
      list.filter(
        fun (r) ->
          begin
            m = request.metadata(r)
            list.assoc.mem("ondes_item_id", m) and m["ondes_item_id"] == item_id
          end,
        queue.queue()
      )
    if
      matches == []
    then
      fail(res, 404, "item #{item_id} is not queued")
    else
      list.iter(queue.remove, matches)
      reply(res, 200, json.stringify({removed=list.length(matches)}))
    end
  end
end

def handle_clear(req, res) =
  if
    authorized(req, res)
  then
    n = queue.length()
    queue.set_queue([])
    reply(res, 200, json.stringify({removed=n}))
  end
end

def handle_skip(req, res) =
  if
    authorized(req, res)
  then
    radio.skip()
    reply(res, 200, json.stringify({skipped=true}))
  end
end

def handle_live(req, res) =
  if
    authorized(req, res)
  then
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
        int_of_string(req.query["after"])
      else
        0
      end
    reply(res, 200, batch_body(events_after(after)))
  end
end

def handle_health(_, res) =
  reply(res, 200, json.stringify({status="ok", boot_id=boot_id, version=liquidsoap.version}))
end

harbor.http.register(port=control_port, method="GET", "/v1/health", handle_health)
harbor.http.register(port=control_port, method="GET", "/v1/state", handle_state)
harbor.http.register(port=control_port, method="GET", "/v1/events", handle_events)
harbor.http.register(port=control_port, method="POST", "/v1/queue", handle_push)
harbor.http.register(port=control_port, method="DELETE", "/v1/queue", handle_clear)
harbor.http.register(port=control_port, method="DELETE", "/v1/queue/:item_id", handle_remove)
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
# Output.

# HARDSTART: no Icecast. output.dummy drives the clock in real time like any non-blocking
# output, and a recorder captures a window around T on demand.
output.dummy(id="air", radio)

rec_path = env("HARDSTART_REC_PATH", "/rec/#{station_id}.wav")
recorder = output.file(id="rec", start=false, %wav(stereo, samplesize=16), rec_path, radio)
recorder.on_start(
  synchronous=true,
  fun () ->
    begin
      d = json.object()
      d.add("path", rec_path)
      emit("rec.started", d)
    end
)
recorder.on_stop(synchronous=true, fun () -> emit("rec.stopped", json.object()))

# Wall clock vs audio clock, every 3000 frames (60 s at 20 ms), on the clock thread.
# Before each frame: the audio timeline and the origin estimate. Every 250 frames (5 s), a
# clock.sample event so the driver can measure the jitter and any drift.
frames = ref(0)
radio.on_frame(
  synchronous=true,
  before=true,
  fun () ->
    begin
      frame_pos := source.time(radio)
      clock_origin := min(clock_origin(), time() - frame_pos())
      frames := frames() + 1
      if
        frames() mod 250 == 0
      then
        d = json.object()
        d.add("frames", frames())
        d.add("origin", string.float(decimal_places=6, clock_origin()))
        emit("clock.sample", d)
      end
    end
)

def handle_schedule(req, res) =
  if
    authorized(req, res)
  then
    try
      let json.parse (p : {item_id: string, uri: string, at: float, title: string?}) =
        req.body()
      annotations =
        [
          annotation("ondes_item_id", p.item_id),
          annotation("ondes_source", "scheduled"),
          ...string_annotation("title", p.title)
        ]
      r = request.create("annotate:#{string.concat(separator=',', annotations)}:#{p.uri}")
      if
        request.resolve(timeout=5., content_type=scheduled, r)
      then
        scheduled.set_queue([])
        scheduled.push(r)
        scheduled_at := p.at
        scheduled_item := p.item_id
        reply(res, 201, request_json(r).stringify(compact=true))
      else
        request.destroy(r)
        fail(res, 422, "cannot resolve #{p.uri}")
      end
    catch err do
      fail(res, 400, "invalid schedule: #{err.message}")
    end
  end
end

def handle_record(req, res) =
  if
    authorized(req, res)
  then
    try
      let json.parse (p : {on: bool}) = req.body()
      if p.on then recorder.start() else recorder.stop() end
      reply(res, 200, json.stringify({recording=p.on}))
    catch err do
      fail(res, 400, "invalid record command: #{err.message}")
    end
  end
end

harbor.http.register(port=control_port, method="POST", "/v1/schedule", handle_schedule)
harbor.http.register(port=control_port, method="POST", "/spike/record", handle_record)
