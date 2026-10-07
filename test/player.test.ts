import { expect, test } from "bun:test"
import { pieces } from "../player"

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
  expect(pieces("Done. Tests pass.")).toEqual([{ start: 0, end: 17 }])
})
