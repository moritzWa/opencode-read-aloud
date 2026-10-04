import { RGBA, type CodeRenderable, type MarkdownRenderable, type MouseEvent, type Renderable } from "@opentui/core"

export type Range = { start: number; end: number }
export type Spot = { partID: string; messageID: string; node: CodeRenderable; offset: number }
export type Colors = { background: RGBA; primary: RGBA }

// Tables are skipped by request. Code, html and rules have nothing to say.
const SKIP = new Set(["code", "table", "hr", "html", "space", "def"])
const SENTENCE = "speech.sentence"
const WORD = "speech.word"

let lit: { node: CodeRenderable; base: CodeRenderable["onHighlight"] } | undefined
// Which style table got which colors, so a theme change re-registers them.
const styled = new WeakMap<object, string>()

function children(node: Renderable | undefined): Renderable[] {
  return typeof node?.getChildren === "function" ? (node.getChildren() as Renderable[]) : []
}

// Duck-typing rather than instanceof, the way the host's own minified classes
// are safest to recognise from outside.
function isMarkdown(node: unknown): node is MarkdownRenderable {
  const value = node as MarkdownRenderable | undefined
  return Array.isArray(value?._blockStates) && typeof value?.content === "string"
}

function isCode(node: unknown): node is CodeRenderable {
  const value = node as CodeRenderable | undefined
  return typeof value?.content === "string" && typeof value?.filetype === "string"
}

// The transcript is the only scrollbox that sticks to the bottom.
function isTranscript(node: any) {
  return typeof node?.scrollBy === "function" && node.stickyScroll === true && node.stickyStart === "bottom"
}

export function transcript(root: Renderable): (Renderable & { scrollBy(delta: number): void }) | undefined {
  if (!root || root.isDestroyed) return
  if (isTranscript(root)) return root as any
  for (const child of children(root)) {
    const hit = transcript(child)
    if (hit) return hit
  }
}

/** Every rendered markdown view in the transcript: one per assistant text part. */
export function markdowns(root: Renderable, found: MarkdownRenderable[] = []) {
  if (!root || root.isDestroyed) return found
  if (isMarkdown(root)) {
    found.push(root)
    return found
  }
  for (const child of children(root)) markdowns(child, found)
  return found
}

/**
 * The prose blocks of a rendered text part in reading order. Markdown renders each
 * paragraph, heading, and list item as a markdown-filetype CodeRenderable whose
 * content is that block's raw markdown; fenced code renders with its own filetype.
 */
export function blocks(view: MarkdownRenderable | undefined) {
  if (!view || view.isDestroyed) return
  return view._blockStates.flatMap((block) => (SKIP.has(block.token.type) ? [] : prose(block.renderable)))
}

export function show(node: CodeRenderable, sentence: Range, word: Range, colors: Colors) {
  if (lit?.node !== node) {
    clear()
    lit = { node, base: node.onHighlight }
  }
  register(node, colors)
  const base = lit.base
  node.onHighlight = async (highlights, context) => [
    ...((await base?.(highlights, context)) ?? highlights),
    [sentence.start, sentence.end, SENTENCE],
    [word.start, word.end, WORD],
  ]
  node.requestRender()
}

export function clear() {
  if (lit && !lit.node.isDestroyed) {
    lit.node.onHighlight = lit.base
    lit.node.requestRender()
  }
  lit = undefined
}

/** Scrolls the transcript just enough to bring `node` on screen. */
export function reveal(root: Renderable, node: Renderable) {
  const scroll = transcript(root)
  if (!scroll || node.isDestroyed) return
  const top = node.y - scroll.y
  if (top >= 0 && top + Math.min(node.height, scroll.height) <= scroll.height) return
  scroll.scrollBy(top - 1)
}

/** Option+click on a prose word reports where in the block's raw markdown it landed. */
export function pick(view: MarkdownRenderable, partID: string, messageID: string, event: MouseEvent): Spot | undefined {
  if (!event.modifiers.alt) return
  const node = blocks(view)?.find((node) => node === event.target)
  if (!node) return
  const offset = offsetAt(node, event.x, event.y)
  if (offset === undefined) return
  event.stopPropagation()
  return { partID, messageID, node, offset }
}

/**
 * Screen cell to raw-markdown offset. The rendered text is the raw markdown with
 * concealed markers removed, plus a space before a shown link URL, so walking
 * both in step and skipping whatever does not match lines them up.
 */
export function offsetAt(node: CodeRenderable, x: number, y: number) {
  const info = node.lineInfo
  const line = y - node.y
  if (line < 0 || line >= info.lineStartCols.length) return
  const column = info.lineStartCols[line] + Math.max(0, Math.min(x - node.x, info.lineWidthCols[line] - 1))
  const plain = node.plainText
  let index = 0
  let width = 0
  for (const char of plain) {
    width += char === "\n" ? 1 : Bun.stringWidth(char)
    if (width > column) break
    index += char.length
  }
  const raw = node.content
  let at = 0
  for (let i = 0; i < index && at < raw.length; ) {
    if (raw[at] === plain[i]) {
      at++
      i++
    } else if (/\s/.test(plain[i])) i++
    else at++
  }
  return at
}

export function tint(base: RGBA, overlay: RGBA, alpha: number): RGBA {
  const mix = (from: number, to: number) => Math.round((from + (to - from) * alpha) * 255)
  return RGBA.fromInts(mix(base.r, overlay.r), mix(base.g, overlay.g), mix(base.b, overlay.b))
}

// The host's theme has no speech styles, so they go into whatever style table
// the block renders with, tinted the way the built-in version was.
function register(node: CodeRenderable, colors: Colors) {
  const style = node.syntaxStyle
  if (!style) return
  const key = `${colors.background.toInts()}|${colors.primary.toInts()}`
  if (styled.get(style) === key) return
  style.registerStyle(SENTENCE, { bg: tint(colors.background, colors.primary, 0.12) })
  style.registerStyle(WORD, { bg: tint(colors.background, colors.primary, 0.4) })
  style.clearCache()
  styled.set(style, key)
}

function prose(node: Renderable): CodeRenderable[] {
  if (isCode(node)) return node.filetype === "markdown" ? [node] : []
  return children(node).flatMap((child) => prose(child))
}
