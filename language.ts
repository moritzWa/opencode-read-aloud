import { francAll } from "franc-min"
import type { Range } from "./script"

export type Language = "en" | "de"
export type SpeechPiece = Range & { language: Language }

const segmenter = new Intl.Segmenter("de", { granularity: "sentence" })
// Intl's sentence segmenter still splits after titles such as "Dr.".
const ABBREVIATION = /\b(?:Dr|Prof|Mr|Mrs|Ms|Sr|Jr|e\.g|i\.e|z|d|u)\.\s*$/i
// Function words give short technical sentences evidence that character trigrams
// miss. Exclude shared words such as "in", "was", "am", "will" and "also".
const WORDS = {
  en: new Set(
    "the a an this these those it its that which who with without from for of and or but not no is are be been being have has had do does did can could should would you your we our they their my too doesn't don't isn't aren't wasn't weren't won't wouldn't couldn't shouldn't".split(
      " ",
    ),
  ),
  de: new Set(
    "der die das den dem des ein eine einer einem einen eines dieser diese dieses diesen diesem jener jene jenes ist sind sein seien nicht kein keine keiner keinen keinem keines und oder aber für von zum zur mit ohne wir unser unsere ihr ihre ihren ihrem ich mich mir sich im ins auf aus bei nach über unter durch sehr bitte vielen danke".split(
      " ",
    ),
  ),
}

/** Scores are relative trigram distances, not probabilities. Close matches abstain. */
export function language(text: string): Language | undefined {
  return detect(text)?.language
}

function detect(text: string): { language: Language; strong: boolean } | undefined {
  const sample = text
    .replace(/\S+@\S+|https?:\/\/\S+|\bwww\.\S+/g, " ")
    .replace(/(?:^|\s)(?:To|Subject|Cc|Bcc|Betreff|An):/gi, " ")
    .trim()
  // Proper names, identifiers and addresses alone aren't evidence for a language.
  if (!/\b\p{Ll}{2}/u.test(sample) || (sample.match(/\p{L}/gu)?.length ?? 0) < 6) return
  const words = new Set(
    sample
      .toLowerCase()
      .replaceAll("’", "'")
      .match(/\p{L}+(?:'\p{L}+)?/gu) ?? [],
  )
  const english = [...words].filter((word) => WORDS.en.has(word)).length
  const german = [...words].filter((word) => WORDS.de.has(word)).length
  if (Math.abs(english - german) >= 2) return { language: english > german ? "en" : "de", strong: true }
  const scores = francAll(sample, { only: ["eng", "deu"], minLength: 6 })
  if (scores.length < 2 || scores[0][1] - scores[1][1] < 0.06) return
  const selected = scores[0][0] === "deu" ? "de" : scores[0][0] === "eng" ? "en" : undefined
  if (!selected) return
  return { language: selected, strong: scores[0][1] - scores[1][1] >= 0.12 }
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
      return { ...range, block: index, language: detected?.strong ? detected.language : context?.language }
    })
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
