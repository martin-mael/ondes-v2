# Encodes a station's fallback loop and intro into each mount's format, for Icecast's webroot
# (deploy/icecast/README.md, "Fallback and intro files"). Run by encode-assets.sh in the
# pinned Liquidsoap image (savonet/liquidsoap:v2.4.6), which every deployment already has.
#
#   OUT             output directory, the stream-assets volume (/assets)
#   JOBS            space-separated `<mount>:<format>:<kind>`, e.g.
#                   "vandale/mp3:mp3:fallback vandale/aac:aac:fallback vandale/mp3:mp3:intro"
#                   format: mp3 | aac | opus | vorbis; kind: fallback | intro
#   FALLBACK_INPUT  the station's emergency loop (any format Liquidsoap decodes)
#   INTRO_INPUT     the intro
# An empty input encodes a test tone instead (tests, dev).
#
# Writes <OUT>/<mount>.<kind>.<ext> (ext: mp3, aac, ogg), the paths the api's config
# generator looks for. Bitrates are fixed per format (encoders are compile-time values):
# MP3 128k, AAC-LC 128k, Opus 96k, Vorbis 128k. A fallback at another bitrate than its mount
# plays fine: players follow the stream's frames, not the mount's nominal bitrate.
settings.log.stdout := true
settings.log.file := false
# Runs as root to write into the volume; it only reads its inputs and writes the outputs.
settings.init.allow_root := true

out_dir = environment.get(default="/assets", "OUT")
jobs = list.filter(fun (j) -> j != "", string.split(separator=" ", environment.get("JOBS")))
pending = ref(list.length(jobs))
if pending() == 0 then
  print("JOBS is empty")
  shutdown(code=1)
end

def done(target) =
  print("wrote #{target}")
  pending := pending() - 1
  if pending() == 0 then shutdown() end
end

def source_for(kind) =
  input_file = environment.get(if kind == "intro" then "INTRO_INPUT" else "FALLBACK_INPUT" end)
  if input_file == "" then
    once(sine(duration=if kind == "intro" then 1. else 4. end, if kind == "intro" then 880. else 220. end))
  else
    once(single(input_file))
  end
end

def encode(job) =
  parts = string.split(separator=":", job)
  mount = list.nth(parts, 0)
  format = list.nth(parts, 1)
  kind = list.nth(parts, 2)
  ext = if format == "mp3" then "mp3" elsif format == "aac" then "aac" else "ogg" end
  target = "#{out_dir}/#{mount}.#{kind}.#{ext}"
  s = source_for(kind)
  on_stop = fun () -> done(target)
  if format == "mp3" then
    ignore(output.file(%mp3(bitrate=128, samplerate=44100, stereo=true), target, fallible=true, on_stop=on_stop, s))
  elsif format == "aac" then
    ignore(output.file(%ffmpeg(format="adts", %audio(codec="aac", b="128k")), target, fallible=true, on_stop=on_stop, s))
  elsif format == "opus" then
    ignore(output.file(%ogg(%opus(bitrate=96, samplerate=48000)), target, fallible=true, on_stop=on_stop, s))
  else
    ignore(output.file(%ogg(%vorbis.cbr(bitrate=128)), target, fallible=true, on_stop=on_stop, s))
  end
end

list.iter(encode, jobs)
