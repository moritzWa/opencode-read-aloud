import { expect, test } from "bun:test"
import { build, diagram, source, wordAt } from "../script"

test("speaks prose without markdown markers and maps back to raw offsets", () => {
  const raw = "I found the **likely bug** in `router.ts`."
  const script = build([raw])
  expect(script.text).toBe("I found the likely bug in router.ts.")
  const likely = script.words[3]
  expect(script.text.slice(likely.start, likely.end)).toBe("likely")
  const hit = source(script, likely)
  expect(raw.slice(hit.start, hit.end)).toBe("likely")
  const file = source(script, script.words[6])
  expect(raw.slice(file.start, file.end)).toBe("router.ts`.")
})

test("reads link labels, drops urls, images, and heading markers", () => {
  const script = build(["## Summary", "See [the docs](https://x.y) or https://a.b/c ![alt](i.png) now"])
  expect(script.text).toBe("Summary. See the docs or   now.")
  const docs = source(script, script.words[3])
  expect(docs.segment).toBe(1)
})

test("keeps snake_case and escapes", () => {
  expect(build(["use my_var and \\*not\\* _this_"]).text).toBe("use my_var and *not* this.")
})

test("skips session ids, commit hashes and uuids but keeps names with numbers", () => {
  const raw =
    "One agent (session `ses_ee8a1a16affePZKE8lcTj934Yk`) at 7220bdb427, id 550e8400-e29b-41d4-a716-446655440000."
  expect(build([raw]).text).toBe("One agent (session ) at , id .")
  const names = "Use dominic_32 on simba-3.2, mp3_24000_128, iPhone15Pro, UTF-16 and 2026 in router.ts."
  expect(build([names]).text).toBe(names)
})

test("reads file paths as their last part and drops long digit runs", () => {
  expect(build(["Saved to /Users/m/.local/state/agentview/images/paste-1791570388182.png now."]).text).toBe(
    "Saved to paste.png now.",
  )
  expect(build(["Edit `packages/opencode/src/x.ts` and ~/Code/opencode/ here."]).text).toBe(
    "Edit x.ts and opencode here.",
  )
  const kept = "Read src/x.ts, and/or wait until 10/09/2026."
  expect(build([kept]).text).toBe(kept)
})

test("skips ascii and box diagrams", () => {
  expect(diagram("┌──────┐\n│ box  │\n└──────┘")).toBe(true)
  expect(diagram("+------+\n| node |--->\n+------+")).toBe(true)
  expect(diagram("A normal sentence - with a dash.\nAnd another line.")).toBe(false)
  expect(build(["Before.", "+---+\n| a |\n+---+", "After."]).text).toBe("Before. After.")
})

test("splits sentences on terminal punctuation and block boundaries", () => {
  const script = build(["One two. Three?", "Heading"])
  expect(script.sentences.map((s) => script.text.slice(s.start, s.end))).toEqual(["One two.", "Three?", "Heading."])
})

test("finds the word being spoken from character start times", () => {
  const script = build(["aa bb cc"])
  const starts = [0, 0.1, 0.2, 0.5, 0.6, 0.7, 1.0, 1.1]
  expect(wordAt(script, starts, 0.05)).toBe(0)
  expect(wordAt(script, starts, 0.55)).toBe(1)
  expect(wordAt(script, starts, 3)).toBe(2)
})
