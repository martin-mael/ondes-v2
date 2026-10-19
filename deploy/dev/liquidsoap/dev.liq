# Liquidsoap, development placeholder.
#
# Streams a quiet test tone to Icecast at /dev.mp3 so the whole chain can be checked
# end to end. The real station scripts live in engine/templates (#12, #13) and will
# replace this file.
#
# The telnet control server listens on port 1234 inside the compose network only.
# It is never published to the host (CLAUDE.md: control ports are never exposed).

settings.server.telnet := true
settings.server.telnet.bind_addr := "0.0.0.0"
settings.server.telnet.port := 1234

host = environment.get(default="icecast", "ICECAST_HOST")
port = int_of_string(environment.get(default="8000", "ICECAST_PORT"))
password = environment.get(default="ondes-dev-source", "ICECAST_SOURCE_PASSWORD")

radio = mksafe(amplify(0.1, sine(440.)))

output.icecast(
  %mp3(bitrate=128),
  host=host,
  port=port,
  password=password,
  mount="dev.mp3",
  name="Ondes dev",
  description="Development test tone",
  radio
)
