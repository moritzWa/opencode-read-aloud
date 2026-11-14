import { detector } from "./detector.js"
import type { Range } from "./script"

export type Language = "en" | "de"
export type SpeechPiece = Range & { language: Language }

const segmenter = new Intl.Segmenter("de", { granularity: "sentence" })
// Intl's sentence segmenter still splits after titles such as "Dr.".
const ABBREVIATION = /\b(?:Dr|Prof|Mr|Mrs|Ms|Sr|Jr|e\.g|i\.e|z|d|u)\.\s*$/i

/** Scores are model matches, not probabilities. Close matches abstain. */
export function language(text: string): Language | undefined {
  return detect(text)?.language
}

function detect(text: string): { language: Language; strong: boolean } | undefined {
  const sample = text
    .replace(/\S+@\S+|https?:\/\/\S+|\bwww\.\S+/g, " ")
    .replace(/(?:^|\s)(?:To|Subject|Cc|Bcc|Betreff|An):/gi, " ")
    .trim()
  if ((sample.match(/\p{L}/gu)?.length ?? 0) < 6) return
  const result = detector.detect(sample.replaceAll("’", "'"))
  if (result.language !== "en" && result.language !== "de") return
  const scores = result.getScores()
  const score = scores[result.language] ?? 0
  const margin = score - (scores[result.language === "en" ? "de" : "en"] ?? 0)
  if (score < 0.55 || margin < 0.06) return
  // Title-cased names need more evidence than ordinary prose. This still accepts
  // German greetings such as "Vielen Dank" and "Guten Morgen".
  if (!/\b\p{Ll}{2}/u.test(sample) && (margin < 0.25 || !result.isReliable())) return
  return { language: result.language, strong: margin >= 0.2 && (result.isReliable() || margin >= 0.5) }
}

/** Preserve every UTF-16 offset: detection never rewrites the spoken script. */
export function pieces(text: string, blocks: readonly Range[] = [{ start: 0, end: text.length }]): SpeechPiece[] {
  const sentences = blocks.flatMap((block, index) => {
    const ranges = [...segmenter.segment(text.slice(block.start, block.end))].reduce<Range[]>((ranges, part) => {
      const start = block.start + part.index
      const previous = ranges.at(-1)
      if (previous && ABBREVIATION.test(text.slice(previous.start, previous.end))) {
        previous.end = start + part.segment.length
        return ranges
      }
      ranges.push({ start, end: start + part.segment.length })
      return ranges
    }, [])
    const context = detect(text.slice(block.start, block.end))
    return ranges.map((range) => {
      const detected = detect(text.slice(range.start, range.end))
      return {
        ...range,
        block: index,
        language: !detected ? undefined : detected.strong ? detected.language : context?.language,
      }
    })
  })
  const certain = sentences.filter((sentence) => sentence.language !== undefined)
  const ranges: SpeechPiece[] = []
  for (const sentence of sentences) {
    const same = certain.filter((candidate) => candidate.block === sentence.block)
    const context = (same.length ? same : certain).reduce<(typeof certain)[number] | undefined>((best, candidate) => {
      const distance = Math.max(0, candidate.start - sentence.end, sentence.start - candidate.end)
      return !best || distance < Math.max(0, best.start - sentence.end, sentence.start - best.end) ? candidate : best
    }, undefined)
    const selected = sentence.language ?? context?.language ?? "en"
    let start = sentence.start
    while (start < sentence.end) {
      const limit = Math.min(sentence.end, start + 2000)
      const space = text.lastIndexOf(" ", limit)
      const end =
        limit === sentence.end
          ? limit
          : space > start
            ? space + 1
            : limit - (/[\uD800-\uDBFF]/.test(text[limit - 1]) ? 1 : 0)
      const previous = ranges.at(-1)
      const size = Math.min(2000, 200 * 3 ** Math.max(0, ranges.length - 1))
      if (
        previous &&
        previous.language === selected &&
        previous.end === start &&
        previous.end - previous.start < size &&
        end - previous.start <= 2000
      ) {
        previous.end = end
      } else {
        ranges.push({ start, end, language: selected })
      }
      start = end
    }
  }
  return ranges
}
