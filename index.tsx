/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { CodeRenderable, KeyEvent, MarkdownRenderable, Renderable } from "@opentui/core"
import { createBindingLookup } from "@opentui/keymap/extras"
import { useTerminalDimensions } from "@opentui/solid"
import { createSignal, Show } from "solid-js"
import { answerParts, finalAnswer, isAnswerText } from "./answer"
import { remote } from "./media"
import { load, play, type Clip, type Playback } from "./player"
import { build, source, wordAt, type Script } from "./script"
import { blocks, clear, markdowns, pick, reveal, show, transcript, type Spot } from "./view"

const id = "opencode-read-aloud"

const command = {
  toggle: "speech.toggle",
  stop: "speech.stop",
  restart: "speech.restart",
  faster: "speech.faster",
  slower: "speech.slower",
} as const

// Option names match the keybind names the speech feature had in OpenCode's own config.
const keybindNames = {
  speech_toggle: command.toggle,
  speech_stop: command.stop,
  speech_restart: command.restart,
  speech_faster: command.faster,
  speech_slower: command.slower,
}

const defaultKeybinds = {
  speech_toggle: "ctrl+s",
  speech_stop: "none",
  speech_restart: "none",
  speech_faster: "none",
  speech_slower: "none",
}

const SLOTS = { right: "session_prompt_right", footer: "session_prompt_footer" } as const

const COMPACT_BELOW = 80

const KV_RATE = "speech_speed"
const DEFAULT_RATE = 1.7
const TICK_MS = 40
const STEP = 0.1
// Resuming a beat early makes the first word after a pause audible again.
const RESUME_REWIND = 0.4
// Option+click needs a handler on every answer, including ones loaded from
// history in one batch before any event arrives, so they are also swept for.
const SWEEP_MS = 2000

type Segment = { partID: string; messageID: string; index: number; node: CodeRenderable }

type Status = "idle" | "loading" | "playing" | "paused"

type Reading = {
  sessionID: string
  messageID: string
  segments: Segment[]
  script: Script
  clip: Clip
  position: number
  word: number
  node?: CodeRenderable
  playback?: Playback
  timer?: ReturnType<typeof setInterval>
}

