import { francAll } from "franc-min"
import type { Range } from "./script"

export type Language = "en" | "de"
export type SpeechPiece = Range & { language: Language }

const segmenter = new Intl.Segmenter("de", { granularity: "sentence" })
// Intl's sentence segmenter still splits after titles such as "Dr.".
const ABBREVIATION = /\b(?:Dr|Prof|Mr|Mrs|Ms|Sr|Jr|e\.g|i\.e|z|d|u)\.\s*$/i

/** Scores are relative trigram distances, not probabilities. Close matches abstain. */
export function language(text: string): Language | undefined {
  const sample = text
    .replace(/\S+@\S+|https?:\/\/\S+|\bwww\.\S+/g, " ")
    .replace(/(?:^|\s)(?:To|Subject|Cc|Bcc|Betreff|An):/gi, " ")
    .trim()
  // Proper names, identifiers and addresses alone aren't evidence for a language.
  if (!/\b\p{Ll}{2}/u.test(sample) || (sample.match(/\p{L}/gu)?.length ?? 0) < 6) return
  const scores = francAll(sample, { only: ["eng", "deu"], minLength: 6 })
  if (scores.length < 2 || scores[0][1] - scores[1][1] < 0.06) return
  return scores[0][0] === "deu" ? "de" : scores[0][0] === "eng" ? "en" : undefined
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
    return ranges.map((range) => ({ ...range, block: index, language: language(text.slice(range.start, range.end)) }))
  })
  const certain = sentences.filter((sentence) => sentence.language !== undefined)
  const ranges: SpeechPiece[] = []
  for (const sentence of sentences) {
    const same = certain.filter((candidate) => candidate.block === sentence.block)
    const context = (same.length ? same : certain).reduce<(typeof certain)[number] | undefined>((best, candidate) => {
      const distance = Math.abs(candidate.start - sentence.start)
      return !best || distance < Math.abs(best.start - sentence.start) ? candidate : best
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
