# opencode-read-aloud

**Reads OpenCode's last answer aloud and highlights each word as it is spoken.** Press `ctrl+s` in a session to start. Press it again to pause or resume.

https://github.com/moritzWa/opencode-read-aloud/raw/demo-video/assets/demo.mp4

<video src="https://github.com/moritzWa/opencode-read-aloud/raw/demo-video/assets/demo.mp4" controls muted="false"></video>

```
     Otters hold hands while they sleep so they don't [drift] apart. Sea otters also keep a
     favorite rock in a skin pouch under their arm for cracking open shellfish.

┃  Build · Claude Opus 5.5 Cursor                                       pause - 1.7x + stop
╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀
```

- The sentence being read gets a faint tint and the current word a stronger one. The transcript scrolls to keep that paragraph on screen.
- Only the answer is read: the text after the last tool call of the latest assistant message. Code blocks, tables and rules are skipped.
- **Option+click** (alt+click) any word of an answer to start reading from that word. This works for older answers too.
- The controls on the prompt row are clickable: play/pause, slower `-`, faster `+`, and stop. On terminals narrower than 80 columns only play/pause and the speed are shown.
- Speed changes keep the pitch and are remembered between sessions. The default is 1.7x.
- On macOS the AirPods button and the keyboard's play/pause key pause and resume reading while it is active, instead of starting your music. This needs the Xcode command line tools (`xcode-select --install`), which compile a small helper on first use. Once reading stops, the keys go back to your music app.
- Audio is cached, so replaying an answer or jumping around in it costs nothing after the first read.

## Requirements

- A [Speechify](https://speechify.ai) or [ElevenLabs](https://elevenlabs.io) API key. Both report when each word is spoken, which is what drives the highlighting. When both keys are set, Speechify is used.
- `ffmpeg` on your `PATH` (`brew install ffmpeg`). It handles seeking and speed changes.

| Provider   | Price per 1M characters                  | Free allowance        | Per typical answer (~1,600 characters) |
| ---------- | ---------------------------------------- | --------------------- | -------------------------------------- |
| Speechify  | $10 (Starter), down to $6                | 500k characters/month | about 1.6¢                             |
| ElevenLabs | $50 pay-as-you-go (Flash)                | 10k characters/month  | about 8¢                               |

Set a key with an environment variable or a key file:

```sh
export SPEECHIFY_API_KEY=sk_...
# or
echo sk_... > ~/.local/share/opencode/speechify.key

export ELEVENLABS_API_KEY=sk_...
# or
echo sk_... > ~/.local/share/opencode/elevenlabs.key
```

Optional:

- Speechify: `SPEECHIFY_VOICE_ID` (default `geffen_32`) and `SPEECHIFY_MODEL_ID` (default `simba-3.2`, English).
- ElevenLabs: `ELEVENLABS_VOICE_ID` (default George, `JBFqnCBsd6RMkjVDRZzb`) and `ELEVENLABS_MODEL_ID` (default `eleven_flash_v2_5`).

## Install

```sh
opencode plugin opencode-read-aloud -g
```

That installs the package into your global OpenCode config and adds it to `tui.json`. Drop `-g` for the current project only. Restart OpenCode afterwards; plugins load at startup.

### Without npm

```sh
git clone https://github.com/moritzWa/opencode-read-aloud ~/.config/opencode/tui-plugins/read-aloud
```

Then add it to `~/.config/opencode/tui.json`:

```json
{
  "plugin": ["./tui-plugins/read-aloud/index.tsx"]
}
```

OpenCode loads the TypeScript source directly, so there is nothing to build.

## Options

```json
{
  "plugin": [
    [
      "opencode-read-aloud",
      {
        "keybinds": { "speech_toggle": "ctrl+s", "speech_faster": "alt+=", "speech_slower": "alt+-" }
      }
    ]
  ]
}
```

| Option      | Default   | Meaning                                                                    |
| ----------- | --------- | -------------------------------------------------------------------------- |
| `keybinds`  | see below | Keys for the commands. `"none"` or `false` unbinds one.                    |
| `placement` | `"right"` | `"right"` puts the controls on the prompt row (`session_prompt_right`). `"footer"` uses a `session_prompt_footer` slot, for OpenCode builds that have one. |

| Keybind          | Default | Command                            |
| ---------------- | ------- | ---------------------------------- |
| `speech_toggle`  | `ctrl+s` | Read the latest answer, or pause and resume |
| `speech_stop`    | none    | Stop reading                       |
| `speech_restart` | none    | Read the answer from the start     |
| `speech_faster`  | none    | Read faster (+0.1x)                |
| `speech_slower`  | none    | Read slower (-0.1x)                |

All five commands are also in the command palette (`ctrl+p`) under "Speech".

## How it works

- **Finding the text.** The plugin walks the rendered transcript for the markdown view whose content matches each answer part. It reads that view's prose blocks: paragraphs, headings and list items.
- **Building the script.** The prose is turned into a plain-text script, with a map from every script character back to its position in the markdown.
- **Speech.** The script goes to Speechify's or ElevenLabs' streaming `with-timestamps` endpoint. Playback starts on the first chunk. ElevenLabs times every character; Speechify times every word, and each character takes the start of its word.
- **Audio.** Audio is piped through `ffmpeg` (for the seek and the `atempo` speed change) into opentui's audio output.
- **Highlighting.** Every 40 ms the playback position is mapped to a word. That word and its sentence are highlighted by extending the block's `onHighlight`, using two styles registered on the block's syntax style and tinted from the theme's primary colour.
- **Cache.** Audio and timings are cached in `~/.cache/opencode/speech/`, keyed by a hash of the voice, the model and the text. A cached reading from either provider is reused before anything new is requested.

## License

MIT
