import { expect, test } from "bun:test"
import type { Message, Part } from "@opencode-ai/sdk/v2"
import { finalAnswer } from "../answer"

const message = (id: string, role: "user" | "assistant") => ({ id, role }) as Message
const text = (id: string, value: string, synthetic?: boolean) => ({ id, type: "text", text: value, synthetic }) as Part
const tool = (id: string) => ({ id, type: "tool" }) as Part

test("reads only the text after the last tool call of the last answering message", () => {
  const parts: Record<string, Part[]> = {
    u1: [text("u1-text", "fix the router")],
    a1: [text("progress", "Let me check the router."), tool("t1")],
    a2: [
      text("more-progress", "Found it, editing."),
      tool("t2"),
      text("final-1", "Fixed."),
      text("final-2", "Tests pass."),
    ],
  }
  const messages = [message("u1", "user"), message("a1", "assistant"), message("a2", "assistant")]
  expect(finalAnswer(messages, (id) => parts[id] ?? [])).toEqual({ messageID: "a2", partIDs: ["final-1", "final-2"] })
})

test("falls back to an earlier message while the current step has no answer text yet", () => {
  const parts: Record<string, Part[]> = {
    a1: [text("answer", "Here is the summary.")],
    u2: [text("u2-text", "now do the other thing")],
    a2: [text("progress", "Looking."), tool("t1")],
    a3: [text("blank", "  "), text("synthetic", "injected", true)],
  }
  const messages = [
    message("a1", "assistant"),
    message("u2", "user"),
    message("a2", "assistant"),
    message("a3", "assistant"),
  ]
  expect(finalAnswer(messages, (id) => parts[id] ?? [])).toEqual({ messageID: "a1", partIDs: ["answer"] })
})
