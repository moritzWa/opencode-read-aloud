import { expect, test } from "bun:test"
import { createServer } from "node:http"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { load, mp3Duration, speechify, type Clip, type Provider } from "../player"
import { build } from "../script"

async function until(clip: Clip, ready: () => boolean) {
  while (!ready() && !clip.done) await clip.next()
  if (clip.error) throw clip.error
}

async function fixture() {
  const requests: { input: string; language: string; voice_id: string; model: string }[] = []
  const directory = await mkdtemp(path.join(os.tmpdir(), "speech-language-test-"))
  const state = { truncate: false, block: false }
  // 64 MPEG-2 frames at 24 kHz, 128 kbps. Their padded duration is 1.536s,
  // deliberately different from the API's reported 1.5s speech duration.
  const audio = Buffer.alloc(64 * 384)
  for (let at = 0; at < audio.length; at += 384) audio.set([0xff, 0xf3, 0xc4, 0], at)
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString())
    requests.push(body)
    response.writeHead(200, { "content-type": "text/event-stream" })
    response.write(
      `data: ${JSON.stringify({ type: "speech.chunk", audio: audio.toString("base64"), speech_marks: [{ start: 0, end: [...body.input].length, start_time: 100 }] })}\n\n`,
    )
    if (state.block) return
    if (!state.truncate) response.write(`data: ${JSON.stringify({ type: "speech.done", audio_duration_ms: 1500 })}\n\n`)
    response.end()
  }).listen(0)
  const port = (server.address() as { port: number }).port
  const provider: Provider = {
    name: "speechify",
    env: "",
    keyFile: "",
    voice: "dominic",
    model: "simba-3.0",
    german: { voice: "henrik-agent", model: "simba-3.0" },
    synthesize: (...args) => speechify(...args, `http://127.0.0.1:${port}`),
  }
  return {
    requests,
    directory,
    state,
    source: { provider, key: "test-only", directory },
    async close() {
      server.closeAllConnections()
      server.close()
      await rm(directory, { recursive: true, force: true })
    },
  }
}

test("streams explicit language/voice requests, offsets timestamps by decoded duration and reuses caches", async () => {
  const local = await fixture()
  try {
    const script = build([
      "This is the English introduction.",
      "Vielen Dank für Ihre Rückmeldung und Ihre Unterstützung.",
      "Not sent.",
    ])
    const clip = await load(script.text, script.blocks, local.source)
    await until(clip, () => clip.duration !== undefined)
    expect(local.requests).toHaveLength(1)
    // A click in the final sentence requests the intervening German piece too.
    clip.need(script.text.length - 1)
    await until(clip, () => clip.done)
    expect(local.requests.map((request) => [request.language, request.voice_id, request.model])).toEqual([
      ["en-US", "dominic", "simba-3.0"],
      ["de-DE", "henrik-agent", "simba-3.0"],
      ["en-US", "dominic", "simba-3.0"],
    ])
    expect(local.requests.map((request) => request.input).join("")).toBe(script.text)
    expect(clip.starts).toHaveLength(script.text.length)
    expect(clip.starts[script.blocks[1].start]).toBeCloseTo(1.636)
    expect(clip.starts[script.blocks[2].start]).toBeCloseTo(3.172)
    expect(clip.duration).toBeCloseTo(4.608)

    const cached = await load(script.text, script.blocks, local.source)
    cached.need(script.text.length - 1)
    await until(cached, () => cached.done)
    expect(local.requests).toHaveLength(3)
    expect(cached.starts).toEqual(clip.starts)
    expect(cached.duration).toBe(clip.duration)

    // A voice change invalidates German audio only; existing English pieces remain reusable.
    local.source.provider.german = { voice: "benedikt-agent", model: "simba-3.0" }
    const changed = await load(script.text, script.blocks, local.source)
    changed.need(script.text.length - 1)
    await until(changed, () => changed.done)
    expect(local.requests).toHaveLength(4)
    expect(local.requests.at(-1)?.voice_id).toBe("benedikt-agent")
  } finally {
    await local.close()
  }
})

