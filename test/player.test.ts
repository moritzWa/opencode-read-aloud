import { expect, test } from "bun:test"
import { createServer as createNetServer } from "node:net"
import { createServer } from "node:http"
import { pieces, post } from "../player"

test("splits a long answer into growing pieces that end on sentences and cover it exactly", () => {
  const text = Array.from({ length: 120 }, (_, index) => `Sentence number ${index} says a little more.`).join(" ")
  const ranges = pieces(text)
  expect(ranges[0].start).toBe(0)
  expect(ranges.at(-1)?.end).toBe(text.length)
  ranges.slice(1).forEach((range, index) => expect(range.start).toBe(ranges[index].end))
  ranges.slice(0, -1).forEach((range) => expect(text[range.end - 2]).toBe("."))
  expect(ranges[0].end).toBeLessThan(300)
  expect(ranges[1].end - ranges[1].start).toBeGreaterThan(ranges[0].end)
})

test("keeps a short answer in one piece", () => {
  expect(pieces("Done. Tests pass.")).toEqual([{ start: 0, end: 17, language: "en" }])
})

test("resolves around a stuck DNS client and keeps the original host", async () => {
  let host = ""
  const server = createServer((request, response) => {
    host = request.headers.host ?? ""
    response.end("ok")
  }).listen(0)
  const port = (server.address() as { port: number }).port
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.includes("dns-query")) return Response.json({ Answer: [{ type: 1, data: "127.0.0.1" }] })
    if (new URL(url).hostname === "nowhere.invalid") {
      throw Object.assign(new Error("getaddrinfo ENOTFOUND nowhere.invalid"), { code: "ENOTFOUND" })
    }
    return original(input, init)
  }) as unknown as typeof fetch
  try {
    const response = await post(`http://nowhere.invalid:${port}/v1`, { method: "POST", body: "{}" })
    expect(await response.text()).toBe("ok")
    expect(host).toBe(`nowhere.invalid:${port}`)
  } finally {
    globalThis.fetch = original
    server.close()
  }
})

test("still reports ENOTFOUND when no resolver can find the host", async () => {
  const original = globalThis.fetch
  globalThis.fetch = (async () => {
    throw Object.assign(new Error("getaddrinfo ENOTFOUND missing.invalid"), { code: "ENOTFOUND" })
  }) as unknown as typeof fetch
  try {
    await expect(post("https://missing.invalid/v1", { method: "POST" })).rejects.toThrow(/ENOTFOUND missing.invalid/)
  } finally {
    globalThis.fetch = original
  }
})

test("retries once on a fresh connection when the server dropped the first one", async () => {
  let connections = 0
  const server = createNetServer((socket) => {
    connections++
    if (connections === 1) return socket.destroy()
    socket.end("HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\nok")
  }).listen(0)
  const port = (server.address() as { port: number }).port
  try {
    const response = await post(`http://127.0.0.1:${port}/`, { method: "POST" })
    expect(await response.text()).toBe("ok")
    expect(connections).toBe(2)
  } finally {
    server.close()
  }
})
