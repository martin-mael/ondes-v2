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
#   live (a pool of input.harbor, one selected by Node) > return file (once, after live)
#   > queue (segments pushed by Node)
#   > safety playlist > emergency loop > mksafe (silence)
# then: processing (compressor, limiter) > as-run > mksafe > blank.detect > outputs.
#
# Ports (inside the station's Docker network):
#   control_port (7000)  control API: harbor HTTP + JSON. Internal only, never published.
#   live_port    (8005)  input.harbor pool for live DJs (one mount per input). Published.
#   live_port+1  (8006)  Shoutcast (ICY) sources, first input only, when live_icy. Published
#                        on a port of its own from the pool (not the live port + 1).
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

# Return file (#64, ADR 0027): played once, first, when the air comes back from a live DJ,
# then the queue. A track of the automation chain like any other, so the station crossfade
# joins it to the log. A fresh request each time, so a replaced file is picked up. Its
# metadata is dropped but for the transition keys: the as-run keeps the live session on air
# until the log's first item. Starts at full level (no fade-in, no overlap with what live
# interrupted): the DJ fades out over it.
return_pending = ref(false)
return_jingle =
  if
    live_input and live_return_file != ""
  then
    taken = ref(false)
    j =
      request.dynamic(
        id="live_return",
        synchronous=true,
        available={return_pending() and not taken()},
        fun () ->
          if
            return_pending() and not taken() and file.exists(live_return_file)
          then
            taken := true
            request.create(
              "annotate:liq_fade_in=\"0.\",liq_cross_start_duration=\"0.\":#{live_return_file}"
            )
          else
            return_pending := false
            null
          end
      )
    j.on_track(
      synchronous=true,
      fun (_) ->
        begin
          return_pending := false
          taken := false
        end
    )
    j =
      metadata.map(
        update=false,
        fun (m) -> list.filter(fun (kv) -> string.contains(prefix="liq_", fst(kv)), m),
        j
      )
    (j : source)
  else
    (source.fail() : source)
  end

# track_sensitive=false: as soon as Node refills a dry queue, the log takes the air back
# (through the crossfade below) instead of waiting for the safety track to end. It also
# stops the emergency file from sticking at boot, before the first requests resolve.
auto = fallback(id="auto", track_sensitive=false, [return_jingle, queue, safety, emergency])
# Before the crossfade: the return from live (#64) cuts the track live interrupted here.
auto_feed = auto

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
# Live input: a pool of harbor inputs and an on-air selector driven by Node (#64, ADR 0027).
#
# `live_inputs` input.harbor sources on live_port, one per mount: `live_mount`, then
# `live_mount-2`, `live_mount-3`… A second DJ connects to a free mount and waits while the
# first is on air. Harbor takes one source per mount. Auth: Node's webhook if configured
# (it checks each DJ's own credentials, #63, and answers with the streamer's id), else the
# shared ENGINE_LIVE_PASSWORD. The webhook carries the control token like the events do.
#
# Node opens the gate on one input (`POST /v1/live {enabled, input, session_id}`); the
# takeover is immediate (track_sensitive=false) with a 1 s crossfade. When the gate closes
# or the DJ on air hangs up, the air goes back to automation: the return file (if any),
# then the queue. The automation track that was on air when the DJ took over is never
# resumed: auto is skipped at the return, so the log restarts with what Node queued for now.
#
# Threads: harbor handlers write live_enabled, live_selected, live_session_* and call
# stop(); the auth callback (harbor thread) writes an input's `pending`; on_connect and
# on_disconnect write `connected` and `streamer`; the clock thread writes live_on_air.

live_enabled = ref(false)
# The input Node put on air; 0: the first ready input of the pool (`POST /v1/live` without
# an input).
live_selected = ref(0)
live_session_id = ref("")
# The session of the previous selection: a handover to a DJ still buffering keeps the DJ on
# air, under their own session, until the new one is ready.
live_previous_session = ref("")
# The input whose audio is on air, 0 when none (written by the clock thread).
live_on_air = ref(0)
# Ends the track on air, whichever branch it comes from (POST /v1/skip).
skip_on_air = ref(fun () -> auto.skip())

