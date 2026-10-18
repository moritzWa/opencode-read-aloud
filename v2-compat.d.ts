import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { Renderable } from "@opentui/core"

export function adapt(context: unknown): {
  api: TuiPluginApi & {
    renderedPart(messageID: string, partID: string): Renderable | undefined
    renderedOwner(node: Renderable): { messageID: string; partID: string } | undefined
  }
  dispose(): Promise<void>
}

export function findNode(node: Renderable, id: string): Renderable | undefined
