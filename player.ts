import path from "path"
import os from "os"
import { mkdir } from "node:fs/promises"
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs"
import { Audio } from "@opentui/core"

// The same folders OpenCode itself uses, so the key files and the audio cache are
// shared with OpenCode's own data.
const DATA = path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "opencode")
const DIR = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "opencode", "speech")

// Answers are synthesized a piece at a time, just ahead of playback, since the services
// bill every character sent and most readings stop after a sentence or two. Pieces end
// on a sentence and grow from the first, which is small so playback starts quickly.
const FIRST_PIECE = 200
const MAX_PIECE = 2000
// Seconds of 1x audio left before the next piece is requested.
const LEAD = 8
// Both providers are asked for constant 128 kbps mp3, so a piece's length is its size.
const BYTES_PER_SECOND = 128_000 / 8
// Audio decoded and waiting for this long without a frame reaching the speakers means the
// output is dead, as after the default device switches to AirPods under a running engine.
const STALL_MS = 2500
// A speech request with no response headers, or no new bytes, for this long has hung.
const HEADERS_MS = 20_000
const IDLE_MS = 30_000

// Next to OpenCode's own log, since the plugin's only other channel is a toast.
const LOG = path.join(DATA, "log", "read-aloud.log")
const LOG_MAX = 1_000_000

/** Appends one line to the log, rotating it to `.1` past LOG_MAX. Never throws. */
export function log(event: string, data: Record<string, unknown> = {}) {
  try {
    mkdirSync(path.dirname(LOG), { recursive: true })
    if ((statSync(LOG, { throwIfNoEntry: false })?.size ?? 0) > LOG_MAX) renameSync(LOG, `${LOG}.1`)
    appendFileSync(LOG, `${new Date().toISOString()} pid=${process.pid} ${event} ${JSON.stringify(data)}\n`)
  } catch {}
}

// ffmpeg ignores SIGTERM while blocked writing to a pipe nobody reads, so every stop
// kills it outright, and anything still running dies with the TUI.
const children = new Set<Bun.Subprocess>()
process.once("exit", () => children.forEach((child) => child.kill("SIGKILL")))

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
// The default output when the engine started; the engine stays on that device.
let device: string | undefined

function output() {
  if (audio && defaultDevice(audio) !== device) {
    log("device-changed", { from: device, to: defaultDevice(audio) })
    resetAudio()
  }
  if (audio === undefined) audio = createAudio()
  if (!audio) return
  if (!audio.isStarted() && !audio.start()) {
    log("engine-start-failed")
    return
  }
  device ??= defaultDevice(audio)
  return audio
}

/** Drops the engine so the next playback opens a fresh one on the current default device. */
function resetAudio() {
  try {
    audio?.dispose()
  } catch {}
  audio = undefined
  device = undefined
}

function defaultDevice(engine: Audio) {
  try {
    return engine.listPlaybackDevices()?.find((entry) => entry.isDefault)?.name
  } catch {}
}

function createAudio() {
  try {
    const created = Audio.create({ autoStart: false })
    // An "error" event with no listener would throw inside the host.
    created.on("error", (error, context) => log("engine-error", { action: context.action, error: error.message }))
    return created
  } catch (error) {
    log("engine-create-failed", { error: String(error) })
    return null
  }
}

/**
 * Synthesized audio for one script. While the request is still streaming,
 * `chunks` and `starts` grow and `next()` resolves on every arrival, so playback
 * can begin on the first chunk. `starts` holds one start time per character of
 * the script, in seconds of 1x audio. Nothing past the first piece is synthesized
 * until `ahead` reports playback near it or `need` asks for a character in it.
 */
export type Clip = {
  chunks: Uint8Array[]
  starts: number[]
  done: boolean
  error?: Error
  next: () => Promise<void>
  ahead: (time: number) => void
  need: (char: number) => void
}

export type Playback = {
  position: () => number
  stop: () => void
  /** "stalled" when the output stopped taking audio; the engine is already reset for a retry. */
  ended: Promise<"ended" | "stalled">
}