const tui: TuiPlugin = async (api, options) => {
  const opts = options ?? {}
  const placement = opts.placement === "footer" ? "footer" : "right"
  const keys = createBindingLookup<Renderable, KeyEvent>(
    { ...defaultKeybinds, ...(record(opts.keybinds) ? opts.keybinds : {}) } as Record<string, string>,
    { commandMap: keybindNames },
  )

  let current: Reading | undefined
  const [rate, setRate] = createSignal(clampRate(api.kv.get(KV_RATE, DEFAULT_RATE)))
  const [status, setStatusSignal] = createSignal<Status>("idle")
  const [sessionID, setSessionID] = createSignal<string>()

  const media = remote((command) => {
    if (command === "stop") return stop()
    if (command === "pause") return pause()
    if (command === "play" && status() !== "paused") return
    void exclusive(step)
  })
  function setStatus(next: Status) {
    setStatusSignal(next)
    media.set(next === "loading" ? "playing" : next)
  }

  const fail = (error: unknown) =>
    api.ui.toast({ variant: "error", message: error instanceof Error ? error.message : String(error) })

  const colors = () => ({ background: api.theme.current.background, primary: api.theme.current.primary })

  /** The rendered markdown of a text part, found by its content since the host does not label it. */
  function viewOf(partID: string, messageID: string) {
    const part = api.state.part(messageID).find((part) => part.id === partID)
    if (!part || part.type !== "text") return
    const text = part.text.trim()
    const root = transcript(api.renderer.root)
    return root && markdowns(root).find((view) => view.content === text)
  }

  // A second press while the first one is still waiting on ElevenLabs or ffmpeg
  // would otherwise start a second playback on top of it.
  let busy = false
  async function exclusive(run: () => Promise<unknown>) {
    if (busy) return
    busy = true
    await run().finally(() => (busy = false))
  }

  async function step() {
    if (current?.playback) return pause()
    const answer = currentAnswer(api)
    if (current && (!answer || current.messageID === answer.messageID)) return start(current.position - RESUME_REWIND)
    if (!answer) return api.ui.toast({ variant: "info", message: "No answer to read yet" })
    await open(answer)
  }

  async function jump(spot: Spot) {
    const reading = current
    if (!reading?.segments.some((segment) => segment.partID === spot.partID)) {
      const answer = answerAt(api, spot)
      return answer && open(answer, spot)
    }
    const from = await timeAt(reading, spot, resolve)
    if (from === undefined || current !== reading) return
    halt(reading)
    reading.word = -1
    reading.position = from
    await start(from)
  }

  async function open(answer: { sessionID: string; messageID: string; partIDs: string[] }, spot?: Spot) {
    stop()
    const segments = answer.partIDs.flatMap((partID) =>
      (blocks(viewOf(partID, answer.messageID)) ?? []).map((node, index) => ({
        partID,
        messageID: answer.messageID,
        index,
        node,
      })),
    )
    const script = build(segments.map((segment) => segment.node.content))
    if (!script.text) return api.ui.toast({ variant: "info", message: "Nothing to read in this answer" })
    setSessionID(answer.sessionID)
    setStatus("loading")
    const clip = await load(script.text).catch(fail)
    if (!clip) return setStatus("idle")
    current = {
      sessionID: answer.sessionID,
      messageID: answer.messageID,
      segments,
      script,
      clip,
      position: 0,
      word: -1,
    }
    const reading = current
    const from = spot ? await timeAt(reading, spot, resolve) : 0
    if (current === reading) await start(from ?? 0)
  }

  async function start(from: number) {
    const reading = current
    if (!reading) return
    const playback = await play(reading.clip, Math.max(0, from), rate()).catch(fail)
    if (!playback || current !== reading) return playback?.stop()
    reading.playback = playback
    setStatus("playing")
    reading.timer = setInterval(() => tick(reading), TICK_MS)
    void playback.ended.then(() => {
      if (reading.playback !== playback) return
      if (reading.clip.error) fail(reading.clip.error)
      stop()
    })
  }

  function pause() {
    const reading = current
    if (!reading?.playback) return
    reading.position = reading.playback.position()
    halt(reading)
    setStatus("paused")
  }

  function stop() {
    if (current) halt(current)
    current = undefined
    clear()
    setStatus("idle")
  }

  async function restart() {
    const answer = currentAnswer(api)
    if (!answer) return api.ui.toast({ variant: "info", message: "No answer to read yet" })
    await open(answer)
  }

  async function speed(delta: number) {
    setRate(clampRate(rate() + delta))
    api.kv.set(KV_RATE, rate())
    const reading = current
    if (!reading?.playback) return
    reading.position = reading.playback.position()
    halt(reading)
    await start(reading.position)
  }

  function tick(reading: Reading) {
    if (!reading.playback) return
    const index = wordAt(reading.script, reading.clip.starts, reading.playback.position())
    if (index < 0 || index === reading.word) return
    reading.word = index
    const word = reading.script.words[index]
    const sentence =
      reading.script.sentences.find((range) => range.start <= word.start && word.end <= range.end) ?? word
    const target = source(reading.script, word)
    const node = resolve(reading.segments[target.segment])
    if (!node) return
    show(node, source(reading.script, sentence), target, colors())
    if (reading.node === node) return
    reading.node = node
    reveal(api.renderer.root, node)
  }

  /** Markdown may rebuild its blocks (a theme change does); look the node up again when it has. */
  function resolve(segment: Segment | undefined) {
    if (!segment) return
    if (!segment.node.isDestroyed) return segment.node
    const node = blocks(viewOf(segment.partID, segment.messageID))?.[segment.index]
    if (node) segment.node = node
    return node
  }

  // Which part each rendered answer belongs to, for option+click.
  const adopted = new WeakMap<MarkdownRenderable, { partID: string; messageID: string }>()
  function sweep() {
    const session = routeSession(api)
    if (!session) return
    const root = transcript(api.renderer.root)
    if (!root) return
    const views = markdowns(root).filter((view) => !adopted.has(view))
    if (!views.length) return
    const parts = new Map<string, { partID: string; messageID: string }>()
    for (const message of api.state.session.messages(session)) {
      if (message.role !== "assistant") continue
      for (const part of api.state.part(message.id)) {
        if (isAnswerText(part)) parts.set(part.text.trim(), { partID: part.id, messageID: message.id })
      }
    }
    for (const view of views) {
      const owner = parts.get(view.content)
      if (!owner) continue
      adopted.set(view, owner)
      view.onMouseUp = (event) => {
        const spot = pick(view, owner.partID, owner.messageID, event)
        if (spot) void exclusive(() => jump(spot))
      }
    }
  }

  let pending: ReturnType<typeof setTimeout> | undefined
  function schedule() {
    if (pending) return
    pending = setTimeout(() => {
      pending = undefined
      sweep()
    }, 120)
  }
  const offs = [api.event.on("message.part.updated", schedule), api.event.on("message.updated", schedule)]
  const timer = setInterval(sweep, SWEEP_MS)
  schedule()

  api.keymap.registerLayer({
    commands: [
      {
        name: command.toggle,
        title: "Read latest answer aloud / pause",
        category: "Speech",
        namespace: "palette",
        suggested: true,
        run() {
          void exclusive(step)
          return true
        },
      },
      {
        name: command.stop,
        title: "Stop reading aloud",
        category: "Speech",
        namespace: "palette",
        run() {
          stop()
          return true
        },
      },
      {
        name: command.restart,
        title: "Read answer from the start",
        category: "Speech",
        namespace: "palette",
        run() {
          void restart()
          return true
        },
      },
      {
        name: command.faster,
        title: "Read aloud faster",
        category: "Speech",
        namespace: "palette",
        suggested: () => status() !== "idle",
        run() {
          void speed(STEP)
          return true
        },
      },
      {
        name: command.slower,
        title: "Read aloud slower",
        category: "Speech",
        namespace: "palette",
        suggested: () => status() !== "idle",
        run() {
          void speed(-STEP)
          return true
        },
      },
    ],
    bindings: keys.gather("speech", Object.values(command)),
  })

  api.slots.register({
    order: 50,
    slots: {
      [SLOTS[placement]](_ctx: unknown, props: { session_id: string }) {
        // A bare Show here would make the slot host re-run on every status change.
        return (
          <box>
            <Show when={status() !== "idle" && sessionID() === props.session_id}>
              <Controls
                api={api}
                status={status()}
                rate={rate()}
                onToggle={() => void exclusive(step)}
                onSpeed={(delta) => void speed(delta)}
                onStop={stop}
              />
            </Show>
          </box>
        )
      },
    } as any,
  })

  api.lifecycle.onDispose(() => {
    clearInterval(timer)
    if (pending) clearTimeout(pending)
    for (const off of offs) if (typeof off === "function") off()
    stop()
    media.dispose()
  })
}

