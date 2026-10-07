# opencode-read-aloud

**Reads OpenCode's last answer aloud and highlights each word as it is spoken.** Press `ctrl+s` in a session to start. Press it again to pause or resume.

[![OpenCode reading an answer aloud, each word highlighted as it is spoken](assets/demo.gif)](assets/demo.mp4)

The same 20 seconds with sound: [assets/demo.mp4](assets/demo.mp4).

- The sentence being read gets a faint tint and the current word a stronger one. The transcript scrolls to keep that paragraph on screen.
- Only the answer is read: the text after the last tool call of the latest assistant message. Code blocks, tables and rules are skipped, and so are long IDs like session IDs, commit hashes and UUIDs.
- **Option+click** (alt+click) any word of an answer to start reading from that word. This works for older answers too.
- The controls on the prompt row are clickable: play/pause, slower `-`, faster `+`, and stop. On terminals narrower than 80 columns only play/pause and the speed are shown.
- Speed changes keep the pitch and are remembered between sessions. The default is 1.7x.
- On macOS the AirPods button and the keyboard's play/pause key pause and resume reading while it is active, instead of starting your music. This needs the Xcode command line tools (`xcode-select --install`), which compile a small helper on first use. Once reading stops, the keys go back to your music app.
- Speech is synthesized a few sentences ahead of playback, so stopping after the first sentence only pays for the first sentence or two.
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

The voice and model can be changed with the `speechify` and `elevenlabs` [options](#options), or with these environment variables:

- Speechify: `SPEECHIFY_VOICE_ID` (default Dominic, `dominic_32`) and `SPEECHIFY_MODEL_ID` (default `simba-3.2`, English). `GET https://api.speechify.ai/v1/voices` lists the others; `geffen_32` is a female voice made for the same model.
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
        "keybinds": { "speech_toggle": "ctrl+s", "speech_faster": "alt+=", "speech_slower": "alt+-" },
        "speechify": { "voice": "hugh_32" }
      }
    ]
  ]
}
```

| Option      | Default   | Meaning                                                                    |
| ----------- | --------- | -------------------------------------------------------------------------- |
| `keybinds`  | see below | Keys for the commands. `"none"` or `false` unbinds one.                    |
| `placement` | `"right"` | `"right"` puts the controls on the prompt row (`session_prompt_right`). `"footer"` uses a `session_prompt_footer` slot, for OpenCode builds that have one. |
| `speechify` | none | `{ "voice", "model" }` for Speechify. Overrides `SPEECHIFY_VOICE_ID` and `SPEECHIFY_MODEL_ID`. |
| `elevenlabs` | none | `{ "voice", "model" }` for ElevenLabs. Overrides `ELEVENLABS_VOICE_ID` and `ELEVENLABS_MODEL_ID`. |

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
- **Speech.** The script is split after sentence ends into pieces that grow from about 200 characters to 2,000. Each piece goes to Speechify's or ElevenLabs' streaming `with-timestamps` endpoint only when playback is within 8 seconds of the audio so far running out, or when a word in it is clicked. Playback starts on the first chunk. ElevenLabs times every character; Speechify times every word, and each character takes the start of its word. Each piece's timings are shifted by the length of the audio before it, which both providers' constant 128 kbps mp3 gives from its size.
- **Audio.** Audio is piped through `ffmpeg` (for the seek and the `atempo` speed change) into opentui's audio output.
- **Highlighting.** Every 40 ms the playback position is mapped to a word. That word and its sentence are highlighted by extending the block's `onHighlight`, using two styles registered on the block's syntax style and tinted from the theme's primary colour.
- **Cache.** Audio and timings are cached in `~/.cache/opencode/speech/`, one file per piece, keyed by a hash of the voice, the model and the piece's text. A whole-answer reading cached by an earlier version, from either provider, is reused before anything new is requested.

## License

MIT
