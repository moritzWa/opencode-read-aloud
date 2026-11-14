import os from "node:os"
import path from "node:path"
import { mkdir } from "node:fs/promises"
import { load, speechify, type Provider } from "../player"
import { build } from "../script"

// Generates files only. It never opens an audio device or changes plugin settings.
const directory = path.resolve(process.argv[2] ?? path.join(os.homedir(), "Desktop", "tts-voice-comparison"))
const candidates = [
  {
    id: "dominic-30",
    name: "Dominic",
    voice: "dominic",
    model: "simba-3.0",
    label: "Same speaker",
    note: "Your current English voice, speaking German. Listen for an English accent.",
  },
  {
    id: "dominic-35",
    name: "Dominic · 3.5",
    voice: "dominic",
    model: "simba-3.5",
    label: "Same speaker, newer model",
    note: "The same voice on Speechify's newer multilingual model. Accent may still sound English.",
  },
  {
    id: "henrik",
    name: "Henrik",
    voice: "henrik-agent",
    model: "simba-3.0",
    label: "Current German voice",
    note: "Native German. Speechify describes him as resonant, low-pitched and deep.",
  },
  {
    id: "benedikt",
    name: "Benedikt",
    voice: "benedikt-agent",
    model: "simba-3.0",
    label: "Native German alternative",
    note: "Speechify's third German staff pick. Described as easygoing and neutral.",
  },
  {
    id: "frederick",
    name: "Frederick",
    voice: "frederick",
    model: "simba-3.0",
    label: "Native German, deep timbre",
    note: "Catalogued as a deep German narration voice. Compare the speaker change, not just pitch.",
  },
  {
    id: "linus",
    name: "Linus",
    voice: "linus",
    model: "simba-3.0",
    label: "Native German, deep / neutral",
    note: "Catalogued as deep and neutral. Included as another possible match, not a claimed winner.",
  },
]
const passages = [
  {
    id: "short",
    label: "Short German",
    parts: [
      "Vielen Dank für Ihre Rückmeldung. Ich interessiere mich für die wissenschaftlichen Inhalte und freue mich auf das weitere Gespräch.",
    ],
  },
  {
    id: "email",
    label: "Email excerpt",
    parts: [
      "Sehr geehrter Herr Dr. Happe, ich vermittle wissenschaftliche Datenbestände an Unternehmen aus der KI-Entwicklung. Stehen diese Inhalte im Insolvenzverfahren zum Verkauf oder zur Lizenzierung? Mit freundlichen Grüßen, Moritz Wallawitsch.",
    ],
  },
  {
    id: "switch",
    label: "English → German → English",
    parts: [
      "Here is the email draft. It is ready for your review.",
      "Vielen Dank für Ihre Rückmeldung. Ich interessiere mich für die wissenschaftlichen Inhalte.",
      "The email has not been sent.",
    ],
  },
]
const keys = [
  path.join(os.homedir(), ".local/share/opencode-v2/data/opencode/speechify.key"),
  path.join(os.homedir(), ".local/share/opencode/speechify.key"),
]
const key =
  process.env.SPEECHIFY_API_KEY ||
  (await keys.reduce(async (previous, file) => {
    const found = await previous
    if (found) return found
    return (await Bun.file(file).exists()) ? (await Bun.file(file).text()).trim() : ""
  }, Promise.resolve("")))
if (!key) throw new Error("No configured Speechify API key")
await mkdir(path.join(directory, "audio"), { recursive: true })
const samples = []
for (const candidate of candidates) {
  const provider: Provider = {
    name: "speechify",
    env: "SPEECHIFY_API_KEY",
    keyFile: "",
    voice: "dominic",
    model: "simba-3.0",
    german: { voice: candidate.voice, model: candidate.model },
    synthesize: speechify,
  }
  for (const passage of passages) {
    const script = build(passage.parts)
    const clip = await load(script.text, script.blocks, { provider, key, directory: path.join(directory, ".cache") })
    clip.need(script.text.length - 1)
    while (!clip.done) await clip.next()
    if (clip.error) throw clip.error
    const file = `audio/${candidate.id}-${passage.id}.mp3`
    await Bun.write(path.join(directory, file), new Blob(clip.chunks as BlobPart[]))
    samples.push({
      candidate: candidate.id,
      passage: passage.id,
      file,
      duration: clip.duration,
      chars: clip.starts.length,
    })
    console.log("Generated", candidate.id, passage.id, clip.duration?.toFixed(2), "seconds")
  }
}
const reference = build([
  "My earlier advice was too categorical. The call supports your lightweight pipeline idea. It doesn't establish that BCS-2 automates poorly.",
])
const clip = await load(reference.text, reference.blocks, {
  provider: {
    name: "speechify",
    env: "SPEECHIFY_API_KEY",
    keyFile: "",
    voice: "dominic",
    model: "simba-3.0",
    synthesize: speechify,
  },
  key,
  directory: path.join(directory, ".cache"),
})
clip.need(reference.text.length - 1)
while (!clip.done) await clip.next()
if (clip.error) throw clip.error
await Bun.write(path.join(directory, "audio/english-reference.mp3"), new Blob(clip.chunks as BlobPart[]))
const data = { candidates, passages, samples, reference: { text: reference.text, file: "audio/english-reference.mp3" } }
await Bun.write(path.join(directory, "samples.json"), JSON.stringify(data, null, 2))
const html = await Bun.file(new URL("./voice-comparison.html", import.meta.url)).text()
await Bun.write(
  path.join(directory, "index.html"),
  html.replace("null /* SAMPLE_DATA */", JSON.stringify(data).replaceAll("<", "\\u003c")),
)
console.log("Comparison ready:", path.join(directory, "index.html"))
