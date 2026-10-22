import {
  RGBA,
  type CodeRenderable,
  type MarkdownRenderable,
  type MouseEvent,
  type Renderable,
  type SyntaxStyle,
  type TextBuffer,
  type TextChunk,
  type TextTableContent,
  type TextTableRenderable,
} from "@opentui/core"
import { tableText, type Piece, type TableText } from "./script"

export type Range = { start: number; end: number }
export type Spot = { partID: string; messageID: string; node: CodeRenderable; offset: number }
export type Colors = { background: RGBA; primary: RGBA; sentence?: RGBA; word?: RGBA }

// Html and rules have nothing to say.
const SKIP = new Set(["hr", "html", "space", "def"])
// Fences that can hold a diagram rather than source code.
const PLAIN = /^(?:text|txt|plain|plaintext)?$/i
const SENTENCE = "speech.sentence"
const WORD = "speech.word"

// Tags this plugin's ranges in a code block's text buffer.
const REF = 0x5e7c

// The block showing the spoken word, with what it takes to undo: the prose block's
// own highlight pass, the code block's buffer, or the table's chunks.
let lit:
  | {
      node: Renderable
      base?: CodeRenderable["onHighlight"]
      buffer?: TextBuffer
      original?: TextTableContent
      shown?: TextTableContent
    }
  | undefined
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

// A fence without a language renders as a CodeRenderable with no filetype.
function hasText(node: unknown): node is CodeRenderable {
  const value = node as CodeRenderable | undefined
  return typeof value?.content === "string" && value.lineInfo !== undefined
}

function isTable(node: unknown): node is TextTableRenderable {
  const value = node as TextTableRenderable | undefined
  return Array.isArray(value?.content) && "columnWidthMode" in (value as object)
}

