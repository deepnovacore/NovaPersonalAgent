const catalogUrl = 'https://api.deepnovacore.com/nova/common/v1/ideas'
const maxBytes = 64 * 1024

async function readCatalog(fetcher, language) {
  const response = await fetcher(`${catalogUrl}/${language}.json`, {
    credentials: 'omit',
    redirect: 'error',
    signal: AbortSignal.timeout(4000),
  })
  if (!response.ok || !response.body) {
    await response.body?.cancel()
    throw Error('ideas_unavailable')
  }

  const reader = response.body.getReader()
  const chunks = []
  let bytes = 0
  try {
    for (;;) {
      const {value, done} = await reader.read()
      if (done) break
      bytes += value.length
      if (bytes > maxBytes) throw Error('ideas_too_large')
      chunks.push(value)
    }
  } catch (error) {
    await reader.cancel().catch(() => {})
    throw error
  } finally {
    reader.releaseLock()
  }
  const data = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(Buffer.concat(chunks)))
  if (data?.version !== 1 || data.language !== language || !Array.isArray(data.topics)) throw Error('invalid_ideas')

  const unique = new Map()
  for (const row of data.topics) {
    const {id, text} = row ?? {}
    if (typeof id !== 'string' || !/^[a-z0-9-]{1,64}$/.test(id) ||
        typeof text !== 'string' || !text.trim() ||
        text.length > 180 || /[\r\n]/.test(text)) throw Error('invalid_idea')
    if (!unique.has(id)) unique.set(id, {id, text: text.trim()})
  }
  const topics = [...unique.values()]
  const count = Math.min(6, topics.length)
  for (let i = 0; i < count; i++) {
    const j = i + Math.floor(Math.random() * (topics.length - i))
    ;[topics[i], topics[j]] = [topics[j], topics[i]]
  }
  return topics.slice(0, count)
}

export function createSharedIdeas(fetcher = fetch) {
  const samples = new Map()
  return language => {
    if (language !== 'zh' && language !== 'en') return Promise.resolve([])
    if (!samples.has(language)) {
      samples.set(language, readCatalog(fetcher, language).catch(() => {
        samples.delete(language)
        return []
      }))
    }
    return samples.get(language)
  }
}
