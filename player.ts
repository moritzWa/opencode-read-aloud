import path from "path"
import os from "os"
import { mkdir } from "node:fs/promises"
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs"
import { Audio } from "@opentui/core"
import { pieces, type Language } from "./language"
import type { Range } from "./script"

export { pieces } from "./language"

// The same folders OpenCode itself uses, so the key files and the audio cache are
// shared with OpenCode's own data.
const DATA = path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "opencode")
const DIR = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "opencode", "speech")

// Answers are synthesized a piece at a time, just ahead of playback, since the services
// bill every character sent and most readings stop after a sentence or two. Pieces end
// on a sentence and grow from the first, which is small so playback starts quickly.
// Seconds of 1x audio left before the next piece is requested.
const LEAD = 8
const POLICY = "language-v4-eld"
// Audio decoded and waiting for this long without a frame reaching the speakers means the
// output is dead, as after the default device switches to AirPods under a running engine.
const STALL_MS = 2500
// A speech request with no response headers, or no new bytes, for this long has hung.
const HEADERS_MS = 20_000
const IDLE_MS = 30_000
// playStream resolves once ffmpeg's first audio decodes, which takes well under a second;
// longer means the engine has wedged, and the reading's lock would be held forever.
const OPEN_MS = 5000

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

export type Provider = {
  name: string
  env: string
  keyFile: string
  voice: string
  model: string
  german?: { voice: string; model: string }
  synthesize: (
    text: string,
    key: string,
    voice: string,
    model: string,
    target: Target,
    language: Language,
    signal: AbortSignal,
  ) => Promise<void>
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
    german: { voice: "henrik-agent", model: "simba-3.0" },
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
    if (provider.german && "german" in settings && settings.german && typeof settings.german === "object") {
      if ("voice" in settings.german && typeof settings.german.voice === "string")
        provider.german.voice = settings.german.voice
      if ("model" in settings.german && typeof settings.german.model === "string")
        provider.german.model = settings.german.model
    }
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
  duration?: number
  error?: Error
  next: () => Promise<void>
  ahead: (time: number, rate?: number) => void
  need: (char: number) => void
  cancel: () => Promise<void>
}

export type Playback = {
  position: () => number
  stop: () => void
  /** "stalled" when the output stopped taking audio; the engine is already reset for a retry. */
  ended: Promise<"ended" | "stalled">
}

export async function load(
  text: string,
  blocks?: readonly Range[],
  source?: { provider: Provider; key: string; directory: string },
): Promise<Clip> {
  const found = source ?? (await firstKey())
  if (!found)
    throw new Error(
      `Set SPEECHIFY_API_KEY or ELEVENLABS_API_KEY, or write the key to ${PROVIDERS.map((p) => p.keyFile).join(" or ")}`,
    )
  const provider = found.provider
  const ranges = pieces(text, blocks)
  log("load", {
    provider: provider.name,
    chars: text.length,
    pieces: ranges.length,
    policy: POLICY,
    languages: ranges.map((range) => range.language),
  })
  const result = clip({ chunks: [], starts: [], done: false })
  const controller = new AbortController()
  result.cancel = async () => {
    controller.abort()
    result.finish()
    await chain
  }
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
          if (result.error || controller.signal.aborted) return
          const settings = range.language === "de" && provider.german ? { ...provider, ...provider.german } : provider
          end += await piece(
            settings,
            found.key,
            text.slice(range.start, range.end),
            range.language,
            end,
            result,
            controller.signal,
            source?.directory ?? DIR,
          )
          finished++
          result.duration = end
          result.wake()
          if (finished === ranges.length) result.finish()
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return
          result.error = error instanceof Error ? error : new Error(String(error))
          log("synthesize-failed", { provider: provider.name, piece: requested, error: result.error.message })
          result.finish()
        })
    }
  }
  result.ahead = (time, rate = 1) => {
    if (!controller.signal.aborted && finished === requested && time >= end - LEAD * rate) request(requested + 1)
  }
  result.need = (char) => request(ranges.findIndex((range) => range.end > char) + 1 || ranges.length)
  request(1)
  return result
}

/**
 * Synthesizes one piece onto the end of `result`, or reuses its cached audio, and
 * returns its length in seconds of 1x audio.
 */
