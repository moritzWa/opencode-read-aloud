export type Range = { start: number; end: number }

/**
 * The text sent to TTS, built from the raw markdown of each prose block. Every
 * spoken character remembers which segment and raw offset it came from, because
 * the highlight is drawn in raw-markdown coordinates (the renderer conceals the
 * markers through highlights rather than removing them from its content).
 */
export type Script = {
  text: string
  segment: Int32Array
  offset: Int32Array
  words: Range[]
  sentences: Range[]
}

// Removed or rewritten when speaking: images, links (spoken as their label),
// autolinks and bare URLs, HTML tags, escapes, and emphasis/code markers. A lone
// underscore only counts as a marker at a word boundary so snake_case survives.
const INLINE =
  /!\[[^\]]*\]\([^)]*\)|\[([^\]]+)\]\([^)]*\)|\[([^\]]+)\]\[[^\]]*\]|<https?:[^>]+>|https?:\/\/\S+|<\/?[a-zA-Z][^>]*>|\\([\\`*_{}[\]()#+\-.!~|>])|\*\*|__|~~|[*`]|(?<![A-Za-z0-9])_|_(?![A-Za-z0-9])/g

// Session IDs, commit hashes and UUIDs are spoken letter by letter, so they are skipped.
// A token counts as one when a run of 7+ letters and digits in it has 3+ digits and a
// letter, which leaves names like dominic_32, simba-3.2, or iPhone15Pro.
const TOKEN = /(?<![\w-])[A-Za-z0-9][\w-]*/g
const ID_RUN = /^(?=.*[A-Za-z])(?=(?:.*\d){3})[A-Za-z0-9]{7,}$/
// Timestamps and other bare runs of 10+ digits, with the separator in front, so
// paste-1791570388182.png is read as paste.png.
const DIGITS = /[-_]?(?<![A-Za-z0-9])\d{10,}(?![A-Za-z0-9])/g
// File paths with two or more slashes are read as their last part, so
// /Users/m/.local/state/agentview/images/x.png is just x.png. Needs a letter so
// dates like 10/09/2026 survive.
const PATH = /(?<![\w.~/-])(?:~|\.{1,2})?\/?(?:[\w.@-]+\/){2,}[\w.@-]*/g

const HEADING = /^#{1,6}\s+/
const BOX = /[\u2500-\u259F]/g
const SYMBOL = /[-|+/\\_=<>*#.:^~[\]()]/g
const TERMINAL = /[.!?:;]$/

export function build(segments: readonly string[]): Script {
  const chars: string[] = []
  const segment: number[] = []
  const offset: number[] = []
  const emit = (char: string, seg: number, at: number) => {
    chars.push(char)
    segment.push(seg)
    offset.push(at)
  }

  segments.forEach((raw, seg) => {
    if (diagram(raw)) return
    const before = chars.length
    const head = raw.match(HEADING)?.[0].length ?? 0
    const ids = new Uint8Array(raw.length)
    for (const match of raw.matchAll(TOKEN))
      if (match[0].split(/[_-]/).some((run) => ID_RUN.test(run)))
        ids.fill(1, match.index, match.index + match[0].length)
    for (const match of raw.matchAll(DIGITS)) ids.fill(1, match.index, match.index + match[0].length)
    for (const match of raw.matchAll(PATH)) {
      if (!/[A-Za-z]/.test(match[0])) continue
      const trimmed = match[0].replace(/\/+$/, "")
      ids.fill(1, match.index, match.index + trimmed.lastIndexOf("/") + 1)
      ids.fill(1, match.index + trimmed.length, match.index + match[0].length)
    }
    const copy = (from: number, to: number) => {
      for (let i = from; i < to; i++) if (!ids[i]) emit(/\s/.test(raw[i]) ? " " : raw[i], seg, i)
    }
    let last = head
    for (const match of raw.slice(head).matchAll(INLINE)) {
      const at = head + match.index
      copy(last, at)
      last = at + match[0].length
      const label = match[1] ?? match[2]
      if (label !== undefined) copy(at + 1, at + 1 + label.length)
      if (match[3] !== undefined) emit(match[3], seg, at + 1)
    }
    copy(last, raw.length)

    const spoken = chars.slice(before).join("").trim()
    if (!spoken) {
      chars.length = segment.length = offset.length = before
      return
    }
    while (chars.length > before && chars[chars.length - 1] === " ") {
      chars.pop()
      segment.pop()
      offset.pop()
    }
    // A heading or list item has no terminal punctuation; without one the voice
    // runs it straight into the next block.
    if (!TERMINAL.test(spoken)) emit(".", seg, offset[offset.length - 1])
    emit(" ", seg, offset[offset.length - 1])
  })
  while (chars.length && chars[chars.length - 1] === " ") {
    chars.pop()
    segment.pop()
    offset.pop()
  }

  const text = chars.join("")
  const words = [...text.matchAll(/\S+/g)].map((m) => ({ start: m.index, end: m.index + m[0].length }))
  return {
    text,
    segment: Int32Array.from(segment),
    offset: Int32Array.from(offset),
    words,
    sentences: sentences(text, segment, words),
  }
}

/** The raw-markdown range in one segment that a spoken range covers. */
export function source(script: Script, range: Range) {
  return {
    segment: script.segment[range.start],
    start: script.offset[range.start],
    end: script.offset[range.end - 1] + 1,
  }
}

/** Index of the word being spoken at `time`, given each spoken character's start time. */
export function wordAt(script: Script, starts: ArrayLike<number>, time: number) {
  let lo = 0
  let hi = script.words.length - 1
  if (hi < 0 || time < (starts[script.words[0].start] ?? 0)) return -1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if ((starts[script.words[mid].start] ?? Infinity) <= time) lo = mid
    else hi = mid - 1
  }
  return lo
}

/**
 * Box-drawing characters, or several lines that are mostly punctuation, mean an
 * unfenced diagram. Reading one aloud is a stream of "dash dash pipe".
 */
export function diagram(raw: string) {
  if ((raw.match(BOX)?.length ?? 0) >= 2) return true
  const lines = raw.split("\n").filter((line) => line.trim())
  if (lines.length < 2) return false
  const dense = lines.filter((line) => {
    const visible = line.replace(/\s/g, "").length
    return visible > 0 && (line.match(SYMBOL)?.length ?? 0) / visible > 0.4
  })
  return dense.length / lines.length >= 0.5
}

function sentences(text: string, segment: number[], words: Range[]) {
  return words.reduce<Range[]>((out, word, index) => {
    const current = out[out.length - 1]
    const previous = words[index - 1]
    const split =
      !current ||
      segment[word.start] !== segment[previous.start] ||
      /[.!?]["')\]]*$/.test(text.slice(previous.start, previous.end))
    if (split) out.push({ start: word.start, end: word.end })
    else current.end = word.end
    return out
  }, [])
}
