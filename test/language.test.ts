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

test("English technical sentences do not switch to German, with or without paragraph context", () => {
  for (const acronym of ["BCS-2", "BCS 2", "BCS", ""]) {
    for (const apostrophe of ["'", "’"]) {
      const sentence = `It doesn${apostrophe}t establish that ${acronym} automates poorly.`
      expect(language(sentence)).toBe("en")
      expect(pieces(sentence).every((range) => range.language === "en")).toBe(true)
      const paragraphs = [
        "My earlier advice was too categorical. The call supports your lightweight pipeline idea.",
        sentence,
      ]
      const script = build(paragraphs)
      expect(pieces(script.text, script.blocks).every((range) => range.language === "en")).toBe(true)
      expect(pieces(paragraphs.join(" ")).every((range) => range.language === "en")).toBe(true)
    }
  }
})

test("weak sentence guesses inherit the paragraph, while clear German still switches", () => {
  const text =
    "The request is ready and you can send it. Subject: Lando Health GmbH. Das ist eine deutsche Antwort und keine englische Zusammenfassung. Not sent."
  const ranges = pieces(text)
  expect(ranges.map((range) => range.language)).toEqual(["en", "de", "en"])
  expect(text.slice(ranges[0].start, ranges[0].end)).toContain("Subject: Lando Health GmbH")
})
