# A stand-in DJ for the control spike: streams a 1 kHz tone as MP3 to the engine's live
# harbor over the Icecast protocol, like DJ software (Mixxx, BUTT) does. The driver starts
# and stops it through POST /start and POST /stop on port 7001.

settings.server.telnet := false
settings.harbor.bind_addrs := ["0.0.0.0"]

dj =
  output.icecast(
    %mp3(bitrate=128),
    id="dj",
    start=false,
    host=environment.get(default="engine", "LIVE_HOST"),
    port=8005,
    mount="live",
    user="dj1",
    password="secret",
    mksafe(amplify(0.5, sine(1000.)))
  )

harbor.http.register.simple(
  port=7001,
  method="POST",
  "/start",
  fun (_) ->
    begin
      dj.start()
      http.response(data="started")
    end
)

harbor.http.register.simple(
  port=7001,
  method="POST",
  "/stop",
  fun (_) ->
    begin
      dj.stop()
      http.response(data="stopped")
    end
)
