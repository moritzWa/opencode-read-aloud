import { expect, test } from "bun:test"
import { language, pieces } from "../language"
import { build } from "../script"

export const email = [
  "Lando Health first: it is our top-ranked lead and already in insolvency. Its 23 November deadline is for creditor claims, not a confirmed asset sale.",
  "To: frankfurt@eckert.law\nSubject: Lando Health GmbH: Anfrage zum Erwerb klinischer Inhalte",
  "Sehr geehrter Herr Dr. Happe,",
  "ich vermittle wissenschaftliche Datenbestände an Unternehmen aus der KI-Entwicklung. Mich interessieren die kuratierten klinischen Inhalte der Lando Health GmbH, insbesondere Evidenzzusammenfassungen und klinische Handlungspfade.",
  "Stehen diese Inhalte im Insolvenzverfahren zum Verkauf oder zur Lizenzierung, gegebenenfalls getrennt von Software und Marke? Gemeint sind nur Inhalte, deren Rechte bei Lando liegen, keine personenbezogenen Daten oder kundeneigenen Krankenhausunterlagen.",
  "Falls das grundsätzlich infrage kommt, freue ich mich über eine kurze Rückmeldung zum weiteren Vorgehen und etwaigen Fristen.",
  "Mit freundlichen Grüßen\nMoritz Wallawitsch\nmoritzw.com",
  "Not sent.",
]

test("reads the English introduction, German subject/email and English ending in their own languages", () => {
  const script = build(email)
  const ranges = pieces(script.text, script.blocks)
  expect(ranges[0].language).toBe("en")
  expect(ranges.at(-1)?.language).toBe("en")
  expect(ranges.slice(1, -1).every((range) => range.language === "de")).toBe(true)
  expect(ranges.map((range) => script.text.slice(range.start, range.end)).join("")).toBe(script.text)
  expect(ranges[1].start).toBe(script.blocks[1].start)
  expect(ranges.at(-1)?.start).toBe(script.blocks.at(-1)?.start)
})

test("abstains on proper names, addresses, URLs, numbers and identifiers", () => {
  for (const text of [
    "Lando Health GmbH",
    "Moritz Wallawitsch",
    "frankfurt@eckert.law",
    "https://arca.inc",
    "123456789",
    "API",
  ]) {
    expect(language(text)).toBeUndefined()
  }
})

test("short names inherit their own block context, not the whole answer's majority language", () => {
  const script = build([
    "This is an English introduction.",
    "Moritz Wallawitsch. Vielen Dank für Ihre Rückmeldung.",
    "Not sent.",
  ])
  const ranges = pieces(script.text, script.blocks)
  expect(ranges.map((range) => range.language)).toEqual(["en", "de", "en"])
})

test("confident switches work inside a single paragraph without splitting Dr.", () => {
  const text =
    "This is an English introduction. Sehr geehrter Herr Dr. Happe, ich interessiere mich für Ihre Inhalte. Not sent."
  const ranges = pieces(text)
  expect(ranges.map((range) => range.language)).toEqual(["en", "de", "en"])
  expect(text.slice(ranges[1].start, ranges[1].end)).toContain("Dr. Happe")
})

test("limits very long sentences and preserves Unicode and exact contiguous offsets", () => {
  for (const text of ["Hallo ".repeat(1200), "😀".repeat(2100), "a".repeat(4500)]) {
    const ranges = pieces(text)
    expect(ranges.every((range) => range.end - range.start <= 2000)).toBe(true)
    expect(ranges.map((range) => text.slice(range.start, range.end)).join("")).toBe(text)
    expect(ranges.every((range) => !/[\uD800-\uDBFF]$/.test(text.slice(range.start, range.end)))).toBe(true)
  }
})

test("empty or punctuation-only text has a stable fallback", () => {
  expect(pieces("")).toEqual([])
  expect(pieces("...")).toEqual([{ start: 0, end: 3, language: "en" }])
})
