import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { clearPrepared, load, prefetch, prepareAudio, takePrepared, transcode, type Clip, type Provider } from "../player"

afterEach(clearPrepared)

function source(chunks: Uint8Array[], leadKey = "first-sentence"): Clip {
  return {
    chunks, leadKey, starts: [], done: true,
    next: async () => {}, ahead: () => {}, need: () => {}, cancel: async () => {},
  }
}

async function mp3() {
  const encoder = Bun.spawn([
    "ffmpeg", "-v", "error", "-f", "lavfi", "-i",
    "sine=frequency=440:sample_rate=24000:duration=3",
    "-b:a", "128k", "-f", "mp3", "pipe:1",
  ], { stdout: "pipe", stderr: "pipe" })
  const audio = new Uint8Array(await new Response(encoder.stdout).arrayBuffer())
  expect(await encoder.exited).toBe(0)
  const size = audio[0] === 0x49 ? 10 + ((audio[6] << 21) | (audio[7] << 14) | (audio[8] << 7) | audio[9]) : 0
  return audio.subarray(size)
}

async function pcm(bytes: Uint8Array) {
  const decoder = Bun.spawn([
    "ffmpeg", "-v", "error", "-f", "flac", "-i", "pipe:0", "-f", "s16le", "pipe:1",
  ], { stdin: new Blob([new Uint8Array(bytes)]), stdout: "pipe", stderr: "pipe" })
  const output = new Uint8Array(await new Response(decoder.stdout).arrayBuffer())
  expect(await decoder.exited).toBe(0)
  return output
}

test.skipIf(!Bun.which("ffmpeg"))("renders audio before attachment and preserves every sample across differently chunked input", async () => {
  const first = await mp3()
  const warm = prepareAudio(source([first.subarray(0, 1000), first.subarray(1000)]), 2.3)
  const reader = warm.transport.body.getReader()
  const chunks: Uint8Array[] = []
  try {
    // The FLAC header is 8 KiB. Receiving more proves actual audio was rendered
    // before the rest of the answer or an audio device was attached.
    while (chunks.reduce((sum, chunk) => sum + chunk.length, 0) <= 9000) {
      const next = await reader.read()
      expect(next.done).toBe(false)
      if (next.value) chunks.push(next.value)
    }
    const full = source([Buffer.concat([first, first])])
    expect(takePrepared(full, 0, 2.3)).toBe(warm.transport)
    expect(takePrepared(full, 0, 2.3)).toBeUndefined()
    while (true) {
      const next = await reader.read()
      if (next.done) break
      chunks.push(next.value)
    }
    expect(await warm.transport.proc.exited).toBe(0)
    const cold = transcode(full, 0, 2.3)
    try {
      const reference = new Uint8Array(await new Response(cold.body).arrayBuffer())
      expect(await cold.proc.exited).toBe(0)
      expect(await pcm(Buffer.concat(chunks))).toEqual(await pcm(reference))
    } finally {
      cold.stop()
    }
  } finally {
    warm.transport.stop()
    await warm.transport.proc.exited
  }
}, 10_000)

test.skipIf(!Bun.which("ffmpeg"))("bounds speculative encoders and ignores seek, rate and voice mismatches", async () => {
  const clip = source([await mp3()])
  const old = prepareAudio(clip, 2.3)
  const current = prepareAudio(clip, 2.3)
  expect(await old.transport.proc.exited).not.toBe(0)
  expect(takePrepared(clip, 1, 2.3)).toBeUndefined()
  expect(takePrepared(clip, 0, 2)).toBeUndefined()
  expect(takePrepared({ ...clip, leadKey: "other-voice" }, 0, 2.3)).toBeUndefined()
  clearPrepared()
  await current.transport.proc.exited
  expect(takePrepared(clip, 0, 2.3)).toBeUndefined()
  const expiring = prepareAudio(clip, 2.3, 10)
  await expiring.transport.proc.exited
  expect(takePrepared(clip, 0, 2.3)).toBeUndefined()
})

test.skipIf(!Bun.which("ffmpeg"))("prefetch renders only one sentence and hands off to lazy synthesis without repeating it", async () => {
  const audio = await mp3()
  const directory = await mkdtemp(path.join(os.tmpdir(), "prerender-test-"))
  const requests: string[] = []
  const provider: Provider = {
    name: "fixture", env: "", keyFile: "", voice: "voice", model: "model",
    async synthesize(text, _key, _voice, _model, target) {
      requests.push(text)
      target.chunks.push(audio)
      target.starts.push(...Array.from(text, () => 0))
      target.wake()
    },
  }
  const local = { provider, key: "fixture", directory }
  const text = "The first sentence is already ready. A second sentence arrives later."
  try {
    await prefetch(text, undefined, local, 2.3)
    expect(requests).toHaveLength(1)
    const full = await load(text, undefined, local)
    while (full.duration === undefined && !full.done) await full.next()
    const cached = takePrepared(full, 0, 2.3)
    expect(cached).toBeDefined()
    if (!cached) return
    try {
      expect(requests).toHaveLength(1)
      full.need(text.length - 1)
      const output = new Uint8Array(await new Response(cached.body).arrayBuffer())
      expect(await cached.proc.exited).toBe(0)
      expect(requests.join("")).toBe(text)
      const reference = transcode(full, 0, 2.3)
      try {
        const bytes = new Uint8Array(await new Response(reference.body).arrayBuffer())
        expect(await pcm(output)).toEqual(await pcm(bytes))
      } finally {
        reference.stop()
        await reference.proc.exited
      }
      await full.cancel()
    } finally {
      cached.stop()
      await cached.proc.exited
    }
  } finally {
    clearPrepared()
    await rm(directory, { recursive: true, force: true })
  }
})
