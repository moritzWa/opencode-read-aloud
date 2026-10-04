import path from "path"
import os from "os"
import { mkdir } from "node:fs/promises"
import { Audio } from "@opentui/core"

// George, the voice ElevenLabs' own docs default to.
const VOICE = process.env.ELEVENLABS_VOICE_ID ?? "JBFqnCBsd6RMkjVDRZzb"
const MODEL = process.env.ELEVENLABS_MODEL_ID ?? "eleven_flash_v2_5"
// The same folders OpenCode itself uses, so the key file and the audio cache are
// shared with OpenCode's own data.
const DATA = path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "opencode")
const DIR = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "opencode", "speech")
const KEY_FILE = path.join(DATA, "elevenlabs.key")

let audio: Audio | null | undefined

function output() {
  if (audio === undefined) audio = createAudio()
  if (!audio) return
  if (!audio.isStarted() && !audio.start()) return
  return audio
}

function createAudio() {
  try {
    const created = Audio.create({ autoStart: false })
    // An "error" event with no listener would throw inside the host.
    created.on("error", () => {})
    return created
  } catch {
    return null
  }
}

/**
 * Synthesized audio for one script. While the request is still streaming,
 * `chunks` and `starts` grow and `next()` resolves on every arrival, so playback
 * can begin on the first chunk. `starts` holds one start time per character of
 * the script, in seconds of 1x audio.
 */
export type Clip = {
  chunks: Uint8Array[]
  starts: number[]
  done: boolean
  error?: Error
  next: () => Promise<void>
}

export type Playback = {
  position: () => number
  stop: () => void
  ended: Promise<void>
}

export async function load(text: string): Promise<Clip> {
  const id = new Bun.CryptoHasher("sha256").update(`${VOICE}\0${MODEL}\0${text}`).digest("hex")
  const audio = Bun.file(path.join(DIR, `${id}.mp3`))
  const meta = Bun.file(path.join(DIR, `${id}.json`))
  if (await meta.exists()) {
    const timing: { starts: number[] } = await meta.json()
    return clip({ chunks: [await audio.bytes()], starts: timing.starts, done: true })
  }

  const key = await apiKey()
  if (!key)
    throw new Error(`Set ELEVENLABS_API_KEY or write the key to ${KEY_FILE}`)
  const result = clip({ chunks: [], starts: [], done: false })
  void synthesize(text, key, result)
    .then(async () => {
      await mkdir(DIR, { recursive: true })
      await Bun.write(audio, new Blob(result.chunks as BlobPart[]))
      await Bun.write(meta, JSON.stringify({ starts: result.starts }))
    })
    .catch((error: unknown) => {
      result.error = error instanceof Error ? error : new Error(String(error))
    })
    .finally(() => result.finish())
  return result
}

/**
 * Plays from `from` seconds of 1x audio at `rate`. ffmpeg does both the seek and
 * the pitch-preserving tempo change, since opentui's audio has neither.
 */
export async function play(source: Clip, from: number, rate: number): Promise<Playback> {
  const ffmpeg = Bun.which("ffmpeg")
  if (!ffmpeg) throw new Error("Reading aloud needs ffmpeg (brew install ffmpeg)")
  const seek = from > 0 ? ["-ss", from.toFixed(3)] : []
  const proc = Bun.spawn(
    [
      ffmpeg,
      "-hide_banner",
      "-loglevel",
      "error",
      ...seek,
      "-f",
      "mp3",
      "-i",
      "pipe:0",
      "-af",
      `atempo=${rate}`,
      "-f",
      "flac",
      "pipe:1",
    ],
    { stdin: "pipe", stdout: "pipe", stderr: "ignore" },
  )
  void feed(source, proc.stdin).catch(() => {})
  const stream = await output()?.playStream(proc.stdout, { format: "flac" })
  if (!stream) {
    proc.kill()
    throw new Error("No audio output device")
  }
  return {
    position: () => {
      const stats = stream.getStats()
      return from + (Number(stats.framesPlayed) / stats.sampleRate) * rate
    },
    stop: () => {
      stream.dispose()
      proc.kill()
    },
    ended: new Promise((resolve) => {
      stream.once("ended", () => resolve())
      stream.once("disposed", () => resolve())
      stream.once("error", () => resolve())
    }),
  }
}

async function synthesize(text: string, key: string, target: ReturnType<typeof clip>) {
  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${VOICE}/stream/with-timestamps?output_format=mp3_44100_128`,
    {
      method: "POST",
      headers: { "xi-api-key": key, "content-type": "application/json" },
      body: JSON.stringify({ text, model_id: MODEL }),
    },
  )
  if (!response.ok || !response.body) throw new Error(`ElevenLabs ${response.status}: ${await response.text()}`)
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ""
  while (true) {
    const chunk = await reader.read()
    if (chunk.done) break
    buffer += chunk.value
    const lines = buffer.split("\n")
    buffer = lines.pop() ?? ""
    lines.forEach((line) => target.push(line))
  }
  target.push(buffer)
}

function clip(input: { chunks: Uint8Array[]; starts: number[]; done: boolean }) {
  const waiting: (() => void)[] = []
  const wake = () => waiting.splice(0).forEach((resolve) => resolve())
  const result = {
    ...input,
    error: undefined as Error | undefined,
    next: () => new Promise<void>((resolve) => waiting.push(resolve)),
    push(line: string) {
      if (!line.trim()) return
      const frame: { audio_base64?: string; alignment?: { character_start_times_seconds?: number[] } } =
        JSON.parse(line)
      if (frame.audio_base64) result.chunks.push(Buffer.from(frame.audio_base64, "base64"))
      result.starts.push(...(frame.alignment?.character_start_times_seconds ?? []))
      wake()
    },
    finish() {
      result.done = true
      wake()
    },
  }
  return result
}

async function feed(source: Clip, sink: Bun.FileSink) {
  let sent = 0
  while (true) {
    while (sent < source.chunks.length) sink.write(source.chunks[sent++])
    await sink.flush()
    if (source.done) {
      await sink.end()
      return
    }
    await source.next()
  }
}

async function apiKey() {
  if (process.env.ELEVENLABS_API_KEY) return process.env.ELEVENLABS_API_KEY
  const file = Bun.file(KEY_FILE)
  if (!(await file.exists())) return
  return (await file.text()).trim()
}