export async function load(text: string): Promise<Clip> {
  // Any provider's cached reading is reused, so an answer heard before keeps its voice.
  for (const provider of PROVIDERS) {
    const cached = files(provider, text)
    if (!(await cached.meta.exists())) continue
    const timing: { starts: number[] } = await cached.meta.json()
    log("load", { provider: provider.name, chars: text.length, cached: true })
    return clip({ chunks: [await cached.audio.bytes()], starts: timing.starts, done: true })
  }

  const found = await firstKey()
  if (!found)
    throw new Error(
      `Set SPEECHIFY_API_KEY or ELEVENLABS_API_KEY, or write the key to ${PROVIDERS.map((p) => p.keyFile).join(" or ")}`,
    )
  const provider = found.provider
  const ranges = pieces(text)
  log("load", { provider: provider.name, chars: text.length, pieces: ranges.length })
  const result = clip({ chunks: [], starts: [], done: false })
  // Pieces are synthesized one after another, so each begins where the audio so far ends.
  let requested = 0
  let finished = 0
  let end = 0
  let chain = Promise.resolve()
  const request = (count: number) => {
    while (requested < Math.min(count, ranges.length)) {
      const range = ranges[requested++]
      chain = chain
        .then(async () => {
          if (result.error) return
          end += await piece(provider, found.key, text.slice(range.start, range.end), end, result)
          finished++
          if (finished === ranges.length) result.finish()
        })
        .catch((error: unknown) => {
          result.error = error instanceof Error ? error : new Error(String(error))
          log("synthesize-failed", { provider: provider.name, piece: requested, error: result.error.message })
          result.finish()
        })
    }
  }
  result.ahead = (time) => {
    if (finished === requested && time >= end - LEAD) request(requested + 1)
  }
  result.need = (char) => request(ranges.findIndex((range) => range.end > char) + 1 || ranges.length)
  request(1)
  return result
}

/**
 * Synthesizes one piece onto the end of `result`, or reuses its cached audio, and
 * returns its length in seconds of 1x audio.
 */
async function piece(provider: Provider, key: string, text: string, offset: number, result: Target) {
  const cache = files(provider, text)
  const local: Target = (await cache.meta.exists())
    ? clip({ chunks: [await cache.audio.bytes()], starts: (await cache.meta.json()).starts, done: true })
    : clip({ chunks: [], starts: [], done: false })
  let sentChunks = 0
  let sentStarts = 0
  const forward = () => {
    // Every response opens with an ID3 tag, which the decoder rejects mid-stream.
    while (sentChunks < local.chunks.length)
      result.chunks.push(sentChunks++ ? local.chunks[sentChunks - 1] : untagged(local.chunks[0]))
    while (sentStarts < Math.min(local.starts.length, text.length)) result.starts.push(offset + local.starts[sentStarts++])
    result.wake()
  }
  if (!local.done) {
    local.wake = forward
    const began = Date.now()
    await provider.synthesize(text, key, provider.voice, provider.model, local)
    log("synthesized", { provider: provider.name, chars: text.length, ms: Date.now() - began })
    local.chunks = local.chunks.map((chunk, index) => (index ? chunk : untagged(chunk)))
    // Trailing spaces after the last word have no speech mark; they share its start.
    while (local.starts.length < text.length) local.starts.push(local.starts.at(-1) ?? 0)
    await mkdir(DIR, { recursive: true })
    await Bun.write(cache.audio, new Blob(local.chunks as BlobPart[]))
    await Bun.write(cache.meta, JSON.stringify({ starts: local.starts.slice(0, text.length) }))
  }
  forward()
  return local.chunks.reduce((sum, chunk) => sum + chunk.length, 0) / BYTES_PER_SECOND
}

/** Splits the text after sentence ends into pieces of at least FIRST_PIECE, then three times the last. */
export function pieces(text: string) {
  const ends = [...text.matchAll(/[.!?:;]\s+|\n+/g)].map((match) => match.index + match[0].length)
  return [...ends, text.length].reduce<{ start: number; end: number }[]>((ranges, end) => {
    const start = ranges.at(-1)?.end ?? 0
    const size = Math.min(MAX_PIECE, FIRST_PIECE * 3 ** ranges.length)
    if (end <= start || (end - start < size && end < text.length)) return ranges
    return [...ranges, { start, end }]
  }, [])
}

