import path from "path"
import os from "os"
import { mkdir, rename } from "node:fs/promises"

const SOURCE = path.join(import.meta.dir, "nowplaying.swift")
const DIR = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "opencode", "read-aloud")

export type RemoteCommand = "toggle" | "play" | "pause" | "stop"
export type RemoteState = "playing" | "paused" | "idle"

let binary: Promise<string | undefined> | undefined

/** The compiled helper, built once per source version with the Xcode command line tools. */
function helper() {
  if (process.platform !== "darwin") return Promise.resolve(undefined)
  return (binary ??= compile().catch(() => undefined))
}

async function compile() {
  const source = await Bun.file(SOURCE).text()
  const hash = new Bun.CryptoHasher("sha256").update(source).digest("hex").slice(0, 16)
  const out = path.join(DIR, `nowplaying-${hash}`)
  if (await Bun.file(out).exists()) return out
  const swiftc = Bun.which("swiftc")
  if (!swiftc) return
  await mkdir(DIR, { recursive: true })
  const tmp = `${out}.${process.pid}.tmp`
  const proc = Bun.spawn([swiftc, "-O", SOURCE, "-o", tmp], { stdout: "ignore", stderr: "ignore" })
  if ((await proc.exited) !== 0) return
  await rename(tmp, out)
  return out
}

/**
 * Claims the macOS Now Playing slot while `state` is not idle, so the AirPods
 * button and media keys send their commands here instead of to Spotify or
 * whatever played last. Does nothing where the helper cannot be built.
 */
export function remote(onCommand: (command: RemoteCommand) => void) {
  void helper()
  let proc: Bun.Subprocess<"pipe", "pipe", "ignore"> | undefined
  let state: RemoteState = "idle"
  let launching = false

  async function launch() {
    launching = true
    const bin = await helper().finally(() => (launching = false))
    if (!bin || state === "idle" || proc) return
    const child = Bun.spawn([bin], { stdin: "pipe", stdout: "pipe", stderr: "ignore" })
    proc = child
    child.stdin.write(`${state}\n`)
    void listen(child).finally(() => {
      if (proc === child) proc = undefined
    })
  }

  async function listen(child: NonNullable<typeof proc>) {
    const reader = child.stdout.pipeThrough(new TextDecoderStream()).getReader()
    let buffer = ""
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) return
      const lines = (buffer + chunk.value).split("\n")
      buffer = lines.pop() ?? ""
      for (const line of lines) if (isCommand(line)) onCommand(line)
    }
  }

  function set(next: RemoteState) {
    if (next === state) return
    state = next
    if (next === "idle") return release()
    if (proc) return void proc.stdin.write(`${next}\n`)
    if (!launching) void launch()
  }

  function release() {
    const child = proc
    proc = undefined
    if (!child) return
    void Promise.resolve(child.stdin.end()).catch(() => {})
    setTimeout(() => child.kill(), 1000)
  }

  return { set, dispose: () => set("idle") }
}

function isCommand(line: string): line is RemoteCommand {
  return line === "toggle" || line === "play" || line === "pause" || line === "stop"
}