async function piece(
  provider: Provider,
  key: string,
  text: string,
  language: Language,
  offset: number,
  result: Target,
  signal: AbortSignal,
  directory: string,
) {
  const cache = files(provider, text, language, directory)
  const meta: { starts: number[]; duration?: number } | undefined = (await cache.meta.exists())
    ? await cache.meta.json()
    : undefined
  const local: Target = meta
    ? clip({ chunks: [await cache.audio.bytes()], starts: meta.starts, done: true, duration: meta.duration })
    : clip({ chunks: [], starts: [], done: false })
  let sentChunks = 0
  let sentStarts = 0
  const forward = () => {
    // Every response opens with an ID3 tag, which the decoder rejects mid-stream.
    while (sentChunks < local.chunks.length)
      result.chunks.push(sentChunks++ ? local.chunks[sentChunks - 1] : untagged(local.chunks[0]))
    while (sentStarts < Math.min(local.starts.length, text.length))
      result.starts.push(offset + local.starts[sentStarts++])
    result.wake()
  }
  if (!local.done) {
    local.wake = forward
    const began = Date.now()
    await provider.synthesize(text, key, provider.voice, provider.model, local, language, signal)
    signal.throwIfAborted()
    log("synthesized", {
      provider: provider.name,
      voice: provider.voice,
      model: provider.model,
      language,
      chars: text.length,
      ms: Date.now() - began,
    })
    local.chunks = local.chunks.map((chunk, index) => (index ? chunk : untagged(chunk)))
    // The API's duration excludes encoder padding that ffmpeg still plays between
    // pieces. Count actual MPEG samples so each seam stays on the decoded timeline.
    local.duration = mp3Duration(local.chunks)
    // Trailing spaces after the last word have no speech mark; they share its start.
    while (local.starts.length < text.length) local.starts.push(local.starts.at(-1) ?? 0)
    await mkdir(directory, { recursive: true })
    await Bun.write(cache.audio, new Blob(local.chunks as BlobPart[]))
    await Bun.write(
      cache.meta,
      JSON.stringify({ starts: local.starts.slice(0, text.length), duration: local.duration }),
    )
  }
  forward()
  return local.duration ?? mp3Duration(local.chunks)
}

/** Streaming providers emit MPEG Layer III frames without a seek/Xing header. */
export function mp3Duration(chunks: readonly Uint8Array[]) {
  const bytes = Buffer.concat(chunks)
  let samples = 0
  let at = 0
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff || (bytes[at + 1] & 0xe0) !== 0xe0) {
      at++
      continue
    }
    const version = (bytes[at + 1] >> 3) & 3
    const layer = (bytes[at + 1] >> 1) & 3
    const index = bytes[at + 2] >> 4
    const frequency = (bytes[at + 2] >> 2) & 3
    if (version === 1 || layer !== 1 || index === 0 || index === 15 || frequency === 3) {
      at++
      continue
    }
    const rate = [44100, 48000, 32000][frequency] / (version === 3 ? 1 : version === 2 ? 2 : 4)
    const bitrate =
      (version === 3
        ? [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
        : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160])[index] * 1000
    const size = Math.floor(((version === 3 ? 144 : 72) * bitrate) / rate) + ((bytes[at + 2] >> 1) & 1)
    if (at + size > bytes.length) throw new Error("Incomplete MP3 frame from speech service")
    samples += (version === 3 ? 1152 : 576) / rate
    at += size
  }
  if (!samples) throw new Error("Speech service returned no MP3 frames")
  return samples
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
  // A wedged engine gets one fresh replacement before the error reaches the user.
  return attempt(source, from, rate).catch((error: unknown) => {
    if (!(error instanceof Wedged)) throw error
    return attempt(source, from, rate)
  })
}

class Wedged extends Error {}

