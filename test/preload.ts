import { afterAll } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

// Module-level player paths must resolve before any test imports the plugin.
// Never read real credentials, use the speech cache or append to live TUI logs.
const directory = await mkdtemp(path.join(os.tmpdir(), "read-aloud-tests-"))
process.env.XDG_DATA_HOME = path.join(directory, "data")
process.env.XDG_CACHE_HOME = path.join(directory, "cache")
process.env.XDG_STATE_HOME = path.join(directory, "state")
delete process.env.SPEECHIFY_API_KEY
delete process.env.ELEVENLABS_API_KEY

afterAll(() => rm(directory, { recursive: true, force: true }))
