import type { Message, Part, TextPart } from "@opencode-ai/sdk/v2"

/**
 * The text a reader would call the answer: the last assistant message with text,
 * and only the text after its last tool call, so "let me check the router" style
 * progress lines from earlier steps are not read.
 */
export function finalAnswer(messages: readonly Message[], parts: (messageID: string) => readonly Part[]) {
  return messages
    .toReversed()
    .filter((message) => message.role === "assistant")
    .map((message) => ({ messageID: message.id, partIDs: answerParts(parts(message.id)) }))
    .find((answer) => answer.partIDs.length > 0)
}

export function answerParts(parts: readonly Part[]) {
  return parts
    .slice(parts.findLastIndex((part) => part.type === "tool") + 1)
    .filter(isAnswerText)
    .map((part) => part.id)
}

export function isAnswerText(part: Part): part is TextPart {
  return part.type === "text" && !part.synthetic && part.text.trim().length > 0
}