// The transcript is the only scrollbox that sticks to the bottom.
function isTranscript(node: any) {
  return typeof node?.scrollBy === "function" &&
    ((typeof node.id === "string" && /^session:.*:transcript$/.test(node.id)) ||
      (node.stickyScroll === true && node.stickyStart === "bottom"))
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

export type Block = Piece & { node: Renderable; table?: TableText }

/**
 * The readable blocks of a rendered text part in reading order. Markdown renders each
 * paragraph, heading, and list item as a markdown-filetype CodeRenderable whose
 * content is that block's raw markdown; fenced code renders with its own filetype,
 * and a table as one TextTableRenderable. Code in a programming language is left out.
 */
export function blocks(view: MarkdownRenderable | undefined): Block[] | undefined {
  if (!view || view.isDestroyed) return
  return view._blockStates.flatMap((block): Block[] => {
    const token = block.token
    if (SKIP.has(token.type)) return []
    if (token.type === "code") {
      if (!PLAIN.test(token.lang?.trim() ?? "") || !hasText(block.renderable)) return []
      return [{ kind: "code", text: block.renderable.content, node: block.renderable }]
    }
    if (token.type === "table") {
      const table = tableText(
        token.header.map((cell) => cell.text),
        token.rows.map((row) => row.map((cell) => cell.text)),
      )
      if (!table || !isTable(block.renderable)) return []
      return [{ kind: "table", text: table.text, table, node: block.renderable }]
    }
    return prose(block.renderable).map((node) => ({ kind: "prose", text: node.content, node }))
  })
}

/**
 * Highlights the sentence and word being spoken. Prose goes through the block's
 * highlight pass. A code fence without a language has no highlight pass, so the
 * ranges go straight into its text buffer. A table is drawn from styled chunks
 * per cell, so the cells the ranges cover are redrawn with a background.
 */
export function show(node: Renderable, sentence: Range, word: Range, colors: Colors, table?: TableText) {
  if (lit?.node !== node) clear()
  if (isTable(node)) {
    if (!table) return
    const original = lit?.node === node && lit.original ? lit.original : node.content
    const shown = paint(original, table, palette(colors), sentence, word)
    node.content = shown
    lit = { node, original, shown }
    return
  }
  if (!hasText(node)) return
  if (node.filetype === "markdown") {
    register(node.syntaxStyle, colors)
    const base = lit?.node === node ? lit.base : node.onHighlight
    lit = { node, base }
    node.onHighlight = async (highlights, context) => [
      ...((await base?.(highlights, context)) ?? highlights),
      [sentence.start, sentence.end, SENTENCE],
      [word.start, word.end, WORD],
    ]
    node.requestRender()
    return
  }
  // The buffer resolves style ids against its own style table, not the block's.
  const inner = node as unknown as { textBuffer: TextBuffer; _textBufferSyntaxStyle: SyntaxStyle }
  const buffer = inner.textBuffer
  const style = inner._textBufferSyntaxStyle
  register(style, colors)
  buffer.removeHighlightsByRef(REF)
  // Buffer offsets do not count line breaks.
  const at = (offset: number) => offset - (node.content.slice(0, offset).match(/\n/g)?.length ?? 0)
  for (const [range, name] of [[sentence, SENTENCE], [word, WORD]] as const) {
    const styleId = style.getStyleId(name)
    if (styleId !== null)
      buffer.addHighlightByCharRange({ start: at(range.start), end: at(range.end), styleId, priority: 100, hlRef: REF })
  }
  lit = { node, buffer }
  node.requestRender()
}

export function clear() {
  const current = lit
  lit = undefined
  if (!current || current.node.isDestroyed) return
  if (current.buffer) current.buffer.removeHighlightsByRef(REF)
  else if (current.original && isTable(current.node)) {
    // Markdown may have rebuilt the table since; then there is nothing of ours left.
    if (current.node.content === current.shown) current.node.content = current.original
  } else if (isCode(current.node)) current.node.onHighlight = current.base
  current.node.requestRender()
}

/** The table's chunks with the cells under `sentence` and `word` given a background. */
function paint(content: TextTableContent, table: TableText, colors: { sentence: RGBA; word: RGBA }, sentence: Range, word: Range) {
  const spans = new Map<string, { start: number; end: number; bg: RGBA }[]>()
  for (const [range, bg] of [[sentence, colors.sentence], [word, colors.word]] as const) {
    const hit = new Map<string, { start: number; end: number }>()
    for (let i = range.start; i < range.end; i++) {
      const cell = table.cells[i]
      if (!cell) continue
      const key = `${cell.row}:${cell.col}`
      const span = hit.get(key)
      hit.set(key, { start: Math.min(span?.start ?? cell.at, cell.at), end: Math.max(span?.end ?? 0, cell.at + 1) })
    }
    for (const [key, span] of hit) spans.set(key, [...(spans.get(key) ?? []), { ...span, bg }])
  }
  return content.map((row, r) =>
    row.map((chunks, c) => {
      const marks = spans.get(`${r}:${c}`)
      if (!chunks || !marks) return chunks
      const plain = chunks.map((chunk) => chunk.text).join("")
      const raw = table.raw[r]?.[c] ?? ""
      const at = marks.map((mark) => ({ start: align(raw, plain, mark.start), end: align(raw, plain, mark.end), bg: mark.bg }))
      return recolor(chunks, at)
    }),
  )
}

/** Splits chunks at the mark edges; a later mark wins where two overlap. */
function recolor(chunks: TextChunk[], marks: { start: number; end: number; bg: RGBA }[]) {
  let offset = 0
  return chunks.flatMap((chunk) => {
    const from = offset
    offset += chunk.text.length
    const edges = [...new Set([from, offset, ...marks.flatMap((mark) => [mark.start, mark.end])])]
      .filter((edge) => edge >= from && edge <= offset)
      .sort((a, b) => a - b)
    return edges.slice(1).flatMap((end, index) => {
      const start = edges[index]
      if (end <= start) return []
      const bg = marks.findLast((mark) => mark.start <= start && end <= mark.end)?.bg
      return [{ ...chunk, text: chunk.text.slice(start - from, end - from), ...(bg ? { bg } : {}) }]
    })
  })
}

/** The rendered-cell offset of a raw-markdown offset: walk both, skipping concealed markers. */
function align(raw: string, plain: string, rawAt: number) {
  let at = 0
  let index = 0
  while (at < rawAt && at < raw.length) {
    if (raw[at] === plain[index]) {
      at++
      index++
    } else at++
  }
  return Math.min(index, plain.length)
}

/** Scrolls the transcript just enough to bring `node` on screen. */
export function reveal(root: Renderable, node: Renderable) {
  const scroll = transcript(root)
  if (!scroll || node.isDestroyed) return
  const top = node.y - scroll.y
  if (top >= 0 && top + Math.min(node.height, scroll.height) <= scroll.height) return
  scroll.scrollBy(top - 1)
}

// Terminals report no click count, so a double-click is two plain releases close
// in time and place. opentui marks every release on text as isDragging (a press
// starts a selection), so a drag is told apart by whether it selected anything.
const DOUBLE_MS = 400
let lastClick: { x: number; y: number; at: number; target: Renderable | null } | undefined

function doubleClick(event: MouseEvent) {
  const selection = event.target?.ctx.getSelection()
  // V2's renderer selects the word on the second press, before this release
  // handler runs. That stationary word selection is not a drag.
  const word = selection && "behavior" in selection && selection.behavior === "word" &&
    selection.anchor.x === selection.focus.x && selection.anchor.y === selection.focus.y
  if ((!word && selected(event)) || event.modifiers.shift || event.modifiers.ctrl || event.modifiers.alt) {
    lastClick = undefined
    return false
  }
  const now = Date.now()
  const hit =
    lastClick !== undefined &&
    lastClick.target === event.target &&
    now - lastClick.at <= DOUBLE_MS &&
    Math.abs(event.x - lastClick.x) <= 1 &&
    event.y === lastClick.y
  lastClick = hit ? undefined : { x: event.x, y: event.y, at: now, target: event.target }
  return hit
}

function selected(event: MouseEvent) {
  const target = event.target as { getSelectedText?: () => string } | null
  return Boolean(target?.getSelectedText?.())
}

/**
 * Option+click or a double-click on a prose word reports where in the block's raw
 * markdown it landed. Double-click exists because macOS hides the frontmost app
 * when you Option+click into a background window, and terminals never report Cmd.
 */
export function pick(view: MarkdownRenderable, partID: string, messageID: string, event: MouseEvent): Spot | undefined {
  if (event.button !== 0) return
  if (!event.modifiers.alt && !doubleClick(event)) return
  const node = blocks(view)?.find((block) => block.node === event.target)?.node
  if (!node || !hasText(node)) return
  const offset = offsetAt(node, event.x, event.y)
  if (offset === undefined) return
  view.ctx.clearSelection()
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
function register(style: SyntaxStyle | undefined, colors: Colors) {
  if (!style) return
  const { sentence, word } = palette(colors)
  const key = `${sentence.toInts()}|${word.toInts()}`
  if (styled.get(style) === key) return
  style.registerStyle(SENTENCE, { bg: sentence })
  style.registerStyle(WORD, { bg: word })
  style.clearCache()
  styled.set(style, key)
}

function palette(colors: Colors) {
  return {
    sentence: colors.sentence ?? tint(colors.background, colors.primary, 0.12),
    word: colors.word ?? tint(colors.background, colors.primary, 0.4),
  }
}

function prose(node: Renderable): CodeRenderable[] {
  if (isCode(node)) return node.filetype === "markdown" ? [node] : []
  return children(node).flatMap((child) => prose(child))
}
