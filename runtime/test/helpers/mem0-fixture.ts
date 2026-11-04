import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {createServer} from 'node:http'

export async function provider(failDerived = false, extractedText?:string) {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let recallStarted = false
  let releaseRecall!:()=>void
  const recallGate = new Promise<void>(resolve=>{releaseRecall=resolve})
  let fail = true
  const calls: string[] = []
  let embeddingFailures = 0
  const server = createServer((request, response) => {
    void (async () => {
      let body = ''
      for await (const chunk of request) body += String(chunk)
      const input = JSON.parse(body) as {input?: string | string[]; messages?: {content: string}[]}
      response.setHeader('content-type', 'application/json')
      if (request.url === '/v1/embeddings') {
        const entries = Array.isArray(input.input) ? input.input : [input.input]
        if (entries.includes('blocked recall')) {recallStarted=true;await recallGate}
        if (failDerived && fail && entries.includes('likes apples')) { embeddingFailures++; response.statusCode = 400; response.end('{}'); return }
        response.end(JSON.stringify({data: entries.map((_, index) => ({index, embedding: [1, 0]}))}))
        return
      }
      const prompt = input.messages?.[1]?.content ?? ''
      calls.push(prompt)
      if (prompt.includes('slow kiwi')) await gate
      if (prompt.includes('retry mango') && fail) { response.statusCode = 400; response.end('{}'); return }
      const text = extractedText ?? (prompt.includes('retry mango') ? 'retry mango' : prompt.includes('slow kiwi') ? 'slow kiwi' : 'likes apples')
      response.end(JSON.stringify({choices: [{message: {content: JSON.stringify({memory: [{id: '0', text, attributed_to: 'user'}]})}}]}))
    })().catch(() => {response.statusCode = 500; response.end('{}')})
  })
  await new Promise<void>((resolve, reject) => {server.once('error', reject); server.listen(0, '127.0.0.1', resolve)})
  const address = server.address(); assert.ok(address && typeof address !== 'string')
  return {baseUrl: `http://127.0.0.1:${address.port}/v1`, calls, release, releaseRecall, get recallStarted() {return recallStarted}, get embeddingFailures() {return embeddingFailures}, recover() {fail = false}, async close() {
    release(); releaseRecall(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
  }}
}
export async function eventually(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 150; i++) {if (await check()) return; await new Promise(resolve => setTimeout(resolve, 20))}
  assert.fail('condition did not become true')
}
export const turn = (sourceId: string, text = sourceId) => ({sourceId, sessionId: 'session', sequence: 1, text, occurredAt: null})
export const userDirectory = (path: string, user = 'host-user') => `${path}.mem0/${createHash('sha256').update(user).digest('hex')}`