async function attempt(source: Clip, from: number, rate: number): Promise<Playback> {
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
      // After a seek atempo can emit a first frame of a few samples, which the flac encoder
      // refuses as a block size, so ffmpeg writes nothing; fixed-size frames avoid that.
      `atempo=${rate},asetnsamples=n=4096:p=1`,
      "-f",
      "flac",
      "pipe:1",
    ],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  )
  children.add(proc)
  const stderr = new Response(proc.stderr).text()
  void proc.exited.then(async (code) => {
    children.delete(proc)
    // A kill is how every stop ends it; only ffmpeg's own failures are worth a line.
    if (code !== 0 && !proc.killed) log("ffmpeg-failed", { code, stderr: (await stderr).slice(-500) })
  })
  const fed = { bytes: 0 }
  void feed(source, proc.stdin, () => proc.killed, fed).catch(() => {})
  const opening = output()?.playStream(proc.stdout, { format: "flac" })
  const stream = await Promise.race([opening, Bun.sleep(OPEN_MS).then(() => "timeout" as const)]).catch(
    (error: unknown) => log("stream-failed", { error: String(error) }),
  )
  if (stream === "timeout") {
    // fed shows whether ffmpeg had input, so the log tells a starved ffmpeg from a stuck engine.
    log("stream-timeout", {
      from: Number(from.toFixed(2)),
      fed: fed.bytes,
      chunks: source.chunks.length,
      done: source.done,
    })
    proc.kill("SIGKILL")
    void opening?.then(
      (late) => late.dispose(),
      () => {},
    )
    resetAudio()
    throw new Wedged("The audio output did not start playing")
  }
  if (!stream) {
    // The decoder fails when ffmpeg wrote nothing usable, so its stderr says why.
    const errors = await Promise.race([stderr, Bun.sleep(500).then(() => "")])
    proc.kill("SIGKILL")
    if (errors) log("ffmpeg-stderr", { from: Number(from.toFixed(2)), stderr: errors.slice(-500) })
    throw new Wedged("The audio did not start playing")
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
    source.ahead(position(), rate)
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
async function elevenlabs(
  text: string,
  key: string,
  voice: string,
  model: string,
  target: Target,
  language: Language,
  signal: AbortSignal,
) {
  const response = await post(
    `https://api.elevenlabs.io/v1/text-to-speech/${voice}/stream/with-timestamps?output_format=mp3_44100_128`,
    {
      method: "POST",
      signal,
      headers: { "xi-api-key": key, "content-type": "application/json" },
      body: JSON.stringify({ text, model_id: model, language_code: language }),
    },
  )
  if (!response.ok || !response.body) throw new Error(`ElevenLabs ${response.status}: ${await response.text()}`)
  await lines(response.body, (line) => {
    if (!line.trim()) return
    const frame: { audio_base64?: string; alignment?: { character_start_times_seconds?: number[] } } = JSON.parse(line)
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
export async function speechify(
  text: string,
  key: string,
  voice: string,
  model: string,
  target: Target,
  language: Language,
  signal: AbortSignal,
  endpoint = "https://api.speechify.ai/v1/audio/stream/with-timestamps",
) {
  // UTF-16 index of every code point, since the script indexes the string itself.
  const units = [0]
  for (const char of text) units.push(units[units.length - 1] + char.length)
  const response = await post(endpoint, {
    method: "POST",
    signal,
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      // An emoji anywhere makes Speechify drop the last word, audio and all; a space in its
      // place keeps every offset.
      input: text.replace(/\p{Extended_Pictographic}|\p{Emoji_Modifier}|\uFE0F|\u200D/gu, " "),
      voice_id: voice,
      model,
      language: language === "de" ? "de-DE" : "en-US",
      // Streaming only offers 24 kHz mp3 at most.
      output_format: "mp3_24000_128",
    }),
  })
  if (!response.ok || !response.body) throw new Error(`Speechify ${response.status}: ${await response.text()}`)
  let done = false
  await lines(response.body, (line) => {
    if (!line.startsWith("data:")) return
    const event: {
      type?: string
      audio?: string
      speech_marks?: { start: number; end: number; start_time: number }[]
      error?: { code: string; message: string }
    } = JSON.parse(line.slice(5))
    if (event.type === "speech.error") throw new Error(`Speechify ${event.error?.code}: ${event.error?.message}`)
    if (event.type === "speech.done") done = true
    if (event.audio) target.chunks.push(Buffer.from(event.audio, "base64"))
    for (const mark of event.speech_marks ?? [])
      while (target.starts.length < (units[mark.end] ?? text.length)) target.starts.push(mark.start_time / 1000)
    target.wake()
  })
  if (!done) throw new Error("Speechify stream ended before speech.done")
}

/**
 * fetch that gives up when the response headers take longer than HEADERS_MS. The server
 * closes idle keep-alive connections, and the next request on one fails at once with
 * "The socket connection was closed unexpectedly"; a retry opens a fresh connection.
 *
 * A long-running Bun process on macOS can also stick its dns_sd client after sleep or a
 * Tailscale change and then answer every name with getaddrinfo ENOTFOUND, while a new
 * process resolves the same name. Pinning the request to an address from another resolver
 * skips that client.
 */
export async function post(url: string, init: RequestInit, retried = false): Promise<Response> {
  try {
    return await once(url, init)
  } catch (error) {
    init.signal?.throwIfAborted()
    if (dnsFailed(error)) return pinned(url, init)
    if (!retried && socketClosed(error)) return post(url, init, true)
    throw error
  }
}

type FetchInit = RequestInit & { tls?: { serverName?: string } }

async function once(url: string, init: FetchInit) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), HEADERS_MS)
  return fetch(url, {
    ...init,
    signal: init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal,
  })
    .catch((error: unknown) => {
      if (controller.signal.aborted) throw new Error(`No response from ${new URL(url).host} in ${HEADERS_MS / 1000}s`)
      throw error
    })
    .finally(() => clearTimeout(timer))
}

function socketClosed(error: unknown) {
  return String((error as Error)?.message).includes("socket connection was closed")
}

