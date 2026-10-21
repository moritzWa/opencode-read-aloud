/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { SyntaxStyle } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { adapt, findNode } from "../v2-compat.js"
import { blocks, markdowns, show, clear, transcript } from "../view"
import { RGBA, type CodeRenderable, type Renderable } from "@opentui/core"

test("V2 stable content indices distinguish identical answers and preserve real highlight nodes", async () => {
  const output = await testRender(() => (
    <scrollbox id="session:ses_fixture:transcript">
      <box id="message:msg_old:part:1"><markdown content="Same answer twice." internalBlockMode="top-level" syntaxStyle={SyntaxStyle.create()} /></box>
      <box id="message:msg_new:part:2"><markdown content="Same answer twice." internalBlockMode="top-level" syntaxStyle={SyntaxStyle.create()} /></box>
    </scrollbox>
  ), { width: 60, height: 10 })
  try {
    await output.renderOnce()
    const old = findNode(output.renderer.root, "message:msg_old:part:1")!
    const next = findNode(output.renderer.root, "message:msg_new:part:2")!
    expect(old).not.toBe(next)
    expect(markdowns(old)[0].content).toBe(markdowns(next)[0].content)
    const deadline = Date.now() + 3000
    while ((!blocks(markdowns(next)[0])?.length || !blocks(markdowns(old)[0])?.length) && Date.now() < deadline) {
      await Bun.sleep(10)
      await output.renderOnce()
    }
    const prose = (root: Renderable) => blocks(markdowns(root)[0])![0].node as CodeRenderable
    const word = prose(next)
    const original = prose(old).onHighlight
    show(word, { start: 0, end: 18 }, { start: 5, end: 11 }, { background: RGBA.fromHex("#000000"), primary: RGBA.fromHex("#ff0000") })
    expect(word.onHighlight).toBeFunction()
    expect(prose(old).onHighlight).toBe(original)
    expect(transcript(output.renderer.root)?.id).toBe("session:ses_fixture:transcript")
  } finally {
    clear()
    output.renderer.destroy()
  }
})

test("V2 adapter maps native slots, keymap fallthrough, options, events and disposal", async () => {
  const registrations: Array<Record<string, any>> = []
  const layers: Array<Record<string, any>> = []
  const listeners: Array<(input: any) => void> = []
  const values: Record<string, unknown> = {}
  let disposed = 0
  let mode = "base"
  const context = {
    options: { legacyKV: { speech_speed: 1.9, unrelated: "do not migrate eagerly" } },
    storage: { store: () => [values, (change: (draft: object) => void) => change(values)] },
    renderer: { root: { id: "root", getChildren: () => [] } },
    data: {
      listen: (callback: (input: any) => void) => { listeners.push(callback); return () => disposed++ },
      session: { list: () => [{ id: "ses_fixture" }], message: {
        get: () => ({ type: "assistant", content: [{ type: "reasoning", text: "r" }, { type: "tool", name: "bash" }, { type: "text", text: "answer" }] }),
      } },
    },
    keymap: { layer: (factory: () => object) => layers.push(factory()), mode: { current: () => mode } },
    ui: { slot: (claim: object) => { registrations.push(claim); return () => disposed++ }, router: { current: () => ({ type: "session", sessionID: "ses_fixture" }) } },
    client: { command: { list: async () => ({ location: {}, data: [{ name: "other-command" }] }) } },
  }
  const bridge = adapt(context)
  expect(bridge.api.kv.get("speech_speed", 1.7)).toBe(1.9)
  expect(values.speech_speed).toBe(1.9)
  expect(values.unrelated).toBeUndefined()
  expect(bridge.api.state.part("msg_fixture").map((part: { id: string }) => part.id)).toEqual(["0", "1", "2"])
  bridge.api.kv.set("speech_speed", 2)
  expect(bridge.api.kv.get("speech_speed", 1.7)).toBe(2)
  bridge.api.slots.register({ slots: { session_prompt_right: () => null, session_prompt_footer: () => null } })
  expect(registrations.map((claim) => claim.append)).toEqual(["session.composer.right", "prompt.footer"])
  bridge.api.keymap.registerLayer({ commands: [{ name: "speech.toggle", run: () => true }, { name: "fallthrough", run: () => false }], bindings: [{ key: "ctrl+s", cmd: "speech.toggle" }] })
  expect(layers[0].commands[0].bind).toBe("ctrl+s")
  expect(layers[0].commands[0].run()).toBeUndefined()
  expect(layers[0].commands[1].run()).toBe(false)
  let updated = ""
  bridge.api.event.on("message.updated", (event: { properties: { sessionID: string } }) => { updated = event.properties.sessionID })
  listeners[0]({ details: { type: "session.text.delta", data: { sessionID: "ses_fixture" } } })
  expect(updated).toBe("ses_fixture")
  let idle = ""
  bridge.api.event.on("session.idle", (event: { properties: { sessionID: string } }) => { idle = event.properties.sessionID })
  listeners[1]({ details: { type: "session.execution.succeeded", data: { sessionID: "ses_fixture" } } })
  expect(idle).toBe("ses_fixture")
  expect((await bridge.api.client.command.list()).data).toEqual([{ name: "other-command" }])
  mode = "modal"
  expect(bridge.api.ui.dialog.open).toBe(true)
  await bridge.dispose()
  expect(disposed).toBe(4)
})
