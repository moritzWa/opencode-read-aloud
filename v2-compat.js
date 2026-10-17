/** Compatibility boundary for the V2 TUI host. Algorithms keep using the V1
 * facade; all persisted state, event, slot and keymap registrations are native V2.
 * No private host modules or live server/config paths are imported. */
export function adapt(context) {
  const disposals = []
  const [saved, save] = context.storage.store("v1-options", { initial: {} })
  const route = () => {
    const current = context.ui.router.current()
    return { name: current.type, params: current.type === "session" ? { sessionID: current.sessionID } : {} }
  }
  const messages = (sessionID) => context.data.session.message.list(sessionID)
  const findMessage = (messageID) => {
    const current = context.ui.router.current()
    if (current.type === "session") {
      const message = context.data.session.message.get(current.sessionID, messageID)
      if (message) return { message, sessionID: current.sessionID }
    }
    for (const session of context.data.session.list()) {
      const message = context.data.session.message.get(session.id, messageID)
      if (message) return { message, sessionID: session.id }
    }
  }
  const theme = () => ({
    background: context.theme.background.base,
    backgroundElement: context.theme.background.raised.base,
    primary: context.theme.text.action.primary.base,
    accent: context.theme.text.action.primary.base,
    text: context.theme.text.base,
    textMuted: context.theme.text.muted,
    error: context.theme.text.feedback.error.base,
    success: context.theme.text.feedback.success.base,
  })
  const part = (messageID) => {
    const found = findMessage(messageID)
    if (!found || found.message.type !== "assistant") return []
    return found.message.content.map((part, index) => ({
      ...part, id: String(index), messageID, sessionID: found.sessionID,
      tool: part.name,
    }))
  }
  const api = {
    renderer: context.renderer,
    // A stable wrapper scopes markdown lookup to an identity rather than its
    // text, so identical paragraphs in old/new answers cannot get mixed up.
    renderedPart: (messageID, partID) => findNode(context.renderer.root, `message:${messageID}:part:${partID}`),
    renderedOwner: (node) => {
      for (let current = node; current; current = current.parent) {
        const match = /^message:([^:]+):part:(\d+)$/.exec(current.id ?? "")
        if (match) return { messageID: match[1], partID: match[2] }
      }
    },
    state: {
      part,
      path: { get directory() { return context.location?.directory ?? context.data.location.default().directory } },
      session: {
        get: (id) => {
          const value = context.data.session.get(id)
          return value && { ...value, directory: value.location.directory }
        },
        messages: (sessionID) => messages(sessionID).map((message) => ({ ...message, role: message.type === "assistant" ? "assistant" : "user" })),
      },
    },
    kv: { get: (key, fallback) => saved[key] ?? fallback, set: (key, value) => void save((draft) => { draft[key] = value }) },
    theme: { get current() { return theme() } },
    route: {
      get current() { return route() },
      navigate: (name, params) => context.ui.router.navigate({ type: name, ...params }),
    },
    event: {
      on(type, callback) {
        // V2 publishes granular session.message events instead of V1 part
        // events. Listen once to the native stream and preserve session scope.
        const off = context.data.listen(({ details: event }) => {
          const p = event.data ?? event.properties ?? event
          if (type === "session.idle" && [type, "session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"].includes(event.type)) callback({ type, properties: p })
          if ((type === "message.updated" || type === "message.part.updated") && /^session\.(?:message|text|step|tool|reasoning)\./.test(event.type)) callback({ type, properties: p })
        })
        disposals.push(off)
        return off
      },
    },
    lifecycle: { onDispose: (callback) => disposals.push(callback) },
    ui: {
      toast: (input) => context.ui.toast.show(input),
      DialogPrompt: (input) => context.ui.dialog.prompt(input),
      DialogConfirm: (input) => context.ui.dialog.confirm(input),
      DialogSelect: (input) => context.ui.dialog.select(input),
      dialog: { get open() { return ["dialog", "modal"].includes(context.keymap.mode.current()) } },
    },
    keymap: {
      registerLayer(layer) {
        const bindings = layer.bindings ?? []
        const commands = (layer.commands ?? []).map((command) => {
          const keys = bindings.filter((binding) => binding.cmd === command.name).map((binding) => binding.key)
          return {
            id: command.name, title: command.title, description: command.desc, group: command.category,
            suggested: command.suggested,
            palette: command.hidden ? undefined : true,
            ...(command.slashName ? { slash: { name: command.slashName, aliases: command.slashAliases } } : {}),
            bind: keys.length ? keys.join(",") : false,
            run: (input, event) => {
              const value = command.run({ focused: context.renderer.currentFocusedRenderable, event, input })
              // V1 uses true for handled; V2 uses void and false for fallthrough.
              return value instanceof Promise ? value.then((result) => result === false ? false : undefined) : value === false ? false : undefined
            },
          }
        })
        for (const binding of bindings) {
          if (typeof binding.cmd !== "function") continue
          commands.push({ bind: binding.key, run: (_input, event) => binding.cmd({ focused: context.renderer.currentFocusedRenderable, event }) === false ? false : undefined })
        }
        context.keymap.layer(() => ({ mode: layer.mode, priority: layer.priority, commands }))
        // Native keymap layers are disposed with the plugin's Solid owner.
        return () => {}
      },
      dispatchCommand: (name) => context.keymap.dispatch(name),
      getCommandEntries: () => context.keymap.commands().map((command) => ({ command: { ...command, slashName: command.slash?.name, slashAliases: command.slash?.aliases } })),
    },
    slots: {
      register(registration) {
        const paths = { session_prompt_right: "session.composer.right", session_prompt_footer: "prompt.footer" }
        for (const [name, render] of Object.entries(registration.slots)) {
          const path = paths[name]
          if (!path) throw new Error(`V2 has no mapping for slot ${name}`)
          disposals.push(context.ui.slot({ append: path, render: (input) => render(undefined, { get session_id() { return input.sessionID } }) }))
        }
      },
    },
    client: {
      command: { list: async () => {
        const result = await context.client.command.list({ location: context.location })
        return { data: result.data ?? result }
      } },
      session: {
        create: async () => ({ data: await context.client.session.create({ location: context.location }) }),
        command: async (input) => context.client.session.command({ sessionID: input.sessionID, name: input.command, text: input.arguments ?? "" }),
      },
    },
  }
  return { api, dispose: async () => { for (const dispose of disposals.toReversed()) await dispose() } }
}

export function findNode(node, id) {
  if (!node || node.isDestroyed) return
  if (node.id === id) return node
  for (const child of node.getChildren?.() ?? []) {
    const found = findNode(child, id)
    if (found) return found
  }
}
