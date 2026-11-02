import { expect, test } from "bun:test"
import { notifyReadAloud, READ_ALOUD_START } from "../agentview"

test("every playback start can notify the enclosing Agent View before audio", () => {
  const order: string[] = []
  expect(notifyReadAloud({ AGENTVIEW_NATIVE_BRIDGE: "1" }, (value) => order.push(value))).toBe(true)
  order.push("play")
  expect(order).toEqual([READ_ALOUD_START, "play"])
})

test("standalone OpenCode emits no private terminal signal", () => {
  const output: string[] = []
  expect(notifyReadAloud({}, (value) => output.push(value))).toBe(false)
  expect(output).toEqual([])
})

test("a disconnected PTY never prevents reading", () => {
  expect(notifyReadAloud({ AGENTVIEW_NATIVE_BRIDGE: "1" }, () => { throw new Error("closed") })).toBe(false)
})
