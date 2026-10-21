# Writes the test station's fallback and intro files, in each mount's format, into the
# Icecast webroot volume, then exits. Stand-in for the job that will encode the station's
# emergency loop (see deploy/icecast/README.md).
settings.log.stdout := true
settings.log.file := false

def encode(enc, path, freq, seconds) =
  s = once(sine(duration=seconds, freq))
  output.file(enc, path, fallible=true, on_stop=fun () -> print("wrote #{path}"), s)
end

encode(%mp3(bitrate=128, samplerate=44100, stereo=true), "/assets/it/mp3.fallback.mp3", 220., 4.)
encode(%mp3(bitrate=128, samplerate=44100, stereo=true), "/assets/it/mp3.intro.mp3", 880., 1.)
encode(
  %ffmpeg(format="adts", %audio(codec="aac", b="128k")), "/assets/it/aac.fallback.aac", 220., 4.
)

thread.run(delay=8., shutdown)
