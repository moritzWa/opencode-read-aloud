/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { RGBA, SyntaxStyle, type CodeRenderable, type MarkdownRenderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { build, source } from "../script"
import { blocks, clear, markdowns, offsetAt, pick, show, tint } from "../view"

const colors = { background: RGBA.fromHex("#0a0a0a"), primary: RGBA.fromHex("#fab283") }

const content = `## Summary

I found the **likely bug** in \`router.ts\`. There are no tests for it.

- first item
- second item

\`\`\`ts
const skipped = true
\`\`\`

| a | b |
| - | - |
| 1 | 2 |

Final paragraph here.`

async function render(text: string, width: number, height: number) {
  let view: MarkdownRenderable | undefined
  const setup = await testRender(
    () => (
      <markdown
        ref={(el: MarkdownRenderable) => (view = el)}
        syntaxStyle={SyntaxStyle.create()}
        internalBlockMode="top-level"
        conceal={true}
        content={text}
      />
    ),
    { width, height },
  )
  const settle = async (ok: () => boolean) => {
    const start = performance.now()
    while (!ok() && performance.now() - start < 3000) {
      await Bun.sleep(16)
      await setup.renderOnce()
    }
    return ok()
  }
  const painted = (rgb: RGBA) =>
    setup
      .captureSpans()
      .lines.flatMap((line) => line.spans)
      .filter((span) => {
        const [r, g, b] = span.bg.buffer
        return Math.abs(r - rgb.r * 255) < 2 && Math.abs(g - rgb.g * 255) < 2 && Math.abs(b - rgb.b * 255) < 2
      })
      .map((span) => span.text)
      .join("")
  return { setup, settle, painted, view: () => view! }
}

test("finds the markdown view and highlights the current sentence and word", async () => {
  const { setup, settle, painted, view } = await render(content, 70, 20)

  try {
    await setup.renderOnce()
    expect(await settle(() => setup.captureCharFrame().includes("likely bug"))).toBe(true)
    expect(markdowns(setup.renderer.root)).toEqual([view()])
    const all = blocks(view())!
    expect(all.map((block) => [block.kind, block.text])).toEqual([
      ["prose", "## Summary"],
      ["prose", "I found the **likely bug** in `router.ts`. There are no tests for it."],
      ["prose", "first item"],
      ["prose", "second item"],
      ["table", "a: b\n1: 2"],
      ["prose", "Final paragraph here."],
    ])
    const nodes = all.flatMap((block) => (block.kind === "prose" ? [block.node as CodeRenderable] : []))
    expect(nodes).toHaveLength(5)

    const script = build(nodes.map((node) => node.content))
    const word = script.words.findIndex((w) => script.text.slice(w.start, w.end) === "tests")
    const sentence = script.sentences.find(
      (s) => s.start <= script.words[word].start && script.words[word].end <= s.end,
    )!
    const target = source(script, script.words[word])
    show(nodes[target.segment], source(script, sentence), target, colors)
    const wordColor = tint(colors.background, colors.primary, 0.4)
    const sentenceColor = tint(colors.background, colors.primary, 0.12)

    expect(await settle(() => painted(wordColor).includes("tests"))).toBe(true)
    expect(painted(wordColor).trim()).toBe("tests")
    expect(painted(sentenceColor)).toContain("There are no")
    expect(painted(sentenceColor)).not.toContain("likely")

    // Explicit speech colors must not inherit a neutral V2 action-text color.
    const lavender = { background: RGBA.fromHex("#ffffff"), primary: RGBA.fromHex("#111111"),
      sentence: RGBA.fromHex("#e2e2ff"), word: RGBA.fromHex("#adadff") }
    show(nodes[target.segment], source(script, sentence), target, lavender)
    expect(await settle(() => painted(lavender.word).includes("tests"))).toBe(true)
    expect(painted(lavender.word).trim()).toBe("tests")
    expect(painted(lavender.sentence)).toContain("There are no")

    clear()
    expect(await settle(() => !painted(lavender.word).includes("tests"))).toBe(true)
  } finally {
    await Bun.sleep(50)
    setup.renderer.destroy()
  }
}, 20000)

test("maps a clicked cell to its offset in the block's raw markdown", async () => {
  const { setup, settle, view } = await render(
    "I found the **likely bug** in `router.ts` and a [link](https://x.com/a) there. There are no tests\nfor it at all, which is a shame.\n\n- first **item** here",
    40,
    12,
  )
  try {
    await settle(() => setup.captureCharFrame().includes("shame"))
    const frame = setup.captureCharFrame().split("\n")
    const at = (word: string) => {
      const y = frame.findIndex((row) => new RegExp(`\\b${word}\\b`).test(row))
      const x = frame[y].search(new RegExp(`\\b${word}\\b`)) + 1
      const node = blocks(view())!.find((block) => y >= block.node.y && y < block.node.y + block.node.height)!
        .node as CodeRenderable
      const offset = offsetAt(node, x, y)!
      return node.content.slice(offset, offset + word.length - 1)
    }
    expect(at("likely")).toBe("ikely")
    expect(at("router")).toBe("outer")
    expect(at("there")).toBe("here")
    expect(at("shame")).toBe("hame")
    expect(at("item")).toBe("tem")
  } finally {
    await Bun.sleep(50)
    setup.renderer.destroy()
  }
}, 20000)

test("reads plain and text fences and the table, not code in a language", async () => {
  const { setup, settle, painted, view } = await render(
    "Steps:\n\n```\n-> deploy\n  1 build\n  2 push\n```\n\n```ts\nconst x = 1\n```\n\n```text\nA -> B\n```\n\n| Operation | What we must specify |\n| - | - |\n| `veeva.listTasks` | Connection, assignees |\n\nDone.",
    70,
    30,
  )
  try {
    await settle(() => setup.captureCharFrame().includes("Done"))
    const all = blocks(view())!
    expect(all.map((block) => block.kind)).toEqual(["prose", "code", "code", "table", "prose"])
    const script = build(all)
    expect(script.text).toBe(
      "Steps: deploy. 1 build. 2 push. A to B. Operation: What we must specify. veeva.listTasks: Connection, assignees. Done.",
    )
    const wordColor = tint(colors.background, colors.primary, 0.4)
    const sentenceColor = tint(colors.background, colors.primary, 0.12)
    const speak = (text: string) => {
      const word = script.words.find((w) => script.text.slice(w.start, w.end).replace(/[.:,]$/, "") === text)!
      const sentence = script.sentences.find((s) => s.start <= word.start && word.end <= s.end)!
      const target = source(script, word)
      const block = all[target.segment]
      show(block.node, source(script, sentence), target, colors, block.table)
    }

    speak("build")
    expect(await settle(() => painted(wordColor).includes("build"))).toBe(true)
    expect(painted(wordColor).trim()).toBe("build")
    expect(painted(sentenceColor)).not.toContain("push")

    speak("veeva.listTasks")
    expect(await settle(() => painted(wordColor).includes("veeva.listTasks"))).toBe(true)
    expect(painted(wordColor)).not.toContain("build")
    expect(painted(wordColor).trim()).toBe("veeva.listTasks")
    expect(painted(sentenceColor)).toContain("Connection, assignees")
    expect(painted(sentenceColor)).not.toContain("Operation")

    speak("assignees")
    expect(await settle(() => painted(wordColor).trim() === "assignees")).toBe(true)

    clear()
    expect(await settle(() => !painted(wordColor) && !painted(sentenceColor))).toBe(true)
    expect(setup.captureCharFrame()).toContain("veeva.listTasks")
  } finally {
    await Bun.sleep(50)
    setup.renderer.destroy()
  }
}, 20000)

test("double-clicking a table cell starts at that cell's text", async () => {
  const { setup, settle, view } = await render(
    "Intro.\n\n| Name | Role | Team |\n| - | - | - |\n| Ada | **Lead** engineer | Core |\n| Bob | Designer | |\n\nDone.",
    60,
    16,
  )
  try {
    await settle(() => setup.captureCharFrame().includes("Designer"))
    const table = blocks(view())!.find((block) => block.kind === "table")!
    const picks: string[] = []
    view().onMouseUp = (event) => {
      const spot = pick(view(), "part", "message", event)
      if (spot) picks.push(spot.node === table.node ? table.table!.text.slice(spot.offset) : "prose")
    }
    const frame = setup.captureCharFrame().split("\n")
    const click = async (word: string, shift = 0) => {
      const y = frame.findIndex((row) => row.includes(word))
      await Bun.sleep(450)
      setup.renderer.clearSelection()
      await setup.mockMouse.doubleClick(frame[y].indexOf(word) + shift, y)
    }
    expect(table.table!.text).toBe("Ada: Role **Lead** engineer; Team Core\nBob: Role Designer")
    await click("engineer", 2)
    await click("Lead")
    await click("Bob")
    await click("Name")
    await click("Designer", 4)
    expect(picks).toEqual([
      "gineer; Team Core\nBob: Role Designer",
      "**Lead** engineer; Team Core\nBob: Role Designer",
      "Bob: Role Designer",
      "Ada: Role **Lead** engineer; Team Core\nBob: Role Designer",
      "gner",
    ])
  } finally {
    await Bun.sleep(50)
    setup.renderer.destroy()
  }
}, 20000)

test("picks a word on option+click or double-click, never on a single click or drag", async () => {
  const { setup, settle, view } = await render("I found the likely bug here.", 40, 6)
  try {
    await settle(() => setup.captureCharFrame().includes("likely"))
    const picks: string[] = []
    view().onMouseUp = (event) => {
      const spot = pick(view(), "part", "message", event)
      if (spot) picks.push((spot.node as CodeRenderable).content.slice(spot.offset, spot.offset + 5))
    }
    const frame = setup.captureCharFrame().split("\n")
    const y = frame.findIndex((row) => row.includes("likely"))
    const x = frame[y].indexOf("likely") + 1

    await setup.mockMouse.click(x, y)
    expect(picks).toEqual([])
    await Bun.sleep(450)
    await setup.mockMouse.click(x, y)
    expect(picks).toEqual([])

    await Bun.sleep(450)
    setup.renderer.clearSelection()
    await setup.mockMouse.doubleClick(x, y)
    expect(picks).toEqual(["ikely"])
    expect(setup.renderer.getSelection()).toBeNull()

    await setup.mockMouse.click(x, y, undefined, { modifiers: { alt: true } })
    expect(picks).toEqual(["ikely", "ikely"])

    await Bun.sleep(450)
    await setup.mockMouse.drag(x - 4, y, x + 3, y)
    expect(setup.renderer.getSelection()?.getSelectedText().length).toBeGreaterThan(1)
    await setup.mockMouse.click(x + 3, y)
    expect(picks).toEqual(["ikely", "ikely"])

    await Bun.sleep(450)
    setup.renderer.clearSelection()
    await setup.mockMouse.click(x, y, 2)
    await setup.mockMouse.click(x, y, 2)
    expect(picks).toEqual(["ikely", "ikely"])
  } finally {
    await Bun.sleep(50)
    setup.renderer.destroy()
  }
}, 20000)