def live_mount_of(i) =
  if i == 1 then live_mount else "#{live_mount}-#{i}" end
end

def nullable_string(s) =
  if s == "" then json.value(null) else json.value(s) end
end

# `pending`: the streamer id Node answered with, for the on_connect that follows.
def live_auth(index, connected, pending, login) =
  if
    connected()
  then
    # Harbor takes one source per mount: never let a login replace the DJ on this one.
    false
  elsif live_auth_url != "" then
    try
      body = json.object()
      body.add("user", login.user)
      body.add("password", login.password)
      body.add("address", login.address)
      body.add("input", index)
      r =
        http.post(
          timeout=3.,
          headers=event_headers,
          data=body.stringify(compact=true),
          live_auth_url
        )
      if
        r.status_code >= 200 and r.status_code < 300
      then
        pending :=
          try
            let json.parse (a : {streamer_id: string?}) = r
            a.streamer_id ?? ""
          catch _ do
            ""
          end
        true
      else
        false
      end
    catch err do
      log.important(label="live", "Auth webhook failed: #{err.message}")
      false
    end
  else
    pending := ""
    live_password != "" and login.password == live_password
  end
end

def live_input_of(index) =
  connected = ref(false)
  streamer = ref("")
  pending = ref("")
  s =
    input.harbor(
      id="live_#{index}",
      port=live_port,
      icy=live_icy and index == 1,
      auth=fun (login) -> live_auth(index, connected, pending, login),
      buffer=live_buffer,
      max=live_max,
      live_mount_of(index)
    )

  # Only the headers that describe the client and its stream: never the DJ's credentials
  # (Authorization) or anything else they send.
  def described(h) =
    name = string.case(lower=true, fst(h))
    name == "user-agent"
    or name == "content-type"
    or string.contains(prefix="ice-", name)
    or string.contains(prefix="icy-", name)
  end
  s.on_connect(
    synchronous=true,
    fun (headers) ->
      begin
        connected := true
        streamer := pending()
        d = json.object()
        d.add("input", index)
        d.add("streamer_id", nullable_string(streamer()))
        d.add("headers", list.filter(described, headers))
        emit("live.connected", d)
      end
  )

  s.on_disconnect(
    synchronous=true,
    fun () ->
      begin
        connected := false
        d = json.object()
        d.add("input", index)
        d.add("streamer_id", nullable_string(streamer()))
        streamer := ""
        emit("live.disconnected", d)
      end
  )

  {index=index, mount=live_mount_of(index), connected=connected, streamer=streamer, source=s}
end

live_pool = if live_input then list.init(live_inputs, fun (i) -> live_input_of(i + 1)) else [] end

# Ready once input.harbor has buffered `buffer` seconds; only then can it take the air.
def live_input_ready(inp) =
  inp.connected() and inp.source.is_ready()
end

def live_ready() =
  list.exists(live_input_ready, live_pool)
end

def live_connected() =
  list.exists(fun (inp) -> inp.connected(), live_pool)
end

def live_input_at(i) =
  match = list.filter(fun (inp) -> inp.index == i, live_pool)
  if list.is_empty(match) then null else list.hd(match) end
end

# The input the gate lets through: the selected one once it is ready (none selected: the
# first ready one). While the selected DJ is still buffering, the DJ on air stays on air: a
# handover never drops the air to automation.
def live_gate_input() =
  def ready_at(i) =
    inp = live_input_at(i)
    if null.defined(inp) and live_input_ready(null.get(inp)) then inp else null end
  end
  if
    live_selected() == 0
  then
    ready = list.filter(live_input_ready, live_pool)
    if list.is_empty(ready) then null else list.hd(ready) end
  else
    selected = ready_at(live_selected())
    if
      null.defined(selected)
    then
      selected
    elsif live_on_air() != 0 then ready_at(live_on_air())
    else
      null
    end
  end
end

def live_gate_index() =
  inp = live_gate_input()
  if null.defined(inp) then null.get(inp).index else 0 end
end

