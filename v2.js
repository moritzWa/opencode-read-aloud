import speech from "./index.tsx"
import { adapt } from "./v2-compat.js"

export default {
  id: "opencode-read-aloud",
  async setup(context) {
    const bridge = adapt(context)
    try {
      await speech.tui(bridge.api, context.options)
      return bridge.dispose
    } catch (error) {
      await bridge.dispose()
      throw error
    }
  },
}
