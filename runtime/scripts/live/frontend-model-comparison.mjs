/** Synthetic frontend comparison. No returned tool call is executed.
 * node runtime/scripts/live/frontend-model-comparison.mjs --repeats 5 --output /tmp/qwen-comparison.json
 * Build runtime first. Credentials come from .env or the process environment; never recorded.
 */
import assert from 'node:assert/strict'
import {readFile, writeFile, mkdir} from 'node:fs/promises'
import {resolve, dirname} from 'node:path'
import {parseArgs, parseEnv} from 'node:util'
import {configuration, runTextCase} from './text-tools.mjs'
import {createQwenCascadedLlmFactory} from '../../dist/src/realtime/cascaded/qwen-llm.js'

const {values} = parseArgs({options: {repeats: {type: 'string', default: '5'}, output: {type: 'string'}, models: {type: 'string'}}})
const repeats = Number(values.repeats)
assert.ok(Number.isInteger(repeats) && repeats > 0 && repeats <= 20)
assert.ok(values.output, '--output required')
const root = resolve(import.meta.dirname, '../../..')
const env = {...parseEnv(await readFile(resolve(root, '.env'), 'utf8')), ...process.env}
const ids = ['greeting', 'coding', 'coding-steer', 'coding-cancel', 'confirm-yes', 'confirm-no',
  'confirm-ambiguous', 'confirm-question', 'coding-discussion', 'coding-clarify-before-dispatch',
  'coding-clarification-still-unresolved', 'weekly-report-after-clarification']
const fixtures = JSON.parse(await readFile(resolve(root, 'fixtures/live/text-tools.json'), 'utf8')).cases
const cases = ids.map(id => {const c = fixtures.find(item => item.id === id); assert.ok(c); return c})
const supportedModels = ['qwen3.8-max', 'qwen-plus', 'qwen-flash', 'qwen3.8-flash', 'deepseek-v4-pro', 'deepseek-flash']
const models = values.models?.split(',') ?? supportedModels.slice(0, 4)
assert.ok(models.length > 0 && models.every(model => supportedModels.includes(model)))
const report = {startedAt: new Date().toISOString(), thinking: false, repeats, models, cases: ids,
  scope: 'Synthetic text through production frontend; no ASR, TTS, coordinator or executor. One concurrent request per selected model; case and repeat order shared.', results: []}
await mkdir(dirname(resolve(values.output)), {recursive: true})
const ms = start => Math.round(performance.now() - start)
function measuredFactory(requests) {
  return options => {
    const factory = createQwenCascadedLlmFactory({...options, fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body)
      if (options.provider === 'deepseek') assert.equal(body.thinking?.type, 'disabled')
      else assert.equal(body.enable_thinking, false)
      const row = {start: performance.now(), firstContentMs: null, firstToolMs: null, firstUsableMs: null,
        reasoningChars: 0, completeMs: null}
      requests.push(row)
      const response = await fetch(url, init)
      row.httpStatus = response.status
      if (!response.body) return response
      const decoder = new TextDecoder()
      let pending = ''
      const stream = response.body.pipeThrough(new TransformStream({transform(chunk, controller) {
        controller.enqueue(chunk)
        pending += decoder.decode(chunk, {stream: true})
        let end
        while ((end = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, end).trim(); pending = pending.slice(end + 1)
          if (!line.startsWith('data:') || line === 'data: [DONE]') continue
          const data = JSON.parse(line.slice(5))
          const delta = data.choices?.[0]?.delta
          if (delta?.content) row.firstContentMs ??= ms(row.start)
          if (delta?.tool_calls?.some(call => call.function?.name || call.function?.arguments)) row.firstToolMs ??= ms(row.start)
          row.reasoningChars += delta?.reasoning_content?.length ?? 0
        }
      }}))
      return new Response(stream, {status: response.status, headers: response.headers})
    }})
    return {open() {
      const session = factory.open()
      return {
        async *stream(input) {
          for await (const event of session.stream(input)) {
            const row = requests.at(-1)
            if (event.kind === 'text_delta' || event.kind === 'tool_call') row.firstUsableMs ??= ms(row.start)
            if (event.kind === 'response_completed') row.completeMs = ms(row.start)
            yield event
          }
        },
        close: () => session.close(),
        abandonPendingResponse: () => session.abandonPendingResponse(),
      }
    }}
  }
}
for (let repeat = 0; repeat < repeats; repeat++) {
  for (const testCase of cases) {
    const results = await Promise.all(models.map(async model => {
      const requests = []
      const config = model.startsWith('deepseek')
        ? {provider: 'deepseek', model, baseUrl: 'https://api.deepseek.com', apiKey: env.DEEPSEEK_API_KEY}
        : configuration(env, 'qwen', model)
      assert.ok(config.apiKey, `missing credential for ${model}`)
      const result = await runTextCase(testCase, config, 90000, measuredFactory(requests))
      const unsafeSteps = result.observations.flatMap((observed, index) => {
        const expected = testCase.steps[index].expect.calls ?? []
        return observed.calls.some(call => ['dispatch', 'confirm', 'cancel'].includes(call.name) && !expected.some(wanted => wanted.name === call.name
          && (call.name !== 'confirm' || wanted.args?.accepted === call.arguments.accepted))) ? [index] : []
      })
      return {model, repeat, id: testCase.id, ...result, unsafeSteps,
        requests: requests.map(({start, ...timing}) => timing)}
    }))
    report.results.push(...results)
    await writeFile(values.output, JSON.stringify(report, null, 2))
    console.log(JSON.stringify({repeat, id: testCase.id, results: results.map(r => ({model: r.model, status: r.status,
      unsafeSteps: r.unsafeSteps, failures: r.failures ?? r.reason}))}))
  }
}
report.completedAt = new Date().toISOString()
await writeFile(values.output, JSON.stringify(report, null, 2))