function dnsFailed(error: unknown) {
  const code = (error as { code?: string })?.code
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return true
  return /getaddrinfo|ENOTFOUND|EAI_AGAIN/i.test(String((error as Error)?.message ?? ""))
}

// One minute is enough for the pieces of one reading, and short enough that a speech
// provider IP change is picked up on the next one.
const RESOLVE_MS = 60_000
const resolved = new Map<string, { address: string; until: number }>()

async function pinned(url: string, init: RequestInit) {
  const target = new URL(url)
  const address = await resolveHost(target.hostname)
  const pinnedUrl = new URL(url)
  pinnedUrl.hostname = address
  const headers = new Headers(init.headers)
  headers.set("host", target.host)
  log("dns-bypass", { host: target.hostname, address })
  try {
    return await once(pinnedUrl.toString(), {
      ...init,
      headers,
      tls: target.protocol === "https:" ? { serverName: target.hostname } : undefined,
    })
  } catch (error) {
    resolved.delete(target.hostname)
    throw error
  }
}

async function resolveHost(hostname: string) {
  const cached = resolved.get(hostname)
  if (cached && cached.until > Date.now()) return cached.address
  const address = (await libcLookup(hostname)) ?? (await doh(hostname)) ?? (await systemLookup(hostname))
  if (!address) throw new Error(`getaddrinfo ENOTFOUND ${hostname}`)
  resolved.set(hostname, { address, until: Date.now() + RESOLVE_MS })
  return address
}

/** POSIX getaddrinfo, which fails over supplemental resolvers. Bun's default macOS client does not. */
async function libcLookup(hostname: string) {
  try {
    const { dns } = await import("bun")
    const found = await dns.lookup(hostname, { backend: "libc" })
    return found.find((entry) => entry.family === 4)?.address
  } catch {
    return
  }
}

const DOH = ["1.1.1.1", "1.0.0.1"]

/** DNS-over-HTTPS to a literal address, so a stuck in-process resolver is not consulted. */
async function doh(hostname: string) {
  for (const server of DOH) {
    try {
      const response = await fetch(`https://${server}/dns-query?name=${encodeURIComponent(hostname)}&type=A`, {
        headers: { accept: "application/dns-json" },
        signal: AbortSignal.timeout(3000),
      })
      if (!response.ok) continue
      const body = (await response.json()) as { Answer?: { type?: number; data?: string }[] }
      const address = body.Answer?.find((record) => record.type === 1 && ipv4(record.data))?.data
      if (address) return address
    } catch {
      continue
    }
  }
}

/** A fresh process uses the system resolver, which is what still works when this one does not. */
async function systemLookup(hostname: string) {
  if (!/^[a-zA-Z0-9.-]+$/.test(hostname)) return
  const commands = [
    ["dscacheutil", "-q", "host", "-a", "name", hostname],
    [
      "python3",
      "-c",
      "import socket,sys; print(socket.getaddrinfo(sys.argv[1], 443, socket.AF_INET)[0][4][0])",
      hostname,
    ],
  ]
  for (const cmd of commands) {
    try {
      const child = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore", timeout: 3000 })
      const text = await new Response(child.stdout).text()
      if ((await child.exited) !== 0) continue
      const address = text.match(/\b(\d{1,3}(?:\.\d{1,3}){3})\b/)?.[1]
      if (ipv4(address)) return address
    } catch {
      continue
    }
  }
}

function ipv4(address: string | undefined): address is string {
  if (!address) return false
  const parts = address.split(".")
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
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

function clip(input: { chunks: Uint8Array[]; starts: number[]; done: boolean; duration?: number }) {
  const waiting: (() => void)[] = []
  const result = {
    ...input,
    error: undefined as Error | undefined,
    next: () => new Promise<void>((resolve) => waiting.push(resolve)),
    wake: () => waiting.splice(0).forEach((resolve) => resolve()),
    ahead: (_time: number, _rate = 1) => {},
    need: (_char: number) => {},
    cancel: async () => {},
    finish() {
      result.done = true
      result.wake()
    },
  }
  return result
}

async function feed(source: Clip, sink: Bun.FileSink, stopped: () => boolean, fed: { bytes: number }) {
  let sent = 0
  // Without the check a stopped playback would wait on a reading nobody hears.
  while (!stopped()) {
    while (sent < source.chunks.length) {
      fed.bytes += source.chunks[sent].length
      sink.write(source.chunks[sent++])
    }
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

function files(provider: Provider, text: string, language: Language, directory: string) {
  const id = new Bun.CryptoHasher("sha256")
    .update(`${POLICY}\0${provider.name}\0${provider.voice}\0${provider.model}\0${language}\0${text}`)
    .digest("hex")
  return { audio: Bun.file(path.join(directory, `${id}.mp3`)), meta: Bun.file(path.join(directory, `${id}.json`)) }
}
