// Holds the macOS Now Playing slot while OpenCode reads aloud, so headphone and
// media keys reach read-aloud instead of the last music app. Reads "playing" or
// "paused" lines on stdin and prints "toggle", "play", "pause"
// or "stop" for each remote command. Exits, releasing the slot, when stdin closes.
import AppKit
import MediaPlayer

setvbuf(stdout, nil, _IOLBF, 0)
let app = NSApplication.shared
app.setActivationPolicy(.prohibited)

let commands = MPRemoteCommandCenter.shared()
let center = MPNowPlayingInfoCenter.default()

func emit(_ event: String) -> MPRemoteCommandHandlerStatus {
  print(event)
  return .success
}

commands.togglePlayPauseCommand.addTarget { _ in emit("toggle") }
commands.playCommand.addTarget { _ in emit("play") }
commands.pauseCommand.addTarget { _ in emit("pause") }
commands.stopCommand.addTarget { _ in emit("stop") }

func publish(_ state: MPNowPlayingPlaybackState) {
  center.nowPlayingInfo = [
    MPMediaItemPropertyTitle: "Reading aloud",
    MPMediaItemPropertyArtist: "OpenCode",
    MPNowPlayingInfoPropertyPlaybackRate: state == .playing ? 1.0 : 0.0,
  ]
  center.playbackState = state
}
publish(.playing)

DispatchQueue.global().async {
  while let line = readLine() {
    DispatchQueue.main.async {
      if line == "playing" { publish(.playing) }
      if line == "paused" { publish(.paused) }
    }
  }
  DispatchQueue.main.async {
    center.nowPlayingInfo = nil
    center.playbackState = .stopped
    exit(0)
  }
}

app.run()