function Controls(props: {
  api: TuiPluginApi
  status: Status
  rate: number
  onToggle: () => void
  onSpeed: (delta: number) => void
  onStop: () => void
}) {
  const theme = () => props.api.theme.current
  const dimensions = useTerminalDimensions()
  // The prompt row has no room to spare on a narrow terminal, so only the
  // essentials stay; the palette commands still cover the rest.
  const full = () => dimensions().width >= COMPACT_BELOW
  return (
    <box flexDirection="row" gap={1} flexShrink={0}>
      <text fg={theme().accent} onMouseUp={props.onToggle}>
        {props.status === "playing" ? "pause" : props.status === "loading" ? "loading..." : "play"}
      </text>
      <Show when={full()}>
        <text fg={theme().textMuted} onMouseUp={() => props.onSpeed(-STEP)}>
          -
        </text>
      </Show>
      <text fg={theme().text}>{props.rate.toFixed(2).replace(/0$/, "")}x</text>
      <Show when={full()}>
        <text fg={theme().textMuted} onMouseUp={() => props.onSpeed(STEP)}>
          +
        </text>
        <text fg={theme().textMuted} onMouseUp={props.onStop}>
          stop
        </text>
      </Show>
    </box>
  )
}

function routeSession(api: TuiPluginApi) {
  const route = api.route.current
  if (route.name !== "session" || !route.params || typeof route.params.sessionID !== "string") return
  return route.params.sessionID
}

function currentAnswer(api: TuiPluginApi) {
  const sessionID = routeSession(api)
  if (!sessionID) return
  const answer = finalAnswer(api.state.session.messages(sessionID), api.state.part)
  return answer && { sessionID, ...answer }
}

/**
 * What to read when a word is clicked: the clicked message's answer when the word
 * is in it, so the cached audio is reused, otherwise its text from that part on.
 */
function answerAt(api: TuiPluginApi, spot: Spot) {
  const sessionID = routeSession(api)
  if (!sessionID) return
  const parts = api.state.part(spot.messageID)
  const answer = answerParts(parts)
  const partIDs = answer.includes(spot.partID)
    ? answer
    : parts
        .slice(parts.findIndex((part) => part.id === spot.partID))
        .filter(isAnswerText)
        .map((part) => part.id)
  return { sessionID, messageID: spot.messageID, partIDs }
}

/** Start time of the first spoken word at or after the picked spot, waiting for it to stream in. */
async function timeAt(reading: Reading, spot: Spot, resolve: (segment: Segment) => CodeRenderable | undefined) {
  const segment = reading.segments.findIndex(
    (segment) => segment.partID === spot.partID && resolve(segment) === spot.node,
  )
  if (segment < 0) return
  const { script, clip } = reading
  const char = script.segment.findIndex(
    (seg, index) => seg > segment || (seg === segment && script.offset[index] >= spot.offset),
  )
  const word = script.words.find((word) => word.end > char)
  if (char < 0 || !word) return
  while (clip.starts[word.start] === undefined && !clip.done) await clip.next()
  return clip.starts[word.start]
}

function halt(reading: Reading) {
  clearInterval(reading.timer)
  reading.timer = undefined
  const playback = reading.playback
  reading.playback = undefined
  playback?.stop()
}

function clampRate(value: unknown) {
  const rate = typeof value === "number" && Number.isFinite(value) ? value : DEFAULT_RATE
  return Math.round(Math.min(3, Math.max(0.5, rate)) * 100) / 100
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

export default { id, tui }
