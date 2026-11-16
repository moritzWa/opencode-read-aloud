import { expect, test } from "bun:test"
import { feed, type Clip } from "../player"

test.each([false, true])("feeds audio arriving during a blocked flush (finished: %s)", async (done) => {
  const waiting: (() => void)[] = []
  const source: Clip = {
    chunks: [new Uint8Array([1])],
    starts: [],
    done: false,
    next: () => new Promise<void>((resolve) => waiting.push(resolve)),
    ahead: () => {},
    need: () => {},
    cancel: async () => {},
  }
  const written: number[] = []
  const fed = { bytes: 0 }
  let flushes = 0
  let ended = false
  const feeding = feed(source, {
    write(chunk) {
      written.push(...(chunk as Uint8Array))
      return 1
    },
    async flush() {
      if (++flushes !== 1) return 0
      // The next piece finishes while pipe backpressure holds flush(). Its wake
      // has no listener yet, just as when a long reading fills the audio buffer.
      await Promise.resolve()
      source.chunks.push(new Uint8Array([2]))
      source.done = done
      waiting.splice(0).forEach((resolve) => resolve())
      return 0
    },
    end() {
      ended = true
      return 0
    },
  }, () => false, fed)
  try {
    await Bun.sleep(20)
    expect(written).toEqual([1, 2])
    expect(fed.bytes).toBe(2)
    expect(ended).toBe(done)
  } finally {
    source.done = true
    waiting.splice(0).forEach((resolve) => resolve())
    await feeding
  }
  expect(ended).toBe(true)
})
