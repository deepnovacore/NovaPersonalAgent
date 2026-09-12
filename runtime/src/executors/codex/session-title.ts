function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A separate ephemeral turn; its id must never replace the user's persistent thread binding. */
export async function generateSessionTitle(objective: string, rpc: {
  readonly mcpServers?: readonly string[]
  request(method: string, params: Record<string, unknown>): Promise<unknown>
  subscribe(listener: (method: string, params: Record<string, unknown>) => void): () => void
}): Promise<string | null> {
  let threadId: string | null = null
  let text = ''
  let complete: (value: boolean) => void = () => undefined
  const done = new Promise<boolean>(resolve => { complete = resolve })
  const unsubscribe = rpc.subscribe((method, params) => {
    if (threadId === null || params.threadId !== threadId) return
    if (method === 'item/completed' && isPlainObject(params.item)
      && params.item.type === 'agentMessage' && typeof params.item.text === 'string') text = params.item.text
    if (method === 'turn/completed' && isPlainObject(params.turn)) complete(params.turn.status === 'completed')
    if (method === 'error') complete(false)
  })
  const timeout = setTimeout(() => complete(false), 10_000)
  try {
    const response = await rpc.request('thread/start', {
      model: 'gpt-5.6-luna', ephemeral: true, permissions: ':read-only', approvalPolicy: 'never',
      config: {model_reasoning_effort: 'low', web_search: 'disabled',
        mcp_servers: Object.fromEntries((rpc.mcpServers ?? []).map(name => [name, {enabled: false}])),
        'features.apps': false, 'features.plugins': false, 'features.multi_agent': false, 'features.hooks': false},
      baseInstructions: 'Generate a concise task title in the user language. Do not execute the task or call tools.',
    })
    if (!isPlainObject(response) || !isPlainObject(response.thread) || typeof response.thread.id !== 'string') return null
    threadId = response.thread.id
    await rpc.request('turn/start', {
      threadId,
      input: [{type: 'text', text: `Summarize this task as a short title (up to 36 characters):\n${objective.slice(0, 4000)}`}],
      outputSchema: {type: 'object', properties: {title: {type: 'string', minLength: 1, maxLength: 36}}, required: ['title'], additionalProperties: false},
    })
    if (!await done) return null
    const result: unknown = JSON.parse(text)
    if (!isPlainObject(result) || typeof result.title !== 'string') return null
    const title = result.title.replace(/\s+/gu, ' ').trim()
    return title.length > 0 && [...title].length <= 36 ? title : null
  } catch { return null } finally {
    clearTimeout(timeout)
    unsubscribe()
    if (threadId !== null) await rpc.request('thread/unsubscribe', {threadId}).catch(() => undefined)
  }
}