def with_live(auto) =
  def live_fade(a, b) =
    add(normalize=false, [fade.in(duration=1., b), fade.out(duration=1., a)])
  end

  # Which DJ: the selected input (or the first ready one). Switching inputs while the gate
  # is open is a handover, with the same crossfade. This switch doesn't look at the gate
  # itself, so the DJ stays available while they fade out when the gate closes.
  gated =
    switch(
      id="live_inputs",
      track_sensitive=false,
      transitions=list.map(fun (_) -> live_fade, live_pool),
      list.map(fun (inp) -> ({live_gate_index() == inp.index}, inp.source), live_pool)
    )

  # What the live branch is tagged with: the as-run callback keys on it.
  def live_tags() =
    inp = live_gate_input()
    if
      null.defined(inp)
    then
      inp = null.get(inp)
      # A DJ held on air during a handover keeps their own session.
      session =
        if
          live_selected() == 0 or live_selected() == inp.index
        then
          live_session_id()
        else
          live_previous_session()
        end
      [
        ("ondes_source", "live"),
        ("ondes_live_input", "#{inp.index}"),
        ("ondes_live_session", session),
        ("ondes_live_streamer", inp.streamer())
      ]
    else
      [("ondes_source", "live")]
    end
  end

  # Tag above the input switch: a handover starts a new track there, and insert_missing gives
  # that track metadata. Below it would not work: harbor inputs run on their own, their track
  # starts when the DJ connects, not when they go on air.
  gated = metadata.map(insert_missing=true, fun (_) -> live_tags(), gated)

  # Taking the air. The automation track on air is faded out under the DJ and frozen
  # there (Liquidsoap doesn't pull a source that isn't selected): it must never come back.
  # A zero end duration is set on it now, while it is still the current track, so that
  # skipping it at the return leaves nothing of it for the crossfade to fade out over
  # what comes next.
  def to_live(a, b) =
    auto_feed.insert_metadata([("liq_cross_end_duration", "0."), ("liq_fade_out", "0.")])
    # Fresh tags for this takeover: the input switch may still be on the same input as the
    # previous show, so no new track (and no metadata) would come from below.
    gated.insert_metadata(live_tags())
    live_fade(a, b)
  end

  # Back from live (gate closed, or the DJ on air hung up). The track live interrupted is
  # dropped, not resumed: its queue segment is aborted (next_segment releases its remaining
  # requests) and it is skipped before the crossfade. The return file, if any, then the
  # queue, which holds what Node queued for now.
  def to_auto(a, b) =
    live_on_air := 0
    current_segment().aborted := true
    auto_feed.skip()
    # What comes back (the return file or the log's next item) starts at full level: when
    # the DJ hung up there is nothing to fade out over, and a fade-in would be near silence.
    auto_feed.insert_metadata([("liq_fade_in", "0."), ("liq_cross_start_duration", "0.")])
    return_pending := true
    live_fade(a, b)
  end

  # The gate: Node decides when a live DJ may take over (live slot, or an ad-hoc override).
  # track_sensitive=false both ways: the takeover and the return are immediate.
  main =
    switch(
      id="live_gate",
      track_sensitive=false,
      # Never replay the previous show's tags when the gate reopens: to_live inserts new ones.
      replay_metadata=false,
      transitions=[to_live, to_auto],
      [({live_enabled() and null.defined(live_gate_input())}, gated), ({true}, auto)]
    )
  main.on_metadata(
    synchronous=true,
    fun (m) ->
      if
        list.assoc.mem("ondes_live_input", m)
      then
        live_on_air := int_of_string(default=0, m["ondes_live_input"])
      end
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
# As-run: what actually aired, taken after every transition, right before the output.
#
# Keyed on metadata, not on track marks: when a crossfade override is set, Liquidsoap
# emits the track mark at the start of the transition with empty metadata, and the
# incoming track's metadata only when its audio actually starts. A new request id (rid)
# is a new item, so every request of a segment (A body, island, B body) gets its own
# track.started although the segment is one track; sources without requests (live) are
# keyed by source name, live by session and input (a handover is a new entry).

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
  elsif
    list.assoc.mem("ondes_live_input", m)
  then
    session =
      if list.assoc.mem("ondes_live_session", m) then m["ondes_live_session"] else "" end
    "live:#{session}:#{m['ondes_live_input']}"
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
  if
    src == "live"
  then
    def live_meta(key) =
      nullable_string(if list.assoc.mem(key, m) then m[key] else "" end)
    end
    d.add("live_session_id", live_meta("ondes_live_session"))
    d.add("live_streamer_id", live_meta("ondes_live_streamer"))
    d.add(
      "live_input",
      if
        list.assoc.mem("ondes_live_input", m)
      then
        json.value(int_of_string(default=0, m["ondes_live_input"]))
      else
        json.value(null)
      end
    )
  end
  current_item := item
  current_segment_id := nullable_meta(m, "ondes_segment_id")
  current_source := src
  current_started := now
  current := d
  emit("track.started", d)
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
# track mark with its metadata but no new rid. Not for live: the gate starts new tracks
# (another input connecting or leaving) while the same DJ stays on air.
radio.on_track(
  synchronous=true,
  fun (m) ->
    begin
      k = air_key(m)
      if
        k != ""
        and k == current_key()
        and not string.contains(prefix="live:", k)
        and time() - current_started() > 1.
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
  l.add("ready", live_ready())
  l.add("selected", if live_selected() == 0 then json.value(null) else json.value(live_selected()) end)
  l.add("on_air", if live_on_air() == 0 then json.value(null) else json.value(live_on_air()) end)
  l.add("session_id", nullable_string(live_session_id()))
  l.add(
    "inputs",
    list.map(
      fun (inp) ->
        begin
          i = json.object()
          i.add("input", inp.index)
          i.add("mount", inp.mount)
          i.add("connected", inp.connected())
          i.add("ready", live_input_ready(inp))
          i.add("streamer_id", nullable_string(inp.streamer()))
          i
        end,
      live_pool
    )
  )
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
            artist: string?
          }
      ) = req.body()
      transitions = [...into_annotations(p), ...out_annotations(p)]
      let (rs, problem) = enqueue([make_request(p, "", transitions)])
      if
        problem != ""
      then
        fail(res, 422, problem)
      else
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
            cross_out: float?
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
    skip = skip_on_air()
    skip()
    reply(res, 200, json.stringify({skipped=true}))
  end
