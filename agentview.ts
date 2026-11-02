import { writeSync } from "node:fs"

// A private OSC on the enclosing PTY. Agent View handles it like Cmd+S;
// no server, credential, shared file, or keybinding is needed.
export const READ_ALOUD_START = "\x1b]777;av;tts\x07"

export function notifyReadAloud(
  env: Record<string, string | undefined> = process.env,
  write: (text: string) => unknown = (text) => writeSync(process.stdout.fd, text),
) {
  if (env.AGENTVIEW_NATIVE_BRIDGE !== "1") return false
  try {
    write(READ_ALOUD_START)
    return true
  } catch {
    // Standalone/disconnected output must not prevent reading.
    return false
  }
}
