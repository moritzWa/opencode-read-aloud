/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { RGBA, SyntaxStyle, type MarkdownRenderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { build, source } from "../script"
import { blocks, clear, markdowns, offsetAt, show, tint } from "../view"

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
  return { setup, settle, view: () => view! }
}

test("finds the markdown view and highlights the current sentence and word", async () => {
  const { setup, settle, view } = await render(content, 70, 20)
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

  try {
    await setup.renderOnce()
    expect(await settle(() => setup.captureCharFrame().includes("likely bug"))).toBe(true)
    expect(markdowns(setup.renderer.root)).toEqual([view()])
    const nodes = blocks(view())!
    expect(nodes.map((node) => node.content)).toEqual([
      "## Summary",
      "I found the **likely bug** in `router.ts`. There are no tests for it.",
      "first item",
      "second item",
      "Final paragraph here.",
    ])

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

    clear()
    expect(await settle(() => !painted(wordColor).includes("tests"))).toBe(true)
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
      const node = blocks(view())!.find((node) => y >= node.y && y < node.y + node.height)!
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
