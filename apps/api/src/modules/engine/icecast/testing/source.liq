# The test station's engine as far as Icecast is concerned: the same encoders as the
# station template (apps/api/src/modules/engine/config/render.ts), a non-ASCII stream name.
settings.log.stdout := true
settings.log.file := false

s = mksafe(sine(440.))
password = environment.get("ICECAST_SOURCE_PASSWORD")
name = "Vandale Radió – Lyon"

output.icecast(
  %mp3(bitrate=128, samplerate=44100, stereo=true),
  host="icecast", port=8000, password=password, mount="it/mp3", name=name, s
)
output.icecast(
  %ffmpeg(format="adts", %audio(codec="aac", b="128k")),
  format="audio/aac", host="icecast", port=8000, password=password, mount="it/aac", name=name, s
)