function untagged(chunk: Uint8Array) {
  if (chunk[0] !== 0x49 || chunk[1] !== 0x44 || chunk[2] !== 0x33) return chunk
  const size = (chunk[6] << 21) | (chunk[7] << 14) | (chunk[8] << 7) | chunk[9]
  return chunk.subarray(10 + size + (chunk[5] & 0x10 ? 10 : 0))
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
  source.ahead(from)
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
    { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  )
  children.add(proc)
  void proc.exited.then(async (code) => {
    children.delete(proc)
    // A kill is how every stop ends it; only ffmpeg's own failures are worth a line.
    if (code !== 0 && !proc.killed) log("ffmpeg-failed", { code, stderr: (await new Response(proc.stderr).text()).slice(-500) })
  })
  void feed(source, proc.stdin, () => proc.killed).catch(() => {})
  const stream = await output()
    ?.playStream(proc.stdout, { format: "flac" })
    .catch((error: unknown) => log("stream-failed", { error: String(error) }))
  if (!stream) {
    proc.kill("SIGKILL")
    throw new Error("No audio output device")
  }
  log("play", { from: Number(from.toFixed(2)), rate })
  const position = () => {
    const stats = stream.getStats()
    return from + (Number(stats.framesPlayed) / stats.sampleRate) * rate
  }
  // Waiting on the next piece from the network leaves the buffer empty; audio sitting in
  // the buffer while no frame plays is the output itself having stopped.
  let played = -1n
  let since = Date.now()
  let stall: () => void = () => {}
  const timer = setInterval(() => {
    const stats = stream.getStats()
    source.ahead(position())
    if (stats.framesPlayed !== played || stats.bufferedFrames === 0) {
      played = stats.framesPlayed
      since = Date.now()
      return
    }
    if (Date.now() - since < STALL_MS) return
    log("stalled", { at: Number(position().toFixed(2)), buffered: stats.bufferedFrames, state: stats.state, device })
    resetAudio()
    stall()
  }, 250)
  const stop = () => {
    clearInterval(timer)
    proc.kill("SIGKILL")
    try {
      stream.dispose()
    } catch {}
  }
  return {
    position,
    stop,
    ended: new Promise<"ended" | "stalled">((resolve) => {
      stall = () => resolve("stalled")
      stream.once("ended", () => resolve("ended"))
      stream.once("disposed", () => resolve("ended"))
      stream.once("error", (error, context) => {
        log("stream-error", { action: context.action, error: error.message })
        resolve("ended")
      })
    }).finally(stop),
  }
}

/** ElevenLabs streams one JSON object per line, with a start time for every character. */
async function elevenlabs(text: string, key: string, voice: string, model: string, target: Target) {
  const response = await post(
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
  const response = await post("https://api.speechify.ai/v1/audio/stream/with-timestamps", {
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

/** fetch that gives up when the response headers take longer than HEADERS_MS. */
async function post(url: string, init: RequestInit) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), HEADERS_MS)
  return fetch(url, { ...init, signal: controller.signal })
    .catch((error: unknown) => {
      throw controller.signal.aborted ? new Error(`No response from ${new URL(url).host} in ${HEADERS_MS / 1000}s`) : error
    })
    .finally(() => clearTimeout(timer))
}

async function lines(body: NonNullable<Response["body"]>, each: (line: string) => void) {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ""
  while (true) {
    const chunk = await idle(reader.read(), () => reader.cancel())
    if (chunk.done) break
    buffer += chunk.value
    const split = buffer.split("\n")
    buffer = split.pop() ?? ""
    split.forEach(each)
  }
  each(buffer)
}

/** Rejects when `read` has not settled within IDLE_MS, after calling `cancel`. */
async function idle<T>(read: Promise<T>, cancel: () => unknown) {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      void Promise.resolve(cancel()).catch(() => {})
      reject(new Error(`The speech service sent nothing for ${IDLE_MS / 1000}s`))
    }, IDLE_MS)
  })
  return Promise.race([read, timeout]).finally(() => clearTimeout(timer))
}

type Target = ReturnType<typeof clip>

function clip(input: { chunks: Uint8Array[]; starts: number[]; done: boolean }) {
  const waiting: (() => void)[] = []
  const result = {
    ...input,
    error: undefined as Error | undefined,
    next: () => new Promise<void>((resolve) => waiting.push(resolve)),
    wake: () => waiting.splice(0).forEach((resolve) => resolve()),
    ahead: (_time: number) => {},
    need: (_char: number) => {},
    finish() {
      result.done = true
      result.wake()
    },
  }
  return result
}

async function feed(source: Clip, sink: Bun.FileSink, stopped: () => boolean) {
  let sent = 0
  // Without the check a stopped playback would wait on a reading nobody hears.
  while (!stopped()) {
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
