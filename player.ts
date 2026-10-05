import path from "path"
import os from "os"
import { mkdir } from "node:fs/promises"
import { Audio } from "@opentui/core"

// The same folders OpenCode itself uses, so the key files and the audio cache are
// shared with OpenCode's own data.
const DATA = path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "opencode")
const DIR = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "opencode", "speech")

type Provider = {
  name: string
  env: string
  keyFile: string
  voice: string
  model: string
  synthesize: (text: string, key: string, voice: string, model: string, target: Target) => Promise<void>
}

// Speechify first: it is about a fifth of ElevenLabs' price and has a free monthly allowance.
const PROVIDERS: Provider[] = [
  {
    name: "speechify",
    env: "SPEECHIFY_API_KEY",
    keyFile: path.join(DATA, "speechify.key"),
    // Dominic, a deep American voice made for simba-3.2.
    voice: process.env.SPEECHIFY_VOICE_ID ?? "dominic_32",
    model: process.env.SPEECHIFY_MODEL_ID ?? "simba-3.2",
    synthesize: speechify,
  },
  {
    name: "elevenlabs",
    env: "ELEVENLABS_API_KEY",
    keyFile: path.join(DATA, "elevenlabs.key"),
    // George, the voice ElevenLabs' own docs default to.
    voice: process.env.ELEVENLABS_VOICE_ID ?? "JBFqnCBsd6RMkjVDRZzb",
    model: process.env.ELEVENLABS_MODEL_ID ?? "eleven_flash_v2_5",
    synthesize: elevenlabs,
  },
]

/** Plugin options `speechify` and `elevenlabs`, each `{ voice, model }`, win over the environment. */
export function configure(options: Record<string, unknown>) {
  for (const provider of PROVIDERS) {
    const settings = options[provider.name]
    if (!settings || typeof settings !== "object") continue
    if ("voice" in settings && typeof settings.voice === "string") provider.voice = settings.voice
    if ("model" in settings && typeof settings.model === "string") provider.model = settings.model
  }
}

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
  // Any provider's cached reading is reused, so an answer heard before keeps its voice.
  for (const provider of PROVIDERS) {
    const cached = files(provider, text)
    if (!(await cached.meta.exists())) continue
    const timing: { starts: number[] } = await cached.meta.json()
    return clip({ chunks: [await cached.audio.bytes()], starts: timing.starts, done: true })
  }

  const found = await firstKey()
  if (!found)
    throw new Error(
      `Set SPEECHIFY_API_KEY or ELEVENLABS_API_KEY, or write the key to ${PROVIDERS.map((p) => p.keyFile).join(" or ")}`,
    )
  const cache = files(found.provider, text)
  const result = clip({ chunks: [], starts: [], done: false })
  void found.provider
    .synthesize(text, found.key, found.provider.voice, found.provider.model, result)
    .then(async () => {
      await mkdir(DIR, { recursive: true })
      await Bun.write(cache.audio, new Blob(result.chunks as BlobPart[]))
      await Bun.write(cache.meta, JSON.stringify({ starts: result.starts }))
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
  // A request that fails before any audio would otherwise reach the decoder as an
  // empty stream and surface as "Audio stream decoder failed" instead of its own error.
  while (!source.chunks.length && !source.done) await source.next()
  if (!source.chunks.length) throw source.error ?? new Error("The speech service returned no audio")
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

/** ElevenLabs streams one JSON object per line, with a start time for every character. */
async function elevenlabs(text: string, key: string, voice: string, model: string, target: Target) {
  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voice}/stream/with-timestamps?output_format=mp3_44100_128`,
    {
      method: "POST",
      headers: { "xi-api-key": key, "content-type": "application/json" },
      body: JSON.stringify({ text, model_id: model }),
    },
  )
  if (!response.ok || !response.body) throw new Error(`ElevenLabs ${response.status}: ${await response.text()}`)
  await lines(response.body, (line) => {
    if (!line.trim()) return
    const frame: { audio_base64?: string; alignment?: { character_start_times_seconds?: number[] } } =
      JSON.parse(line)
    if (frame.audio_base64) target.chunks.push(Buffer.from(frame.audio_base64, "base64"))
    target.starts.push(...(frame.alignment?.character_start_times_seconds ?? []))
    target.wake()
  })
}

/**
 * Speechify streams server-sent events whose speech marks time whole words, in ms, by
 * code point offset into the text. Every character up to a word's end takes that word's
 * start, so a script word that begins inside it, or in the gap before it, gets its time.
 */
async function speechify(text: string, key: string, voice: string, model: string, target: Target) {
  // UTF-16 index of every code point, since the script indexes the string itself.
  const units = [0]
  for (const char of text) units.push(units[units.length - 1] + char.length)
  const response = await fetch("https://api.speechify.ai/v1/audio/stream/with-timestamps", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      // An emoji anywhere makes Speechify drop the last word, audio and all; a space in its
      // place keeps every offset.
      input: text.replace(/\p{Extended_Pictographic}|\p{Emoji_Modifier}|\uFE0F|\u200D/gu, " "),
      voice_id: voice,
      model,
      // Streaming only offers 24 kHz mp3 at most.
      output_format: "mp3_24000_128",
    }),
  })
  if (!response.ok || !response.body) throw new Error(`Speechify ${response.status}: ${await response.text()}`)
  await lines(response.body, (line) => {
    if (!line.startsWith("data:")) return
    const event: {
      type?: string
      audio?: string
      speech_marks?: { start: number; end: number; start_time: number }[]
      error?: { code: string; message: string }
    } = JSON.parse(line.slice(5))
    if (event.type === "speech.error") throw new Error(`Speechify ${event.error?.code}: ${event.error?.message}`)
    if (event.audio) target.chunks.push(Buffer.from(event.audio, "base64"))
    for (const mark of event.speech_marks ?? [])
      while (target.starts.length < (units[mark.end] ?? text.length)) target.starts.push(mark.start_time / 1000)
    target.wake()
  })
}

async function lines(body: NonNullable<Response["body"]>, each: (line: string) => void) {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ""
  while (true) {
    const chunk = await reader.read()
    if (chunk.done) break
    buffer += chunk.value
    const split = buffer.split("\n")
    buffer = split.pop() ?? ""
    split.forEach(each)
  }
  each(buffer)
}

type Target = ReturnType<typeof clip>

function clip(input: { chunks: Uint8Array[]; starts: number[]; done: boolean }) {
  const waiting: (() => void)[] = []
  const result = {
    ...input,
    error: undefined as Error | undefined,
    next: () => new Promise<void>((resolve) => waiting.push(resolve)),
    wake: () => waiting.splice(0).forEach((resolve) => resolve()),
    finish() {
      result.done = true
      result.wake()
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

/** The first provider with a key, from its environment variable or its key file. */
async function firstKey() {
  for (const provider of PROVIDERS) {
    const file = Bun.file(provider.keyFile)
    const key = process.env[provider.env] || ((await file.exists()) ? (await file.text()).trim() : "")
    if (key) return { provider, key }
  }
}

function files(provider: Provider, text: string) {
  const id = new Bun.CryptoHasher("sha256").update(`${provider.voice}\0${provider.model}\0${text}`).digest("hex")
  return { audio: Bun.file(path.join(DIR, `${id}.mp3`)), meta: Bun.file(path.join(DIR, `${id}.json`)) }
}