end

# POST /v1/live: opens or closes the gate. Opening names the input to put on air (none: the
# first ready one) and the live session Node opened, reported on the live as-run entries.
# Closing hands the air back to automation, if a DJ was on.
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
        let json.parse (p : {enabled: bool, input: int?, session_id: string?}) = req.body()
        wanted = p.input ?? 0
        if
          wanted < 0 or wanted > live_inputs
        then
          fail(res, 400, "invalid live command: no input #{wanted}")
        else
          if
            p.enabled
          then
            session = p.session_id ?? ""
            if
              session != live_session_id() or wanted != live_selected()
            then
              live_previous_session := live_session_id()
            end
            live_session_id := session
            live_selected := wanted
          end
          live_enabled := p.enabled
          d = json.object()
          d.add("enabled", p.enabled)
          d.add("input", if live_selected() == 0 then json.value(null) else json.value(live_selected()) end)
          d.add("session_id", nullable_string(live_session_id()))
          emit("live.gate", d)
          reply(res, 200, d.stringify(compact=true))
        end
      catch err do
        fail(res, 400, "invalid live command: #{err.message}")
      end
    end
  end
end

# POST /v1/live/disconnect: hangs up the DJ connected to an input (a revoked streamer, a
# kick). If that DJ is on air, automation takes the air back.
def handle_live_disconnect(req, res) =
  if
    authorized(req, res)
  then
    if
      not live_input
    then
      fail(res, 409, "live input is disabled for this station")
    else
      try
        let json.parse (p : {input: int}) = req.body()
        match = list.filter(fun (inp) -> inp.index == p.input, live_pool)
        if
          list.is_empty(match)
        then
          fail(res, 400, "invalid disconnect: no input #{p.input}")
        else
          inp = list.hd(match)
          was = inp.connected()
          inp.source.stop()
          reply(res, 200, json.stringify({disconnected=was}))
        end
      catch err do
        fail(res, 400, "invalid disconnect: #{err.message}")
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
harbor.http.register(
  port=control_port, method="POST", "/v1/live/disconnect", handle_live_disconnect
)

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