test.skipIf(!Bun.which("ffmpeg"))("MP3 sample durations match real ffmpeg decoding across piece seams", async () => {
  const encoder = Bun.spawn(
    [
      "ffmpeg",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "anullsrc=r=24000:cl=mono",
      "-t",
      "0.3",
      "-b:a",
      "128k",
      "-f",
      "mp3",
      "pipe:1",
    ],
    { stdout: "pipe", stderr: "pipe" },
  )
  const audio = new Uint8Array(await new Response(encoder.stdout).arrayBuffer())
  expect(await encoder.exited).toBe(0)
  // Strip ID3 before concatenation, exactly as piece() does.
  const size = audio[0] === 0x49 ? 10 + ((audio[6] << 21) | (audio[7] << 14) | (audio[8] << 7) | audio[9]) : 0
  const chunks = [audio.slice(size), audio.slice(size), audio.slice(size)]
  const decoder = Bun.spawn(
    ["ffmpeg", "-v", "error", "-f", "mp3", "-i", "pipe:0", "-f", "f32le", "-ac", "1", "-ar", "24000", "pipe:1"],
    { stdin: new Blob(chunks), stdout: "pipe", stderr: "pipe" },
  )
  const pcm = await new Response(decoder.stdout).arrayBuffer()
  expect(await decoder.exited).toBe(0)
  expect(mp3Duration(chunks)).toBeCloseTo(pcm.byteLength / (24000 * 4), 5)
  expect(chunks.reduce((sum, chunk) => sum + mp3Duration([chunk]), 0)).toBeCloseTo(mp3Duration(chunks), 5)
  expect(() => mp3Duration([chunks[0].slice(0, -1)])).toThrow("Incomplete MP3")
  expect(() => mp3Duration([new Uint8Array(20)])).toThrow("no MP3 frames")
})

test("prefetches using wall-clock lead time at faster playback speeds", async () => {
  const local = await fixture()
  try {
    const script = build(["This is the English introduction.", "Vielen Dank für Ihre Rückmeldung."])
    const clip = await load(script.text, script.blocks, local.source)
    await until(clip, () => clip.duration !== undefined)
    clip.ahead(-10, 1)
    expect(local.requests).toHaveLength(1)
    clip.ahead(-10, 2)
    await until(clip, () => clip.done)
    expect(local.requests).toHaveLength(2)
  } finally {
    await local.close()
  }
})

test("stop cancels a pending stream and queued language requests without caching partial audio", async () => {
  const local = await fixture()
  try {
    local.state.block = true
    const script = build(["This is the English introduction.", "Vielen Dank für Ihre Rückmeldung."])
    const clip = await load(script.text, script.blocks, local.source)
    clip.need(script.text.length - 1)
    await until(clip, () => clip.starts.length > 0)
    await clip.cancel()
    expect(clip.done).toBe(true)
    expect(clip.error).toBeUndefined()
    expect(local.requests).toHaveLength(1)
    expect(await readdir(local.directory)).toEqual([])
  } finally {
    await local.close()
  }
})

test("a truncated Speechify stream fails rather than caching an incomplete reading", async () => {
  const local = await fixture()
  try {
    local.state.truncate = true
    const clip = await load("This is a short English answer.", undefined, local.source)
    await expect(until(clip, () => clip.done)).rejects.toThrow("before speech.done")
    expect(await readdir(local.directory)).toEqual([])
  } finally {
    await local.close()
  }
})

test("does not reuse a legacy whole-answer cache with the wrong language", async () => {
  const local = await fixture()
  try {
    const text = "Vielen Dank für Ihre Rückmeldung."
    const id = new Bun.CryptoHasher("sha256").update(`dominic\0simba-3.0\0${text}`).digest("hex")
    await Bun.write(path.join(local.directory, `${id}.json`), JSON.stringify({ starts: [0] }))
    await Bun.write(path.join(local.directory, `${id}.mp3`), new Uint8Array(10))
    const clip = await load(text, undefined, local.source)
    await until(clip, () => clip.done)
    expect(local.requests).toHaveLength(1)
    expect(local.requests[0].voice_id).toBe("henrik-agent")
    expect(clip.starts).toHaveLength(text.length)
  } finally {
    await local.close()
  }
})
